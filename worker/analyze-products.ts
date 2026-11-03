// .env.local 로드는 다른 어떤 import보다 먼저 (dev 전용 — GitHub Actions에선 no-op).
import "./load-env";

import { triggerProductsRun } from "@/lib/github-dispatch";
import { analysisModel, emptyUsage, type TokenUsage } from "@/lib/products/analysis/analyze";
import { analyzeProduct, type AnalysisResult, type StoredExtract } from "@/lib/products/analysis/run";
import { fetchProduct } from "@/lib/products/shop-api";
import { SHOP_CODES, type ProductKind, type ShopCode } from "@/lib/products/shops";
import { createServiceClient } from "@/lib/supabase/service";
import type { Database, Json } from "@/types/database";
import { startRunLog } from "./run-log";

// ─────────────────────────────────────────────────────────────────────────────
// 상세페이지 분석 워커 — 수집기가 분석 대기(queued)로 둔 판매 중 상품의 상세 이미지를 읽어
// product_image_extracts · product_analyses에 쌓는다. products.yml에서 수집 다음에 이어 돈다.
//
// 이미지 하나 읽을 때마다 바로 저장해서, run이 시간 예산에 걸리거나 죽어도 다음 run이 읽은
// 이미지는 건너뛰고 이어 간다. 3번 실패한 상품은 failed로 멈춘다(상품 화면에서 다시 시도).
//
// 옵션:
//   --dry-run --shop ru --ids 1100,1098   DB 없이 몰 API에서 바로 받아 분석하고 결과 · 토큰만 출력
//   --limit N                              이번 run에서 분석할 상품 수 상한
// 모델: PRODUCT_ANALYSIS_MODEL (기본 gpt-6.1-terra)
// ─────────────────────────────────────────────────────────────────────────────

// products.yml job timeout(60분) 안에서 스스로 끝낸다. 수집에 쓰는 시간을 빼고.
const RUN_DEADLINE_MS = 45 * 60_000;
const CLAIM_BATCH = 4;
const LOCK_MINUTES = 30;
const MAX_ATTEMPTS = 3;
// 첫 run 실측(2026-11-03, gpt-6.1-terra): 동시 2개로 45분에 76개. 3개로 올린다.
const PRODUCT_CONCURRENCY = 3;

type Service = ReturnType<typeof createServiceClient>;
type ProductRow = Database["public"]["Tables"]["products"]["Row"];

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function printResult(label: string, r: AnalysisResult) {
  console.log(`\n── ${label} → ${r.state}${r.reason ? ` (${r.reason})` : ""}`);
  console.log(`  이미지 ${r.extracts.length}장, 파트 ${r.extracts.reduce((a, e) => a + e.partCount, 0)}개, 원문 ${r.extracts.reduce((a, e) => a + e.text.length, 0)}자`);
  if (r.summary) {
    console.log(`  한 줄: ${r.summary.oneLine}`);
    console.log(`  종류 일치: ${r.summary.isKindMatch}`);
    console.log(`  세부: ${JSON.stringify(r.summary.details)}`);
  }
  for (const c of r.claims) console.log(`  ✓ ${c.claim}  ← "${c.quote}" [image-${c.imageIndex}]`);
  for (const c of r.rejectedClaims) console.log(`  ✗ ${c.claim}  ← "${c.quote}" (원문에 없음)`);
  if (r.functionalClaims.length) console.log(`  기능성 문구 후보: ${r.functionalClaims.join(" | ")}`);
  if (r.uncertainties.length) console.log(`  불확실: ${r.uncertainties.slice(0, 5).join(" | ")}`);
}

function printUsage(u: TokenUsage) {
  console.log(
    `\n[analyze-products] 모델 ${analysisModel()} | 호출 ${u.calls}회 | 입력 ${u.input.toLocaleString()} · 출력 ${u.output.toLocaleString()} 토큰`,
  );
}

