"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentProfile, getSessionUser } from "@/lib/auth";
import { triggerKnowledgeDraftRun } from "@/lib/github-dispatch";
import { createServiceClient } from "@/lib/supabase/service";

// 상식 카드 · 우리 차이 (0051). AI는 초안만 만들고, 관리자 · 매니저가 승인 · 확정한 것만 영상에 들어간다.

export type KnowledgeResult = { ok: true } | { ok: false; error: string };

const PATH = "/auto/knowledge";

async function authorize(): Promise<{ ok: true; userId: string; orgId: string } | { ok: false; error: string }> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "로그인이 필요합니다." };
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) return { ok: false, error: "소속된 조직이 없습니다." };
  if (profile.role !== "ADMIN" && profile.role !== "MANAGER") return { ok: false, error: "관리자 · 매니저만 바꿀 수 있어요." };
  return { ok: true, userId: user.id, orgId: profile.organization_id };
}

const cardSchema = z.object({
  id: z.string().uuid().optional(),
  productKind: z.enum(["FRUIT", "COSMETIC", "HEALTH_FOOD", "CLOTHING", "ALL"]),
  topic: z.string().trim().min(1, "주제를 입력해 주세요.").max(60, "주제는 60자까지 쓸 수 있어요."),
  terms: z.array(z.string().trim().min(1)).max(12),
  statement: z.string().trim().min(1, "영상에서 말할 문장을 입력해 주세요.").max(400, "문장은 400자까지 쓸 수 있어요."),
  sourceTitle: z.string().trim().min(1, "출처 이름을 입력해 주세요.").max(200),
  sourceUrl: z.string().trim().url("출처 주소를 확인해 주세요.").regex(/^https?:\/\//, "출처 주소를 확인해 주세요."),
  sourceQuote: z.string().trim().min(1, "출처의 문구를 옮겨 주세요.").max(500, "인용은 500자까지 쓸 수 있어요."),
});

/** 사람이 고치거나 새로 쓴 카드는 내용을 확인한 것이므로 바로 승인한다. */
export async function saveCardAction(input: z.input<typeof cardSchema>): Promise<KnowledgeResult> {
  const auth = await authorize();
  if (!auth.ok) return auth;
  const parsed = cardSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "입력을 확인해 주세요." };
  const v = parsed.data;
  const now = new Date().toISOString();
  const row = {
    product_kind: v.productKind,
    topic: v.topic,
    terms: v.terms,
    statement: v.statement,
    source_title: v.sourceTitle,
    source_url: v.sourceUrl,
    source_quote: v.sourceQuote,
    status: "APPROVED",
    reviewed_by: auth.userId,
    reviewed_at: now,
    updated_at: now,
  };
  const service = createServiceClient();
  const { error } = v.id
    ? await service.from("knowledge_cards").update(row).eq("id", v.id).eq("organization_id", auth.orgId)
    : await service.from("knowledge_cards").insert({ ...row, organization_id: auth.orgId, origin: "HUMAN" });
  if (error) return { ok: false, error: error.code === "23505" ? "같은 주제에 같은 문장이 이미 있어요." : "저장하지 못했어요. 다시 시도해 주세요." };
  revalidatePath(PATH);
  return { ok: true };
}

export async function reviewCardAction(id: string, status: "APPROVED" | "REJECTED" | "DRAFT"): Promise<KnowledgeResult> {
  const auth = await authorize();
  if (!auth.ok) return auth;
  const now = new Date().toISOString();
  const { error } = await createServiceClient()
    .from("knowledge_cards")
    .update({ status, reviewed_by: auth.userId, reviewed_at: now, updated_at: now })
    .eq("id", id)
    .eq("organization_id", auth.orgId);
  if (error) return { ok: false, error: "상태를 바꾸지 못했어요. 다시 시도해 주세요." };
  revalidatePath(PATH);
  return { ok: true };
}

const differenceSchema = z.object({
  id: z.string().uuid().optional(),
  productId: z.string().uuid(),
  difference: z.string().trim().min(1, "차이를 입력해 주세요.").max(200, "차이는 200자까지 쓸 수 있어요."),
  compareTo: z.string().trim().min(1, "무엇과 비교한 차이인지 입력해 주세요.").max(200),
  evidence: z.string().trim().min(1, "근거를 입력해 주세요.").max(400, "근거는 400자까지 쓸 수 있어요."),
});

export async function saveDifferenceAction(input: z.input<typeof differenceSchema>): Promise<KnowledgeResult> {
  const auth = await authorize();
  if (!auth.ok) return auth;
  const parsed = differenceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "입력을 확인해 주세요." };
  const v = parsed.data;
  const now = new Date().toISOString();
  const row = { difference: v.difference, compare_to: v.compareTo, evidence: v.evidence, status: "CONFIRMED", reviewed_by: auth.userId, reviewed_at: now, updated_at: now };
  const service = createServiceClient();
  const { error } = v.id
    ? await service.from("product_differences").update(row).eq("id", v.id).eq("organization_id", auth.orgId)
    : await service.from("product_differences").insert({ ...row, organization_id: auth.orgId, product_id: v.productId, origin: "HUMAN" });
  if (error) return { ok: false, error: error.code === "23505" ? "같은 차이가 이미 있어요." : "저장하지 못했어요. 다시 시도해 주세요." };
  revalidatePath(PATH);
  return { ok: true };
}

export async function reviewDifferenceAction(id: string, status: "CONFIRMED" | "REJECTED" | "DRAFT"): Promise<KnowledgeResult> {
  const auth = await authorize();
  if (!auth.ok) return auth;
  const now = new Date().toISOString();
  const { error } = await createServiceClient()
    .from("product_differences")
    .update({ status, reviewed_by: auth.userId, reviewed_at: now, updated_at: now })
    .eq("id", id)
    .eq("organization_id", auth.orgId);
  if (error) return { ok: false, error: "상태를 바꾸지 못했어요. 다시 시도해 주세요." };
  revalidatePath(PATH);
  return { ok: true };
}

export async function requestDraftAction(productId: string): Promise<KnowledgeResult> {
  const auth = await authorize();
  if (!auth.ok) return auth;
  if (!z.string().uuid().safeParse(productId).success) return { ok: false, error: "상품을 다시 골라 주세요." };
  try {
    await triggerKnowledgeDraftRun(`화면에서 초안 요청 ${auth.userId}`, productId);
  } catch {
    return { ok: false, error: "초안 만들기를 시작하지 못했어요. 잠시 후 다시 시도해 주세요." };
  }
  return { ok: true };
}
