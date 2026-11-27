// 발행이 끝난 뒤 이어서 할 일 — 발행 워커(worker/processors/publish-processor.ts)가 한 곳에서 부른다.
// 게시는 이미 끝났으므로 여기서 무엇이 실패해도 발행 결과(SUCCESS)는 그대로 둔다(던지지 않는다).
//
//   runAfterPublish   발행 성공 — 콘텐츠 생성에서 켜 둔 댓글 · DM 자동화(WAITING)를 시작하고 첫 댓글을 단다
//   runAfterPublishFailed  최종 실패 — 기다리던 자동화를 "발행 실패로 멈춤"으로
//
// 시리즈 회차 기록(recordSeriesEpisode)은 아직 publish-processor 안에 있다. 옮길 때 이 파일로 모은다.
import type { createServiceClient } from "@/lib/supabase/service";
import { parseConfig, postFirstComment } from "@/lib/post-automations/server";

type Service = ReturnType<typeof createServiceClient>;

export interface PublishedContext {
  publishJobId: string;
  socialAccountId: string;
  platformPostId: string;
  platformPostUrl: string;
}

const DAY_MS = 24 * 60 * 60_000;

export async function runAfterPublish(service: Service, ctx: PublishedContext): Promise<void> {
  try {
    await startWaitingAutomations(service, ctx);
  } catch (err) {
    console.error(
      `[post-publish] 댓글 · DM 자동화 시작 실패 — 발행은 완료 (job=${ctx.publishJobId}):`,
      err instanceof Error ? err.message : err,
    );
  }
}

export async function runAfterPublishFailed(service: Service, publishJobId: string): Promise<void> {
  try {
    await service
      .from("post_automations")
      .update({ status: "PAUSED", paused_reason: "PUBLISH_FAILED" })
      .eq("publish_job_id", publishJobId)
      .eq("status", "WAITING");
  } catch (err) {
    console.error(`[post-publish] 자동화 멈춤 기록 실패 (job=${publishJobId}):`, err instanceof Error ? err.message : err);
  }
}

async function startWaitingAutomations(service: Service, ctx: PublishedContext) {
  const { data: rows, error } = await service
    .from("post_automations")
    .select("id, config")
    .eq("publish_job_id", ctx.publishJobId)
    .eq("status", "WAITING")
    .is("deleted_at", null);
  if (error) throw new Error(`자동화 조회 실패: ${error.message}`);
  if (!rows?.length) return;

  for (const row of rows) {
    const cfg = parseConfig(row.config);
    const now = new Date();
    // 같은 게시물에 이미 켜진 설정이 있으면(메뉴에서 먼저 켬) 유니크 인덱스에 걸린다 — 그 설정을 남기고 이건 지운다.
    const { error: upErr } = await service
      .from("post_automations")
      .update({
        status: "ACTIVE",
        paused_reason: null,
        platform_post_id: ctx.platformPostId,
        post_permalink: ctx.platformPostUrl || null,
        post_posted_at: now.toISOString(),
        starts_at: now.toISOString(),
        ends_at: new Date(now.getTime() + cfg.period.days * DAY_MS).toISOString(),
        first_comment_status: cfg.first.on && cfg.first.text.trim() ? "PENDING" : "NONE",
      })
      .eq("id", row.id)
      .eq("status", "WAITING");
    if (upErr) {
      if (upErr.code === "23505") {
        await service.from("post_automations").update({ deleted_at: now.toISOString() }).eq("id", row.id);
        console.warn(`[post-publish] 같은 게시물에 이미 켜진 자동화가 있어 이 설정은 지움 (automation=${row.id})`);
        continue;
      }
      throw new Error(`자동화 시작 실패: ${upErr.message}`);
    }
    // 첫 댓글은 바로 단다. 실패하면 FAILED로 남고 화면에서 다시 시도한다.
    const r = await postFirstComment(service, row.id);
    console.log(`[post-publish] 댓글 · DM 자동화 시작 (automation=${row.id}) → ${r}`);
  }
}