async function dryRun(argv: string[]) {
  const shop = arg(argv, "--shop") as ShopCode | undefined;
  const ids = (arg(argv, "--ids") ?? "").split(",").map(Number).filter(Boolean);
  if (!shop || !SHOP_CODES.includes(shop) || ids.length === 0) {
    throw new Error("--dry-run은 --shop <cuma|cm|ru> --ids 1,2,3 이 필요합니다");
  }
  const kind = (arg(argv, "--kind") ?? { cuma: "FRUIT", cm: "HEALTH_FOOD", ru: "COSMETIC" }[shop]) as ProductKind;
  const usage = emptyUsage();
  for (const id of ids) {
    const before = { ...usage };
    const p = await fetchProduct(shop, id);
    const r = await analyzeProduct(
      { shop, kind, name: p.name, summaryTitle: p.summaryTitle, categoryName: p.categoryName, detailImageUrls: p.detailImageUrls },
      usage,
      new Map(),
      async () => {},
    );
    printResult(`${shop} ${id} ${p.name} [${kind}]`, r);
    console.log(`  토큰: 입력 ${(usage.input - before.input).toLocaleString()} · 출력 ${(usage.output - before.output).toLocaleString()} (호출 ${usage.calls - before.calls}회)`);
  }
  printUsage(usage);
}

async function saveResult(service: Service, product: ProductRow, r: AnalysisResult) {
  const { data: prev } = await service
    .from("product_analyses")
    .select("edited")
    .eq("product_id", product.id)
    .maybeSingle();

  // 사람이 고친 요약은 덮어쓰지 않는다 — 상세페이지가 바뀌었으니 다시 보라고만 남긴다.
  if (prev?.edited) {
    await service
      .from("products")
      .update({
        analysis_state: "review",
        analysis_note: "사람이 고친 요약이 있어 새 분석으로 덮어쓰지 않았어요. 상세페이지가 바뀌었는지 확인해 주세요.",
        analysis_error: null,
        analysis_locked_until: null,
      })
      .eq("id", product.id);
    return;
  }

  const { error } = await service.from("product_analyses").upsert({
    product_id: product.id,
    kind: product.kind ?? "OTHER",
    summary: (r.summary ?? {}) as unknown as Json,
    claims: r.claims as unknown as Json,
    rejected_claims: r.rejectedClaims as unknown as Json,
    health_functional: r.healthFunctional,
    functional_claims: r.functionalClaims,
    uncertainties: r.uncertainties,
    model: r.model,
    source_hash: product.source_hash,
    analyzed_at: new Date().toISOString(),
    approved_by: null,
    approved_at: null,
  });
  if (error) throw new Error(`product_analyses 저장 실패: ${error.message}`);

  await service
    .from("products")
    .update({
      analysis_state: r.state,
      analysis_note: r.reason,
      analysis_error: null,
      analysis_locked_until: null,
    })
    .eq("id", product.id);
}

