import type { getServerSupabase } from "@/lib/auth";

// 수집 누락 감지 (콘텐츠 자동화 2-6) — 매일 돌아야 할 수집이 빠졌는지 대시보드가 경고한다.
//   상품 수집: 매일 03시(KST) · products.yml — 30시간 넘게 성공이 없으면 경고
//   성과 수집: 매일 04시(KST) · metrics.yml — 어제 날짜 스냅샷이 없으면 경고
// GitHub schedule은 몇 시간씩 밀리기도 해서(CLAUDE.md) 여유를 둔다.
// 아직 한 번도 수집하지 않은 것(설정 전)은 경고하지 않는다 — 누락이 아니라 시작 전이라.

const PRODUCTS_STALE_HOURS = 30;
const KST_OFFSET_MS = 9 * 3600_000;
const DAY_MS = 24 * 3600_000;

type Supabase = Awaited<ReturnType<typeof getServerSupabase>>;

export interface HealthWarning {
  level: "error" | "warn";
  message: string;
  href: string;
}

function kstDate(ms: number): string {
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export async function loadCollectionHealth(supabase: Supabase, now: number): Promise<HealthWarning[]> {
  const warnings: HealthWarning[] = [];

  const [{ data: lastProducts }, { data: lastProductRun }, { data: lastDaily }, { count: igCount }, { count: failedCount }] =
    await Promise.all([
      supabase.from("products").select("last_seen_at").order("last_seen_at", { ascending: false }).limit(1).maybeSingle(),
      supabase
        .from("worker_runs")
        .select("status, finished_at, error")
        .eq("worker", "collect-products")
        .neq("status", "running")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase.from("account_daily").select("day").order("day", { ascending: false }).limit(1).maybeSingle(),
      supabase
        .from("social_accounts")
        .select("id", { count: "exact", head: true })
        .eq("platform", "INSTAGRAM")
        .eq("is_active", true)
        .is("disconnected_at", null),
      supabase
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("analysis_state", "failed")
        .eq("excluded", false),
    ]);

  // 상품 수집 — 마지막으로 상품을 본 시각 기준 (실행 기록이 없던 때의 수집도 포함)
  if (lastProducts?.last_seen_at) {
    const hours = Math.floor((now - Date.parse(lastProducts.last_seen_at)) / 3600_000);
    if (hours >= PRODUCTS_STALE_HOURS) {
      warnings.push({
        level: "error",
        message: `상품 수집이 ${hours}시간째 실행되지 않았어요 — 매일 03시 실행이 빠졌습니다.`,
        href: "/products",
      });
    } else if (lastProductRun?.status === "failed") {
      warnings.push({
        level: "warn",
        message: `마지막 상품 수집이 실패했어요${lastProductRun.error ? `: ${lastProductRun.error.slice(0, 80)}` : ""}`,
        href: "/products",
      });
    }
  }

  // 성과 수집 — 한 번이라도 수집한 뒤에만
  if (lastDaily?.day && (igCount ?? 0) > 0) {
    const yesterday = kstDate(now - DAY_MS);
    if (lastDaily.day < yesterday) {
      const days = Math.round((Date.parse(yesterday) - Date.parse(lastDaily.day)) / DAY_MS);
      warnings.push({
        level: "error",
        message: `인스타 성과 수집이 ${days + 1}일째 빠졌어요 (마지막 ${lastDaily.day}).`,
        href: "/analytics",
      });
    }
  }

  if ((failedCount ?? 0) > 0) {
    warnings.push({
      level: "warn",
      message: `상세페이지 분석에 실패한 상품이 ${failedCount}개 있어요.`,
      href: "/products?state=failed&stock=all",
    });
  }

  return warnings;
}
