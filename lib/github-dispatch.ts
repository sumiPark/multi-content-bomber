// 즉시 발행 트리거 — GitHub repository_dispatch로 publish 워크플로를 그 자리에서 깨운다.
//
// BullMQ enqueue를 대체한다. 사용자가 "즉시 업로드"를 누르면 서버 액션이 이 함수를
// 호출해 GitHub Actions를 즉시 1회 실행시킨다(= worker/process-due.ts 실행). cron의
// 5~30분 지연 룰은 schedule에만 적용되고 repository_dispatch에는 걸리지 않는다.
//
// 예약 발행은 이 트리거를 쓰지 않는다 — 30분 cron sweep이 scheduled_for를 보고 처리.
//
// 토큰(GITHUB_DISPATCH_TOKEN)을 쓰므로 서버 전용. 클라이언트 번들에 들어가면 안 된다.

const GITHUB_API = "https://api.github.com";

// repository_dispatch의 event_type — 워크플로 on.repository_dispatch.types와 일치해야 함.
export const PUBLISH_DISPATCH_EVENT = "publish-now";
// 시리즈 댓글 자동화 워크플로(.github/workflows/episode-alerts.yml).
export const EPISODE_ALERTS_DISPATCH_EVENT = "episode-alerts";
// 성과 수집 워크플로(.github/workflows/metrics.yml).
export const METRICS_DISPATCH_EVENT = "collect-metrics";
// 상품 수집 · 상세 이미지 분석 워크플로(.github/workflows/products.yml).
export const PRODUCTS_DISPATCH_EVENT = "collect-products";
// 직접 촬영 콘텐츠 워크플로(.github/workflows/a-plan.yml) — 기획안 후보 · 컷 리스트.
// AI 자동 업로드 — 상품 제안(빈 칸만) + 확인된 칸 대본 쓰기(b-plan.yml)
export const AUTO_PLAN_DISPATCH_EVENT = "plan-b";
export const SHOOT_PLAN_DISPATCH_EVENT = "plan-a";
export const SHOTLIST_DISPATCH_EVENT = "a-shotlist";
// 직접 촬영 편집 워크플로(.github/workflows/shoot-edit.yml).
export const SHOOT_EDIT_DISPATCH_EVENT = "shoot-edit";
// 계정 점검 — 프로필 점수 워크플로(.github/workflows/profile-review.yml).
export const PROFILE_REVIEW_DISPATCH_EVENT = "profile-review";

/**
 * publish 워크플로를 즉시 실행시킨다.
 *
 * 환경변수:
 *   - GITHUB_DISPATCH_TOKEN : repo 범위(contents:write 또는 fine-grained "Contents")
 *     PAT 또는 GitHub App 토큰. dispatch 권한 필요.
 *   - GITHUB_REPO           : "owner/name" 형식.
 *
 * 실패해도 호출측에서 치명적으로 다루지 않는다 — DB에 PENDING으로 남은 job은
 * 다음 cron sweep(≤30분)이 어차피 집어가므로, 트리거 실패는 "즉시성만 손해".
 */
export async function triggerPublishRun(reason: string): Promise<void> {
  await dispatch(PUBLISH_DISPATCH_EVENT, reason);
}

/**
 * 시리즈 댓글 자동화 워크플로를 즉시 실행시킨다 — 사용자가 "보내기"를 누른 직후, 또는 워커가
 * 시간 예산에 걸려 남은 답글을 다음 run에 넘길 때. 발행 워크플로와 concurrency 그룹이
 * 달라서 긴 답글 발송이 즉시 발행을 막지 않는다.
 *
 * 워커(GitHub Actions)에서는 GITHUB_DISPATCH_TOKEN에 기본 GITHUB_TOKEN을 넣는다 —
 * repository_dispatch는 GITHUB_TOKEN으로 만든 이벤트도 새 run을 띄우는 예외 이벤트다.
 */
export async function triggerEpisodeAlertRun(reason: string): Promise<void> {
  await dispatch(EPISODE_ALERTS_DISPATCH_EVENT, reason);
}

/**
 * 성과 수집 워크플로를 즉시 실행시킨다 — 분석 화면의 "지금 수집" 버튼.
 * 평소엔 매일 04시(KST) schedule이 돈다.
 */
export async function triggerMetricsRun(reason: string): Promise<void> {
  await dispatch(METRICS_DISPATCH_EVENT, reason);
}

/**
 * 상품 수집(+ 이어서 상세 이미지 분석) 워크플로를 즉시 실행시킨다 — 상품 화면의 "지금 수집".
 * 평소엔 매일 03시(KST) schedule이 돈다.
 */
export async function triggerProductsRun(reason: string): Promise<void> {
  await dispatch(PRODUCTS_DISPATCH_EVENT, reason);
}

/**
 * 직접 촬영 기획안 후보 만들기 — "다시 만들기"로 칸 제안을 지운 뒤. date가 있으면 그 날짜 칸을 채운다.
 * 평소엔 매일 05시(KST) schedule이 내일 칸을 채운다.
 */
export async function triggerShootPlanRun(reason: string, date?: string): Promise<void> {
  await dispatch(SHOOT_PLAN_DISPATCH_EVENT, reason, date ? { date } : {});
}

/** 직접 촬영 컷 리스트 쓰기 — 사람이 기획을 고르거나 상품을 직접 지정한 직후(사람이 촬영을 기다린다). */
export async function triggerShotlistRun(reason: string): Promise<void> {
  await dispatch(SHOTLIST_DISPATCH_EVENT, reason);
}

/** 직접 촬영 편집 — "다 올렸어요" · "고친 문구로 다시 편집" 직후. 편집은 FFmpeg라 Actions에서만. */
/** AI 자동 업로드 대본 다시 쓰기 — 점검에 걸린 칸을 사람이 고쳐 다시 확인했을 때. */
export async function triggerAutoScriptRun(reason: string): Promise<void> {
  await dispatch(AUTO_PLAN_DISPATCH_EVENT, reason);
}

export async function triggerShootEditRun(reason: string): Promise<void> {
  await dispatch(SHOOT_EDIT_DISPATCH_EVENT, reason);
}

/** 프로필 자동 채점 — 분석 화면에서 프로필 캡처를 저장한 직후(그 계정만). 평소엔 매일 04:30 schedule. */
export async function triggerProfileReviewRun(reason: string, accountId?: string): Promise<void> {
  await dispatch(PROFILE_REVIEW_DISPATCH_EVENT, reason, accountId ? { account: accountId } : {});
}

/** 다른 계정 비교 — 비교 계정을 추가한 직후. 평소엔 매일 04:50 schedule. */
export async function triggerBenchmarkRun(reason: string): Promise<void> {
  await dispatch("benchmark-collect", reason);
}

async function dispatch(eventType: string, reason: string, extra: Record<string, string> = {}): Promise<void> {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) {
    throw new Error(
      "GITHUB_DISPATCH_TOKEN / GITHUB_REPO 환경변수가 없습니다.",
    );
  }

  const res = await fetch(`${GITHUB_API}/repos/${repo}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: eventType,
      client_payload: { reason, ...extra },
    }),
  });

  // 성공 시 204 No Content.
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `GitHub dispatch 실패 (${res.status}): ${text.slice(0, 200)}`,
    );
  }
}
