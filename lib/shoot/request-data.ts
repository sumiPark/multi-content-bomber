import type { ShootRequestCardData } from "@/components/shoot/shoot-request-card";
import type { Json } from "@/types/database";

// 촬영 · 올리기 목록과 상세가 같이 읽는 값.

export const REQUEST_STATUS: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive" | "ok" }> = {
  OPEN: { label: "촬영 중", variant: "default" },
  UPLOADED: { label: "다 올림 · 편집 대기", variant: "secondary" },
  EDITING: { label: "자동 편집 중", variant: "secondary" },
  EDITED: { label: "편집 완료", variant: "ok" },
  FAILED: { label: "편집 실패", variant: "destructive" },
};

export const REQUEST_SELECT =
  "id, status, cuts, clips, created_at, error, content_plans!inner(id, status, social_account_id, proposal, human_brief, script, check_result, social_accounts(display_name), products(name, url, represent_image_url))";

type Cut = { no: number; seconds: number; shot: string; how: string; on_screen: string; voice: string; done?: boolean; skipped?: boolean };
type Clip = { cut: number; name: string; size: number };
type SavedShotlist = {
  hooks?: { spoken: string; on_screen: string; score?: number | null }[];
  chosen_hook?: number;
  caption?: { text: string };
  fixed?: { hook?: unknown; notes?: string[] };
  human?: { hook?: string | null; thumbnail?: string | null };
  thumbnail?: { title?: string };
};
type Proposal = { ideas?: { title?: string }[]; chosen?: number | null };

export interface RequestRow {
  id: string;
  status: string;
  cuts: Json;
  clips: Json;
  error: string | null;
  content_plans: {
    id: string;
    proposal: Json;
    human_brief: string | null;
    script: Json | null;
    check_result: Json | null;
    social_accounts: { display_name: string | null } | null;
    products: { name: string; url: string; represent_image_url: string | null } | null;
  };
}

export function ideaTitleOf(proposal: Json): string | null {
  const p = (proposal ?? {}) as Proposal;
  return p.ideas?.[p.chosen ?? 0]?.title ?? null;
}

export function toRequestCard(r: RequestRow): ShootRequestCardData {
  const plan = r.content_plans;
  const script = (plan.script ?? {}) as SavedShotlist;
  const hook = script.hooks?.[script.chosen_hook ?? 0];
  return {
    id: r.id,
    status: r.status,
    account: plan.social_accounts?.display_name ?? "",
    ideaTitle: ideaTitleOf(plan.proposal),
    product: plan.products ? { name: plan.products.name, url: plan.products.url, image: plan.products.represent_image_url } : null,
    brief: plan.human_brief,
    hook: hook ? { spoken: hook.spoken, onScreen: hook.on_screen, score: hook.score ?? null } : null,
    planId: plan.id,
    humanHook: script.human?.hook ?? "",
    humanThumbnail: script.human?.thumbnail ?? "",
    thumbnailIdea: script.thumbnail?.title ?? null,
    caption: script.caption?.text ?? "",
    fixedHook: !!script.fixed?.hook,
    fixedNotes: script.fixed?.notes ?? [],
    cuts: ((r.cuts ?? []) as unknown as Cut[]).map((c) => ({
      no: c.no,
      seconds: c.seconds,
      shot: c.shot,
      how: c.how,
      onScreen: c.on_screen,
      voice: c.voice,
      done: !!c.done,
      skipped: !!c.skipped,
    })),
    clips: ((r.clips ?? []) as unknown as Clip[]).map((c) => ({ cut: c.cut, name: c.name, size: c.size })),
    // 찍는 사람이 고칠 수 있는 것만(화면 문구 · 대사) — 캡션 · 말투 점수는 찍을 때 고칠 수 없다
    issues: ((plan.check_result as { issues?: { kind?: string; detail: string }[] } | null)?.issues ?? [])
      .filter((i) => i.kind !== "caption" && i.kind !== "tone" && i.kind !== "hook")
      .map((i) => i.detail),
    error: r.error,
  };
}
