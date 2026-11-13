import { triggerProductAnalysisRun } from "@/lib/github-dispatch";
import type { createServiceClient } from "@/lib/supabase/service";

// 사람이 분석 전 상품을 직접 골랐을 때(직접 촬영 "원하는 상품 추가" · AI 자동 칸 "상품 직접 찾기" · 다른 후보로 바꾸기).
// 상세페이지 분석은 상품 하나에 1~2분이라 서버 액션(Vercel 60초)에서 기다리지 않는다 —
// 분석을 요청(queued)하고 워커를 깨운 뒤, 몇 분 뒤 다시 고르게 안내한다(0057, 2026-11-13).

type Service = ReturnType<typeof createServiceClient>;

export const PENDING_STATES = ["pending", "queued"];

/** 분석이 끝나지 않은 상품을 고르려 할 때 돌려줄 안내. 분석 전이면 분석을 시작한다. */
export async function notReadyMessage(
  service: Service,
  product: { id: string; analysis_state: string },
  reason: string,
): Promise<string> {
  const state = product.analysis_state;
  if (state === "analyzing") return "상세페이지를 분석하는 중이에요. 2~3분 뒤 다시 골라 주세요.";
  if (state === "pending" || state === "queued" || state === "failed") {
    const { error } = await service
      .from("products")
      .update({
        analysis_state: "queued",
        analysis_next_at: new Date().toISOString(),
        // 실패로 멈춘 상품은 사람이 다시 고른 것이니 처음부터 다시 시도한다
        ...(state === "failed" ? { analysis_attempts: 0, analysis_error: null } : {}),
      })
      .eq("id", product.id)
      .eq("analysis_state", state);
    if (error) return `분석을 시작하지 못했어요: ${error.message}`;
    try {
      await triggerProductAnalysisRun(`${reason}:${product.id}`);
    } catch (e) {
      console.error("[products] 분석 트리거 실패:", e);
      return "분석을 요청했지만 바로 시작하지 못했어요. 다음 상품 수집(매일 03시) 때 분석돼요.";
    }
    return "아직 상세페이지를 분석하지 않은 상품이라 지금 분석을 시작했어요. 3~5분 뒤 다시 골라 주세요.";
  }
  if (state === "review") return "상세페이지 분석 결과를 사람이 확인해야 하는 상품이에요. 상품 화면에서 확인한 뒤 골라 주세요.";
  if (state === "insufficient") return "상세페이지 근거가 부족해 쓸 수 없는 상품이에요.";
  return "상세페이지 분석이 끝난 상품만 고를 수 있어요.";
}
