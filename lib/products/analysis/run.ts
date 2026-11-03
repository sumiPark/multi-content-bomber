import type { ProductKind, ShopCode } from "@/lib/products/shops";
import {
  analysisModel,
  extractImagePart,
  groundClaims,
  mergeParts,
  summarizeProduct,
  type GroundedClaim,
  type ImageExtract,
  type ProductSummary,
  type TokenUsage,
} from "./analyze";
import { downloadImage, prepareImage, type ImagePart } from "./images";

// 한 번에 보낸 타일에 글자가 너무 많으면 응답이 길이 한도에 걸린다(LengthFinishReasonError).
// 그때는 타일을 반으로 나눠 다시 읽는다 — 타일 1장까지 내려가도 넘치면 그대로 실패.
async function extractWithSplit(
  part: ImagePart,
  context: { productName: string; imageIndex: number; imageCount: number },
  usage: TokenUsage,
): Promise<ImageExtract[]> {
  try {
    return [await extractImagePart(part, context, usage)];
  } catch (err) {
    const tooLong = err instanceof Error && err.name === "LengthFinishReasonError";
    if (!tooLong || part.tiles.length < 2) throw err;
    const half = Math.ceil(part.tiles.length / 2);
    return [
      ...(await extractWithSplit({ ...part, tiles: part.tiles.slice(0, half) }, context, usage)),
      ...(await extractWithSplit({ ...part, tiles: part.tiles.slice(half) }, context, usage)),
    ];
  }
}

// 상품 하나의 상세페이지 분석 — 워커(DB 저장)와 --dry-run(출력만)이 같이 쓴다.

export interface AnalysisInput {
  shop: ShopCode;
  kind: ProductKind;
  name: string;
  summaryTitle: string | null;
  categoryName: string | null;
  detailImageUrls: string[];
}

export interface StoredExtract extends ImageExtract {
  imageUrl: string;
  imageIndex: number;
  partCount: number;
  width: number | null;
  height: number | null;
}

export type AnalysisState = "ready" | "review" | "insufficient";

export interface AnalysisResult {
  state: AnalysisState;
  reason: string | null;
  extracts: StoredExtract[];
  summary: ProductSummary | null;
  claims: GroundedClaim[];
  rejectedClaims: GroundedClaim[];
  healthFunctional: boolean | null;
  functionalClaims: string[];
  uncertainties: string[];
  model: string;
}

/**
 * @param reuse 이미 분석한 이미지(같은 URL)의 추출 결과 — 있으면 다시 읽지 않는다.
 * @param onExtract 이미지 하나를 새로 읽을 때마다 호출 (워커는 바로 저장해, 중간에 죽어도 다음 run이 이어 간다).
 */
export async function analyzeProduct(
  input: AnalysisInput,
  usage: TokenUsage,
  reuse: Map<string, StoredExtract>,
  onExtract: (e: StoredExtract) => Promise<void>,
): Promise<AnalysisResult> {
  const model = analysisModel();
  const base = {
    extracts: [] as StoredExtract[],
    summary: null,
    claims: [],
    rejectedClaims: [],
    healthFunctional: null,
    functionalClaims: [],
    uncertainties: [],
    model,
  };
  if (input.detailImageUrls.length === 0) {
    return { ...base, state: "insufficient", reason: "상세 이미지가 없음" };
  }

  // 1. 이미지별 추출 (같은 URL은 재사용)
  const extracts: StoredExtract[] = [];
  for (const [i, url] of input.detailImageUrls.entries()) {
    const prev = reuse.get(url);
    if (prev) {
      extracts.push({ ...prev, imageIndex: i });
      continue;
    }
    const prepared = await prepareImage(await downloadImage(url, input.shop));
    const parts: ImageExtract[] = [];
    for (const part of prepared.parts) {
      parts.push(
        ...(await extractWithSplit(
          part,
          { productName: input.name, imageIndex: i, imageCount: input.detailImageUrls.length },
          usage,
        )),
      );
    }
    const merged = mergeParts(parts);
    if (prepared.animated) {
      merged.uncertainties.push("움직이는 이미지(GIF)라 첫 장면만 읽음");
      merged.fullIngredientsVisible = false;
    }
    const stored: StoredExtract = {
      ...merged,
      imageUrl: url,
      imageIndex: i,
      partCount: prepared.parts.length,
      width: prepared.width,
      height: prepared.height,
    };
    await onExtract(stored);
    extracts.push(stored);
  }

  // 2. 상품 요약
  const texts = extracts.map((e) => e.text);
  const summary = await summarizeProduct(
    input.kind,
    input,
    extracts.map((e, i) => ({ id: `image-${i}`, text: e.text, facts: e.facts })),
    usage,
  );

  // 3. 원문 인용 확인 — 특징 · 강조 성분 · 기능성 문구
  const candidates = summary.sellingPoints.map((p) => ({ claim: p.point, imageId: p.imageId, quote: p.quote }));
  if ("keyIngredients" in summary.details) {
    for (const k of summary.details.keyIngredients) {
      candidates.push({ claim: `성분: ${k.name}`, imageId: k.imageId, quote: k.quote });
    }
  }
  const { kept, rejected } = groundClaims(candidates, texts);

  let healthFunctional: boolean | null = null;
  let functionalClaims: string[] = [];
  if (input.kind === "HEALTH_FOOD" && "functionalClaims" in summary.details) {
    healthFunctional = summary.isKindMatch;
    const fc = groundClaims(
      summary.details.functionalClaims.map((c) => ({ claim: c.text, imageId: c.imageId, quote: c.text })),
      texts,
    );
    functionalClaims = fc.kept.map((c) => c.quote);
    rejected.push(...fc.rejected.map((c) => ({ ...c, claim: `기능성: ${c.claim}` })));
  }

  const uncertainties = [
    ...new Set([...summary.uncertainties, ...extracts.flatMap((e) => e.uncertainties)]),
  ].slice(0, 30);

  // 4. 상태 — 근거 있는 특징이 하나도 없으면 쓸 수 없고, 건기식 기능성 문구는 늘 사람이 확정한다.
  const points = kept.filter((c) => !c.claim.startsWith("성분: "));
  let state: AnalysisState;
  let reason: string | null = null;
  if (texts.every((t) => !t.trim())) {
    state = "insufficient";
    reason = "상세 이미지에서 글자를 읽지 못함";
  } else if (points.length === 0) {
    state = "insufficient";
    reason = "원문 근거가 있는 특징이 없음";
  } else if (healthFunctional) {
    state = "review";
    reason = "건강기능식품 — 기능성 문구 확인 필요";
  } else if (!summary.isKindMatch && input.kind !== "HEALTH_FOOD") {
    state = "review";
    reason = "카테고리와 상품 종류가 달라 보임";
  } else if (rejected.length > points.length) {
    state = "review";
    reason = "근거가 확인되지 않은 문장이 많음";
  } else {
    state = "ready";
  }

  return {
    state,
    reason,
    extracts,
    summary,
    claims: kept,
    rejectedClaims: rejected,
    healthFunctional,
    functionalClaims,
    uncertainties,
    model,
  };
}
