import { NextResponse } from "next/server";
import { recheckWatchedTasks } from "@/lib/episode-alerts/recheck";
import { triggerEpisodeAlertRun } from "@/lib/github-dispatch";
import { createServiceClient } from "@/lib/supabase/service";

// 시리즈 댓글 자동화 — 새 댓글 확인 (0020).
// Supabase pg_cron이 5분마다 POST로 부른다(할 일이 있을 때만). 비밀값은 마이그레이션이 Vault에
// 만들어 둔 것으로, pg_cron이 헤더에 싣고 여기서 RPC로 대조한다(Vercel 환경변수 불필요).
// 실제 답글 발송은 하지 않는다 — 1~2분 간격 발송은 60초 제한에 안 맞아서, 보낼 게 생기면
// GitHub 답글 워커만 깨운다.

export const maxDuration = 60;

// 60초 제한 안에서 스스로 끝내는 선. 못 본 작업은 다음 주기에.
const BUDGET_MS = 45_000;

export async function POST(request: Request) {
  const startedAt = Date.now();
  const header = request.headers.get("authorization") ?? "";
  const secret = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

  const service = createServiceClient();
  if (!secret) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { data: valid } = await service.rpc("verify_episode_replies_cron_secret", {
    p_secret: secret,
  });
  if (valid !== true) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const result = await recheckWatchedTasks(service, startedAt + BUDGET_MS);

  if (result.dispatch) {
    try {
      await triggerEpisodeAlertRun(result.newTargets > 0 ? "new-comments" : "overdue");
    } catch (err) {
      console.error("[episode-replies-recheck] dispatch 실패:", err);
    }
  }

  console.log("[episode-replies-recheck]", JSON.stringify(result));
  return NextResponse.json(result);
}