async function analyzeOne(service: Service, product: ProductRow, usage: TokenUsage): Promise<string> {
  try {
    const { data: rows } = await service
      .from("product_image_extracts")
      .select("*")
      .eq("product_id", product.id);
    const reuse = new Map<string, StoredExtract>();
    for (const e of rows ?? []) {
      reuse.set(e.image_url, {
        imageUrl: e.image_url,
        imageIndex: e.image_index,
        text: e.text,
        facts: ((e.data as { facts?: StoredExtract["facts"] })?.facts ?? []),
        ingredients: ((e.data as { ingredients?: string[] })?.ingredients ?? []),
        fullIngredientsVisible: !!(e.data as { fullIngredientsVisible?: boolean })?.fullIngredientsVisible,
        uncertainties: e.uncertainties,
        partCount: e.part_count,
        width: e.width,
        height: e.height,
      });
    }
    // 상세페이지에서 빠진 이미지의 추출 결과는 지운다.
    const stale = [...reuse.keys()].filter((u) => !product.detail_image_urls.includes(u));
    if (stale.length) {
      await service.from("product_image_extracts").delete().eq("product_id", product.id).in("image_url", stale);
    }

    const r = await analyzeProduct(
      {
        shop: product.shop_code as ShopCode,
        kind: (product.kind ?? "OTHER") as ProductKind,
        name: product.name,
        summaryTitle: product.summary_title,
        categoryName: product.category_name,
        detailImageUrls: product.detail_image_urls,
      },
      usage,
      reuse,
      async (e) => {
        const { error } = await service.from("product_image_extracts").upsert({
          product_id: product.id,
          image_url: e.imageUrl,
          image_index: e.imageIndex,
          text: e.text,
          data: { facts: e.facts, ingredients: e.ingredients, fullIngredientsVisible: e.fullIngredientsVisible } as unknown as Json,
          uncertainties: e.uncertainties,
          part_count: e.partCount,
          width: e.width,
          height: e.height,
          model: analysisModel(),
          analyzed_at: new Date().toISOString(),
        });
        if (error) throw new Error(`product_image_extracts 저장 실패: ${error.message}`);
      },
    );
    await saveResult(service, product, r);
    return r.state;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = product.analysis_attempts + 1;
    await service
      .from("products")
      .update({
        analysis_state: attempts >= MAX_ATTEMPTS ? "failed" : "queued",
        analysis_attempts: attempts,
        analysis_next_at: new Date(Date.now() + attempts * 10 * 60_000).toISOString(),
        analysis_error: message.slice(0, 500),
        analysis_locked_until: null,
      })
      .eq("id", product.id);
    console.error(`[analyze-products] ${product.shop_code} ${product.shop_product_id} 실패(${attempts}회): ${message}`);
    return "error";
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--dry-run")) return dryRun(argv);

  const service = createServiceClient();
  const startedAt = Date.now();
  const log = await startRunLog(service, "analyze-products");
  const limit = Number(arg(argv, "--limit") ?? Infinity);
  let fatal: string | null = null;
  const usage = emptyUsage();
  const tally: Record<string, number> = {};
  let done = 0;

  while (Date.now() - startedAt < RUN_DEADLINE_MS && done < limit) {
    const { data, error } = await service.rpc("claim_products_for_analysis", {
      p_limit: Math.min(CLAIM_BATCH, limit - done),
      p_lock_minutes: LOCK_MINUTES,
    });
    if (error) {
      console.error("[analyze-products] claim RPC 실패:", error.message);
      fatal = `claim RPC 실패: ${error.message}`;
      process.exitCode = 1;
      break;
    }
    const batch = (data ?? []) as ProductRow[];
    if (batch.length === 0) break;

    for (let i = 0; i < batch.length; i += PRODUCT_CONCURRENCY) {
      const results = await Promise.all(
        batch.slice(i, i + PRODUCT_CONCURRENCY).map((p) => analyzeOne(service, p, usage)),
      );
      for (const r of results) tally[r] = (tally[r] ?? 0) + 1;
    }
    done += batch.length;
  }

  printUsage(usage);
  const stoppedByDeadline = Date.now() - startedAt >= RUN_DEADLINE_MS;
  // 시간 예산에 걸려 남은 대기분이 있으면 다음 run을 바로 깨운다(concurrency 그룹이라 이 run 뒤에 시작).
  // 다음 run은 수집(1~2분)부터 다시 돌지만 바뀐 게 없으면 분석 대기만 이어 간다.
  // 첫 대량 분석이 하루 1회(03시)씩 며칠에 걸쳐 나뉘지 않게 하려는 것. 실패해도 다음 03시에 이어진다.
  if (stoppedByDeadline && !fatal) {
    try {
      await triggerProductsRun("continue");
      console.log("[analyze-products] 남은 대기분 — 다음 run 예약");
    } catch (err) {
      console.error("[analyze-products] 다음 run dispatch 실패:", err instanceof Error ? err.message : err);
    }
  }
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[analyze-products] 완료 ${done}개 ${JSON.stringify(tally)} | ${elapsed}s`);
  await log.finish(fatal ? "failed" : "success", {
    done,
    tally,
    model: analysisModel(),
    tokens: { input: usage.input, output: usage.output, calls: usage.calls },
    // 시간 예산에 걸려 남은 대기분은 다음 run(다음 날 03시 또는 지금 수집)이 이어 간다.
    stoppedByDeadline,
  }, fatal);
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("[analyze-products] 치명적 오류:", err);
    process.exit(1);
  });
