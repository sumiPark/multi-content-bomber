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
      event_type: PUBLISH_DISPATCH_EVENT,
      client_payload: { reason },
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
