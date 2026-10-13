import { NextResponse } from "next/server";
import { triggerPublishRun } from "@/lib/github-dispatch";
import { createServiceClient } from "@/lib/supabase/service";

// 예약 발행 깨우기 (0022).
// 예약 발행은 GitHub Actions 30분 예약 실행에만 기대고 있었는데, 실측으로 몇 시간씩 밀려
// (2026-10-13: 5~6시간 간격) 예약 시각이 지나도 "대기"로 남았다. Supabase pg_cron이 1분마다
// 예약 시각이 된 발행 건이 있을 때만 이 주소를 부르고, 여기서 발행 워커를 바로 깨운다.
// GitHub 예약 실행은 백업으로 그대로 둔다.
//
// 인증: 0020이 Vault에 만든 비밀값을 앱 cron 주소들이 같이 쓴다(이름은 episode_replies_…지만
// 용도는 "pg_cron → 앱 호출 인증"). pg_cron이 헤더에 싣고 여기서 RPC로 대조한다.

// pg_cron 조건과 맞춘다 — 워커가 이미 집어간(PROCESSING) 건은 깨우지 않는다.
const STUCK_MS = 2 * 60_000;
const MAX_ATTEMPTS = 3;

export async function POST(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const secret = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!secret) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const service = createServiceClient();
  const { data: valid } = await service.rpc("verify_episode_replies_cron_secret", {
    p_secret: secret,
  });
  if (valid !== true) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // pg_cron 조건을 한 번 더 확인 — 그사이 워커가 이미 집어갔으면 깨우지 않는다.
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const stuckIso = new Date(now - STUCK_MS).toISOString();
  const { count, error } = await service
    .from("publish_jobs")
    .select("id", { count: "exact", head: true })
    .is("deleted_at", null)
    .in("status", ["PENDING", "RETRYING"])
    .lt("attempts", MAX_ATTEMPTS)
    .or(`scheduled_for.lte.${nowIso},and(scheduled_for.is.null,created_at.lte.${stuckIso})`);
  if (error) {
    console.error("[publish-due] 조회 실패:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const due = count ?? 0;
  if (due > 0) {
    try {
      await triggerPublishRun(`scheduled-due:${due}`);
    } catch (err) {
      // 흔한 원인은 GITHUB_DISPATCH_TOKEN 만료 — Vercel 로그에서 "publish-due" 검색.
      console.error("[publish-due] dispatch 실패:", err);
      return NextResponse.json({ due, dispatched: false }, { status: 502 });
    }
  }
  console.log("[publish-due]", JSON.stringify({ due, dispatched: due > 0 }));
  return NextResponse.json({ due, dispatched: due > 0 });
}
