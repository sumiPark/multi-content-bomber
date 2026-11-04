import { kstToIso } from "@/lib/automation/time";
import { splitHashtags } from "@/lib/shoot/final-check";
import type { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";

// AI 자동 칸의 완성본을 발행 대기열에 넣는다. 올릴 시각이 지났으면 바로 올라간다(지난 시각으로 넣으면 다음 실행이 집어 간다).
// 발행 직전 판매 상태 · 가격 재확인은 기존 prepublishCheck가 맡는다.

type Service = ReturnType<typeof createServiceClient>;

export interface AutoVideo {
  state?: "making" | "done";
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
  if (contentError || !content) return { ok: false, error: contentError?.message ?? "콘텐츠를 만들지 못했어요." };

  const scheduledFor = kstToIso(plan.slot_date, plan.slot_time);
  const { data: job, error: jobError } = await service
    .from("publish_jobs")
    .insert({ content_id: content.id, social_account_id: plan.social_account_id, post_type: "REELS", scheduled_for: scheduledFor, is_ai_generated: true })
    .select("id")
    .single();
  if (jobError || !job) {
    await service.from("contents").delete().eq("id", content.id);
    return { ok: false, error: jobError?.message ?? "발행 작업을 만들지 못했어요." };
  }
  const { data: moved } = await service
    .from("content_plans")
    .update({ status: "SCHEDULED", content_id: content.id, publish_job_id: job.id, note: null })
    .eq("id", plan.id)
    .eq("status", "RENDERED")
    .select("id");
  if (!moved?.length) {
    // 그사이 사람이 건너뛰었으면 만든 작업을 되돌린다
    await service.from("publish_jobs").delete().eq("id", job.id);
    await service.from("contents").delete().eq("id", content.id);
    return { ok: false, error: "칸의 상태가 바뀌었어요. 새로 고쳐 주세요." };
  }
  return { ok: true, scheduledFor };
}
