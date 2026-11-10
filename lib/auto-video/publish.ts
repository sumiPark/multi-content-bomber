import { kstToIso } from "@/lib/automation/time";
import { appendPublishHistory } from "@/lib/publish-history";
import { splitHashtags } from "@/lib/shoot/final-check";
import { warnIfError } from "@/lib/supabase/result";
import type { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";

// AI 자동 칸의 완성본을 발행 대기열에 넣는다. 올릴 시각이 지났으면 바로 올라간다(지난 시각으로 넣으면 다음 실행이 집어 간다).
// 발행 직전 판매 상태 · 가격 재확인은 기존 prepublishCheck가 맡는다.

type Service = ReturnType<typeof createServiceClient>;

export interface AutoVideo {
  state?: "making" | "done";
  // 사람이 다시 만들기를 눌렀다
  remake?: boolean;
  startedAt?: string;
  attempts?: number;
  path?: string;
  thumbnail?: string;
  seconds?: number;
  warnings?: string[];
  sources?: unknown;
  plan?: unknown;
  sounds?: unknown;
  loudness?: number | null;
  madeAt?: string;
}

/** 사람의 승인 또는 자동 발행 설정으로만 부른다. 이미 넘어간 칸은 건드리지 않는다. */
export async function scheduleAutoVideo(service: Service, planId: string, opts: { byUser?: string | null } = {}): Promise<{ ok: true; scheduledFor: string } | { ok: false; error: string }> {
  const { data: plan } = await service
    .from("content_plans")
    .select("id, status, organization_id, social_account_id, slot_date, slot_time, script, video, products(name), social_accounts(platform, disconnected_at)")
    .eq("id", planId)
    .eq("track", "B")
    .maybeSingle();
  if (!plan) return { ok: false, error: "칸을 찾을 수 없어요." };
  if (plan.status !== "RENDERED") return { ok: false, error: "완성된 영상이 있는 칸만 올릴 수 있어요." };
  const video = (plan.video ?? {}) as AutoVideo;
  if (!video.path) return { ok: false, error: "완성본 파일이 없어요." };
  if (plan.social_accounts?.disconnected_at) return { ok: false, error: "연결이 끊긴 계정이에요." };
  if (!plan.slot_date || !plan.slot_time) return { ok: false, error: "올릴 시각이 없는 칸이에요." };

  // 칸을 먼저 옮긴다. 두 곳에서 동시에 승인해도 한쪽만 작업을 만든다(이중 발행 방지)
  const { data: claimed, error: claimError } = await service.from("content_plans").update({ status: "SCHEDULED", note: null }).eq("id", plan.id).eq("status", "RENDERED").select("id");
  if (claimError) return { ok: false, error: `칸을 옮기지 못했어요: ${claimError.message}` };
  if (!claimed?.length) return { ok: false, error: "칸의 상태가 바뀌었어요. 새로 고쳐 주세요." };
  const undo = () => service.from("content_plans").update({ status: "RENDERED" }).eq("id", plan.id).eq("status", "SCHEDULED");

  const script = (plan.script ?? {}) as { caption?: { text?: string } };
  const { caption, hashtags } = splitHashtags(script.caption?.text ?? "");
  const name = plan.products?.name ?? "AI 자동 콘텐츠";
  const { data: content, error: contentError } = await service
    .from("contents")
    .insert({
      organization_id: plan.organization_id,
      created_by: opts.byUser ?? null,
      title: name,
      internal_title: `AI 자동 · ${plan.slot_date} ${plan.slot_time} · ${name}`,
      media_type: "VIDEO",
      media_urls: [video.path],
      ai_captions: { instagram: { caption, hashtags } } as unknown as Json,
      metadata: (video.thumbnail ? { ig_cover_path: video.thumbnail } : {}) as Json,
    })
    .select("id")
    .single();
  if (contentError || !content) {
    warnIfError(await undo(), `칸 상태 되돌리기 (plan=${plan.id})`);
    return { ok: false, error: contentError?.message ?? "콘텐츠를 만들지 못했어요." };
  }

  const scheduledFor = kstToIso(plan.slot_date, plan.slot_time);
  const { data: job, error: jobError } = await service
    .from("publish_jobs")
    .insert({ content_id: content.id, social_account_id: plan.social_account_id, post_type: "REELS", scheduled_for: scheduledFor, is_ai_generated: true })
    .select("id")
    .single();
  if (jobError || !job) {
    warnIfError(await service.from("contents").delete().eq("id", content.id), `발행 작업 실패 뒤 콘텐츠 정리 (content=${content.id})`);
    warnIfError(await undo(), `칸 상태 되돌리기 (plan=${plan.id})`);
    return { ok: false, error: jobError?.message ?? "발행 작업을 만들지 못했어요." };
  }
  // 발행 작업은 이미 대기열에 있다 — 여기서 실패를 돌려주면 다시 승인해 두 번 올라갈 수 있어 기록만 남긴다
  warnIfError(
    await service.from("content_plans").update({ content_id: content.id, publish_job_id: job.id }).eq("id", plan.id),
    `칸에 발행 작업 연결 (plan=${plan.id}, job=${job.id})`,
  );
  return { ok: true, scheduledFor };
}

/**
 * 칸을 건너뛰거나 다시 만들 때 예전 발행 작업을 끊는다. 끊지 않으면 배포 관리의 재시도로 옛 영상이 올라갈 수 있다.
 * 발행 기록은 지우지 않고 취소로 남긴다. 작업이 쓰던 파일은 기록이 쓰므로 지우면 안 된다(hadJob).
 */
export async function releaseOldPublish(service: Service, planId: string): Promise<{ ok: true; hadJob: boolean } | { ok: false; error: string }> {
  const { data: plan } = await service.from("content_plans").select("publish_job_id").eq("id", planId).maybeSingle();
  if (!plan?.publish_job_id) return { ok: true, hadJob: false };
  const { data: job } = await service.from("publish_jobs").select("id, status").eq("id", plan.publish_job_id).maybeSingle();
  if (job?.status === "PROCESSING") return { ok: false, error: "지금 올리는 중이에요. 끝난 뒤 다시 해 주세요." };
  if (job?.status === "SUCCESS") return { ok: false, error: "이미 올라간 칸이에요." };
  if (job && job.status !== "CANCELLED") {
    const { error: cancelError } = await service.from("publish_jobs").update({ status: "CANCELLED", cancelled_at: new Date().toISOString() }).eq("id", job.id).in("status", ["PENDING", "RETRYING", "FAILED"]);
    if (cancelError) return { ok: false, error: `예전 발행 작업을 취소하지 못했어요: ${cancelError.message}` };
    await appendPublishHistory(service, [job.id], { status: "CANCELLED", message: "AI 자동 칸을 건너뛰거나 다시 만들어 취소" });
  }
  const { error: unlinkError } = await service.from("content_plans").update({ publish_job_id: null, content_id: null, video: null }).eq("id", planId);
  if (unlinkError) return { ok: false, error: `칸에서 예전 발행 작업을 떼지 못했어요: ${unlinkError.message}` };
  return { ok: true, hadJob: true };
}
