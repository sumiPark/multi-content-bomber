import { NextResponse } from "next/server";
import { pollAutomation, postFirstComment, processEvent } from "@/lib/post-automations/server";
import { createServiceClient } from "@/lib/supabase/service";

// 게시물 댓글 · DM 자동화 (0062) — pg_cron이 1분마다, 할 일이 있을 때만 POST로 부른다.
//   1. 첫 댓글 대기(PENDING) 등록
//   2. 놓친 댓글 찾기 — 5분 넘게 확인 안 한 켜진 게시물 · "이미 달린 댓글에도" 처음 훑기
//   3. 미룬 DM · 답글 다시 보내기 (claim_post_automation_events, SKIP LOCKED)
// 인증은 시리즈 댓글 자동화와 같은 Vault 비밀값(verify_episode_replies_cron_secret).

export const maxDuration = 60;

// 60초 제한 안에서 스스로 끝내는 선. 못 한 일은 다음 주기에.
const BUDGET_MS = 45_000;
const POLL_EVERY_MS = 5 * 60_000;

export async function POST(request: Request) {
  const startedAt = Date.now();
  const deadline = startedAt + BUDGET_MS;
  const header = request.headers.get("authorization") ?? "";
  const secret = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!secret) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const service = createServiceClient();
  const { data: valid, error: verifyError } = await service.rpc("verify_episode_replies_cron_secret", { p_secret: secret });
  if (verifyError) {
    console.error("[post-automations] 비밀값 확인 실패:", verifyError.message);
    return NextResponse.json({ error: verifyError.message }, { status: 500 });
  }
  if (valid !== true) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const out = { firstComments: [] as string[], polled: 0, pollErrors: [] as string[], sent: [] as string[] };

  // 1. 첫 댓글
  const { data: firsts } = await service
    .from("post_automations")
    .select("id")
    .eq("status", "ACTIVE")
    .eq("first_comment_status", "PENDING")
    .not("platform_post_id", "is", null)
    .is("deleted_at", null)
    .limit(10);
  for (const a of firsts ?? []) {
    if (Date.now() > deadline) break;
    out.firstComments.push(await postFirstComment(service, a.id));
  }

  // 2. 놓친 댓글 찾기
  const staleBefore = new Date(Date.now() - POLL_EVERY_MS).toISOString();
  const { data: toPoll } = await service
    .from("post_automations")
    .select("*")
    .eq("status", "ACTIVE")
    .is("deleted_at", null)
    .not("platform_post_id", "is", null)
    .or(`last_polled_at.is.null,last_polled_at.lt.${staleBefore},backfill_done_at.is.null`)
    .order("last_polled_at", { ascending: true, nullsFirst: true })
    .limit(20);
  for (const a of toPoll ?? []) {
    if (Date.now() > deadline) break;
    // backfill_done_at이 비어 있어도 "이미 달린 댓글에도"를 안 골랐고 최근에 확인했으면 건너뛴다
    const recent = a.last_polled_at && a.last_polled_at >= staleBefore;
    const wantsBackfill = (a.config as { period?: { backfill?: boolean } } | null)?.period?.backfill === true && !a.backfill_done_at;
    if (recent && !wantsBackfill) continue;
    try {
      await pollAutomation(service, a);
      out.polled++;
    } catch (err) {
      out.pollErrors.push(`${a.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200));
      // 실패해도 다음 주기에 같은 게시물만 붙잡지 않게 확인 시각은 남긴다
      await service.from("post_automations").update({ last_polled_at: new Date().toISOString() }).eq("id", a.id);
    }
  }

  // 3. 보내기 (새로 찾은 댓글 · 미룬 건 모두 PENDING이라 여기서 한 번에)
  while (Date.now() < deadline) {
    const { data: claimed, error } = await service.rpc("claim_post_automation_events", { p_limit: 10 });
    if (error) {
      console.error("[post-automations] 기록 선점 실패:", error.message);
      break;
    }
    if (!claimed?.length) break;
    for (const ev of claimed) {
      if (Date.now() > deadline) {
        // 못 보낸 건은 잠금을 풀어 다음 주기에
        await service.from("post_automation_events").update({ locked_at: null }).eq("id", ev.id);
        continue;
      }
      try {
        out.sent.push(await processEvent(service, ev.id));
      } catch (err) {
        out.sent.push(`오류: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200));
        await service.from("post_automation_events").update({ locked_at: null }).eq("id", ev.id);
      }
    }
    if (claimed.length < 10) break;
  }

  console.log("[post-automations]", JSON.stringify(out));
  return NextResponse.json(out);
}
