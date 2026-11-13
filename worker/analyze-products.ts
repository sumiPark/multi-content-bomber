// .env.local 로드는 다른 어떤 import보다 먼저 (dev 전용 — GitHub Actions에선 no-op).
import "./load-env";

import { triggerProductsRun } from "@/lib/github-dispatch";
import { analysisModel, emptyUsage, type TokenUsage } from "@/lib/products/analysis/analyze";
import { analyzeProduct, type AnalysisResult } from "@/lib/products/analysis/run";
import { ANALYSIS_LOCK_MINUTES, QuotaExhaustedError, analyzeClaimedProduct } from "@/lib/products/analysis/store";
import { fetchProduct } from "@/lib/products/shop-api";
import { SHOP_CODES, type ProductKind, type ShopCode } from "@/lib/products/shops";
import { warnIfError } from "@/lib/supabase/result";
import { createServiceClient } from "@/lib/supabase/service";
import type { Database } from "@/types/database";
import { startRunLog } from "./run-log";

// ─────────────────────────────────────────────────────────────────────────────
// 상세페이지 분석 워커 — 분석 요청(queued)된 판매 중 상품의 상세 이미지를 읽어
// product_image_extracts · product_analyses에 쌓는다. products.yml에서 수집 다음에 이어 돈다.
// 수집은 새 상품을 분석 전(pending)으로만 둔다(0057). queued는 "다시 분석" · 사람이 직접 고른 분석 전 상품뿐이다.
// 분석 코드는 lib/products/analysis/store.ts (AI 상품 고르기가 그 자리에서 분석할 때도 같이 쓴다).
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
// 첫 run 실측(2026-11-03, gpt-6.1-terra): 동시 2개로 45분에 76개. 3개로 올린다.
const PRODUCT_CONCURRENCY = 3;

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
      p_lock_minutes: ANALYSIS_LOCK_MINUTES,
    });
    if (error) {
      console.error("[analyze-products] claim RPC 실패:", error.message);
      fatal = `claim RPC 실패: ${error.message}`;
      process.exitCode = 1;
      break;
    }
    const batch = (data ?? []) as ProductRow[];
    if (batch.length === 0) break;

    try {
      for (let i = 0; i < batch.length; i += PRODUCT_CONCURRENCY) {
        const results = await Promise.all(
          batch.slice(i, i + PRODUCT_CONCURRENCY).map((p) => analyzeClaimedProduct(service, p, usage)),
        );
        for (const r of results) tally[r] = (tally[r] ?? 0) + 1;
      }
    } catch (err) {
      if (!(err instanceof QuotaExhaustedError)) throw err;
      fatal = err.message;
      console.error(`[analyze-products] ${err.message}`);
      // 같은 묶음에서 아직 잡혀 있는 상품은 잠금을 풀어 대기로 돌린다.
      warnIfError(
        await service
          .from("products")
          .update({ analysis_state: "queued", analysis_locked_until: null })
          .in("id", batch.map((p) => p.id))
          .eq("analysis_state", "analyzing"),
        "묶음 잠금 풀기",
      );
      process.exitCode = 1;
      break;
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
