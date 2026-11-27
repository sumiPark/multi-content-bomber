"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { decryptToken } from "@/lib/crypto";
import { InstagramApiError, listInstagramMedia } from "@/lib/platforms/instagram-comments";
import { subscribeAccountWebhooks } from "@/lib/platforms/instagram-messages";
import {
  configSchema,
  normalizeForPlatform,
  validateConfig,
  type AutomationConfig,
  type AutomationPlatform,
  type ConfigErrors,
} from "@/lib/post-automations/config";
import {
  loadProduct,
  parseConfig,
  postFirstComment,
  processEvent,
  syncButtonLinks,
  type AutomationRow,
} from "@/lib/post-automations/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

// 게시물 댓글 · DM 자동화 서버 액션 (0062). 테이블은 authenticated에 쓰기 정책이 없어 쓰기는 service_role로 하고,
// 권한(ADMIN/MANAGER)과 조직 범위는 여기서 직접 확인한다.

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; fieldErrors?: ConfigErrors };

type Service = ReturnType<typeof createServiceClient>;
const DAY_MS = 24 * 60 * 60_000;
const PATH = "/post-automations";

interface Auth {
  userId: string;
  organizationId: string;
}

async function authorize(): Promise<Auth | { error: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "로그인이 필요해요." };
  const { data: profile } = await supabase.from("profiles").select("organization_id, role").eq("id", user.id).maybeSingle();
  if (!profile?.organization_id) return { error: "소속된 조직이 없어요." };
  if (profile.role !== "ADMIN" && profile.role !== "MANAGER") {
    return { error: "댓글 · DM 자동화 설정은 관리자 · 매니저만 바꿀 수 있어요." };
  }
  return { userId: user.id, organizationId: profile.organization_id };
}

function toMessage(err: unknown): string {
  if (err instanceof InstagramApiError) {
    if (err.kind === "TOKEN") return "계정 토큰이 만료됐어요. 계정 연동에서 다시 연결해 주세요.";
    if (err.kind === "RATE_LIMIT") return "인스타 호출 한도를 넘었어요. 잠시 뒤 다시 시도해 주세요.";
    if (err.kind === "NOT_FOUND") return "인스타 게시물을 찾을 수 없어요. 지워졌는지 확인해 주세요.";
    return `인스타 오류: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

async function loadOwnAccount(service: Service, auth: Auth, socialAccountId: string) {
  const { data } = await service
    .from("social_accounts")
    .select("id, organization_id, platform, platform_account_id, display_name, is_active, disconnected_at, access_token_encrypted")
    .eq("id", socialAccountId)
    .maybeSingle();
  if (!data || data.organization_id !== auth.organizationId) return null;
  return data;
}

async function loadOwnAutomation(service: Service, auth: Auth, id: string): Promise<AutomationRow | null> {
  const { data } = await service.from("post_automations").select("*").eq("id", id).maybeSingle();
  if (!data || data.organization_id !== auth.organizationId || data.deleted_at) return null;
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// 게시물 고르기 — 계정의 최근 게시물 (인스타 조회)

export interface RecentPost {
  id: string;
  caption: string | null;
  permalink: string | null;
  previewUrl: string | null;
  timestamp: string;
  commentsCount: number | null;
  mediaType: string;
  /** 이미 켜진(지우지 않은) 설정 — 고르면 수정으로 연다 */
  automationId: string | null;
  /** MCB에서 올린 게시물이면 연결된 상품 (미리 골라 둔다) */
  productId: string | null;
}

export async function listRecentPosts(socialAccountId: string): Promise<ActionResult<{ posts: RecentPost[] }>> {
  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };
  const service = createServiceClient();
  const account = await loadOwnAccount(service, auth, socialAccountId);
  if (!account) return { ok: false, error: "계정을 찾을 수 없어요." };
  if (account.platform !== "INSTAGRAM") return { ok: false, error: "지금은 인스타그램 계정만 켤 수 있어요." };
  if (account.disconnected_at || !account.is_active || !account.access_token_encrypted) {
    return { ok: false, error: "계정 연결이 끊겼어요. 계정 연동에서 다시 연결해 주세요." };
  }
  try {
    const token = decryptToken(account.access_token_encrypted);
    const { items } = await listInstagramMedia(token, { limit: 30 });
    const ids = items.map((m) => m.id);
    const [{ data: autos }, { data: jobs }] = await Promise.all([
      service.from("post_automations").select("id, platform_post_id").eq("social_account_id", account.id).is("deleted_at", null).in("platform_post_id", ids),
      service.from("publish_jobs").select("platform_post_id, content_id").eq("social_account_id", account.id).in("platform_post_id", ids),
    ]);
    const contentIds = [...new Set((jobs ?? []).map((j) => j.content_id).filter((x): x is string => !!x))];
    const productByContent = new Map<string, string>();
    if (contentIds.length) {
      const { data: plans } = await service.from("content_plans").select("content_id, product_id").in("content_id", contentIds);
      for (const p of plans ?? []) if (p.content_id && p.product_id) productByContent.set(p.content_id, p.product_id);
    }
    const autoByPost = new Map((autos ?? []).map((a) => [a.platform_post_id, a.id]));
    const contentByPost = new Map((jobs ?? []).map((j) => [j.platform_post_id, j.content_id]));
    return {
      ok: true,
      posts: items.map((m) => {
        const contentId = contentByPost.get(m.id) ?? null;
        return {
          id: m.id,
          caption: m.caption,
          permalink: m.permalink,
          previewUrl: m.previewUrl,
          timestamp: m.timestamp,
          commentsCount: m.commentsCount,
          mediaType: m.mediaType,
          automationId: autoByPost.get(m.id) ?? null,
          productId: contentId ? (productByContent.get(contentId) ?? null) : null,
        };
      }),
    };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 상품 찾기 (설정 창의 상품 칸)

export interface ProductOption {
  id: string;
  name: string;
  url: string;
  soldOut: boolean;
  image: string | null;
}

export async function searchProductsForAutomation(query: string): Promise<ActionResult<{ products: ProductOption[] }>> {
  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };
  const q = query.trim().replace(/[%_,()]/g, " ").trim();
  if (q.length < 1) return { ok: true, products: [] };
  const service = createServiceClient();
  const { data, error } = await service
    .from("products")
    .select("id, name, url, stock_status, represent_image_url")
    .eq("excluded", false)
    .ilike("name", `%${q}%`)
    .order("last_seen_at", { ascending: false })
    .limit(20);
  if (error) return { ok: false, error: error.message };
  return {
    ok: true,
    products: (data ?? []).map((p) => ({ id: p.id, name: p.name, url: p.url, soldOut: p.stock_status !== "available", image: p.represent_image_url })),
  };
}

// 게시물 고르기에서 MCB로 올린 게시물이면 연결된 상품을 미리 골라 둔다 — id로 읽기 (화면 추가분)
export async function getProductsForAutomation(ids: string[]): Promise<ActionResult<{ products: ProductOption[] }>> {
  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };
  const list = [...new Set(ids)].filter((id) => z.string().uuid().safeParse(id).success).slice(0, 50);
  if (!list.length) return { ok: true, products: [] };
  const service = createServiceClient();
  const { data, error } = await service.from("products").select("id, name, url, stock_status, represent_image_url").in("id", list);
  if (error) return { ok: false, error: error.message };
  return {
    ok: true,
    products: (data ?? []).map((p) => ({ id: p.id, name: p.name, url: p.url, soldOut: p.stock_status !== "available", image: p.represent_image_url })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 저장 (켜기 · 수정)

const saveSchema = z.object({
  id: z.string().uuid().nullable(),
  socialAccountId: z.string().uuid(),
  platformPostId: z.string().min(1).nullable(),
  postPermalink: z.string().nullable(),
  postCaption: z.string().nullable(),
  postPostedAt: z.string().nullable(),
  productId: z.string().uuid().nullable(),
  source: z.enum(["MENU", "WIZARD", "SHOOT"]),
  publishJobId: z.string().uuid().nullable(),
  contentId: z.string().uuid().nullable(),
  config: configSchema,
});
export type SaveAutomationInput = z.infer<typeof saveSchema>;

export async function saveAutomation(input: SaveAutomationInput): Promise<ActionResult<{ id: string; firstComment: string | null }>> {
  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "설정 형식이 맞지 않아요. 창을 닫고 다시 열어 주세요." };
  const v = parsed.data;
  const service = createServiceClient();

  const account = await loadOwnAccount(service, auth, v.socialAccountId);
  if (!account) return { ok: false, error: "계정을 찾을 수 없어요." };
  const platform = account.platform as AutomationPlatform;
  if (platform !== "INSTAGRAM") return { ok: false, error: "지금은 인스타그램 계정만 켤 수 있어요." };
  if (!v.platformPostId && !v.publishJobId) return { ok: false, error: "게시물을 골라 주세요." };

  const config: AutomationConfig = normalizeForPlatform(v.config, platform);
  const product = await loadProduct(service, v.productId);
  if (v.productId && !product) return { ok: false, error: "상품을 찾을 수 없어요. 다시 골라 주세요." };
  const fieldErrors = validateConfig(config, { platform, product });
  if (Object.keys(fieldErrors).length) {
    return { ok: false, error: Object.values(fieldErrors)[0] ?? "설정을 확인해 주세요.", fieldErrors };
  }

  const now = new Date();
  let row: AutomationRow;
  if (v.id) {
    const existing = await loadOwnAutomation(service, auth, v.id);
    if (!existing) return { ok: false, error: "설정을 찾을 수 없어요." };
    const start = existing.starts_at ? new Date(existing.starts_at) : now;
    const firstPending = existing.first_comment_status === "NONE" && config.first.on && !!config.first.text.trim() && !!existing.platform_post_id;
    const { data, error } = await service
      .from("post_automations")
      .update({
        config: config as unknown as AutomationRow["config"],
        product_id: v.productId,
        ends_at: existing.status === "WAITING" ? null : new Date(start.getTime() + config.period.days * DAY_MS).toISOString(),
        // 기간을 늘려 끝난 설정이 다시 살아나면 진행 중으로
        ...(existing.status === "ENDED" && start.getTime() + config.period.days * DAY_MS > Date.now() ? { status: "ACTIVE", paused_reason: null } : {}),
        // 품절로 멈췄는데 안내 문구를 넣었거나 상품을 바꿨으면 다시 진행
        ...(existing.status === "PAUSED" && existing.paused_reason === "SOLDOUT" && (!product?.soldOut || config.dm.soldout.trim())
          ? { status: "ACTIVE", paused_reason: null }
          : {}),
        ...(firstPending ? { first_comment_status: "PENDING" } : {}),
        // "이미 달린 댓글에도"를 새로 켰으면 다시 훑는다
        ...(config.period.backfill && !parseConfig(existing.config).period.backfill ? { backfill_done_at: null } : {}),
      })
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) return { ok: false, error: `저장하지 못했어요: ${error.message}` };
    row = data;
  } else {
    const waiting = !v.platformPostId;
    const { data, error } = await service
      .from("post_automations")
      .insert({
        organization_id: auth.organizationId,
        social_account_id: account.id,
        platform,
        platform_post_id: v.platformPostId,
        post_permalink: v.postPermalink,
        post_caption: v.postCaption?.slice(0, 500) ?? null,
        post_posted_at: v.postPostedAt,
        publish_job_id: v.publishJobId,
        content_id: v.contentId,
        product_id: v.productId,
        source: v.source,
        config: config as unknown as AutomationRow["config"],
        status: waiting ? "WAITING" : "ACTIVE",
        starts_at: waiting ? null : now.toISOString(),
        ends_at: waiting ? null : new Date(now.getTime() + config.period.days * DAY_MS).toISOString(),
        first_comment_status: !waiting && config.first.on && config.first.text.trim() ? "PENDING" : "NONE",
        created_by: auth.userId,
      })
      .select("*")
      .single();
    if (error) {
      if (error.code === "23505") return { ok: false, error: "이 게시물에는 이미 켜진 설정이 있어요. 목록에서 수정해 주세요." };
      return { ok: false, error: `저장하지 못했어요: ${error.message}` };
    }
    row = data;
  }

  try {
    await syncButtonLinks(service, row, config, product);
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }

  // 첫 댓글은 바로 단다(켤 때). 실패해도 설정은 저장된 상태 — 화면에서 다시 시도.
  let firstComment: string | null = null;
  if (row.first_comment_status === "PENDING") firstComment = await postFirstComment(service, row.id);

  // 계정 웹훅 구독(계정마다 한 번이면 되지만, 이미 돼 있어도 성공한다) — 응답 뒤에
  if (account.access_token_encrypted) {
    const enc = account.access_token_encrypted;
    after(async () => {
      try {
        await subscribeAccountWebhooks(decryptToken(enc));
      } catch (err) {
        console.warn("[post-automations] 웹훅 구독 실패:", toMessage(err));
      }
    });
  }

  revalidatePath(PATH);
  return { ok: true, id: row.id, firstComment };
}

// ─────────────────────────────────────────────────────────────────────────────
// 켜기 · 끄기 · 지우기

export async function setAutomationActive(id: string, on: boolean): Promise<ActionResult> {
  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };
  const service = createServiceClient();
  const a = await loadOwnAutomation(service, auth, id);
  if (!a) return { ok: false, error: "설정을 찾을 수 없어요." };
  if (a.status === "ENDED") return { ok: false, error: "기간이 끝난 설정이에요. 설정에서 기간을 늘려 주세요." };
  if (a.status === "WAITING") return { ok: false, error: "발행을 기다리는 설정이에요. 발행되면 시작해요." };

  if (on) {
    if (a.ends_at && new Date(a.ends_at).getTime() <= Date.now()) {
      return { ok: false, error: "기간이 끝났어요. 설정에서 기간을 늘려 주세요." };
    }
    const cfg = parseConfig(a.config);
    const product = await loadProduct(service, a.product_id);
    if (cfg.dm.on && product?.soldOut && !cfg.dm.soldout.trim()) {
      return { ok: false, error: "상품이 품절이라 켤 수 없어요. 품절 안내 문구를 넣거나 상품을 바꿔 주세요." };
    }
    // 끈 동안 늘어난 댓글을 다시 훑게 댓글 수 기억을 지운다(7일 안이면 이어서 처리)
    const { error } = await service
      .from("post_automations")
      .update({ status: "ACTIVE", paused_reason: null, last_comment_count: null, last_polled_at: null })
      .eq("id", a.id);
    if (error) return { ok: false, error: error.message };
    // 미뤄 둔 기록을 바로 보낼 차례로
    await service
      .from("post_automation_events")
      .update({ next_attempt_at: new Date().toISOString() })
      .eq("automation_id", a.id)
      .or("dm_status.eq.PENDING,reply_status.eq.PENDING");
  } else {
    const { error } = await service.from("post_automations").update({ status: "PAUSED", paused_reason: "MANUAL" }).eq("id", a.id);
    if (error) return { ok: false, error: error.message };
  }
  revalidatePath(PATH);
  return { ok: true };
}

export async function deleteAutomation(id: string): Promise<ActionResult> {
  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };
  const service = createServiceClient();
  const a = await loadOwnAutomation(service, auth, id);
  if (!a) return { ok: false, error: "설정을 찾을 수 없어요." };
  // 기록은 남긴다(소프트 삭제). 대기 중인 발송은 processEvent가 건너뜀으로 바꾼다.
  const { error } = await service.from("post_automations").update({ deleted_at: new Date().toISOString() }).eq("id", a.id);
  if (error) return { ok: false, error: error.message };
  revalidatePath(PATH);
  return { ok: true };
}

export async function retryFirstComment(id: string): Promise<ActionResult<{ result: string }>> {
  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };
  const service = createServiceClient();
  const a = await loadOwnAutomation(service, auth, id);
  if (!a) return { ok: false, error: "설정을 찾을 수 없어요." };
  if (a.first_comment_status !== "FAILED") return { ok: false, error: "다시 달 첫 댓글이 없어요." };
  await service.from("post_automations").update({ first_comment_status: "PENDING", first_comment_error: null }).eq("id", a.id);
  const result = await postFirstComment(service, a.id);
  revalidatePath(PATH);
  return result === "첫 댓글 등록" ? { ok: true, result } : { ok: false, error: result };
}

// ─────────────────────────────────────────────────────────────────────────────
// 확인 필요(DM 결과 모름) 처리

export async function resolveUnknownEvent(eventId: string, how: "MARKED_SENT" | "RESENT"): Promise<ActionResult<{ result: string }>> {
  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };
  const service = createServiceClient();
  const { data: ev } = await service.from("post_automation_events").select("*").eq("id", eventId).maybeSingle();
  if (!ev || ev.organization_id !== auth.organizationId) return { ok: false, error: "기록을 찾을 수 없어요." };
  if (ev.dm_status !== "UNKNOWN") return { ok: false, error: "이미 처리된 기록이에요." };
  const resolved = { resolved_by: auth.userId, resolved_at: new Date().toISOString(), resolution: how };

  let result: string;
  if (how === "MARKED_SENT") {
    const { data: a } = await service.from("post_automations").select("config").eq("id", ev.automation_id).maybeSingle();
    const cfg = a ? parseConfig(a.config) : null;
    const replyAfterDm = !!cfg && cfg.reply.on && cfg.dm.on && cfg.reply.when === "dm" && ev.reply_status === "NONE";
    await service
      .from("post_automation_events")
      .update({
        ...resolved,
        dm_status: "SENT",
        dm_sent_at: new Date().toISOString(),
        dm_error: null,
        ...(replyAfterDm ? { reply_status: "PENDING", next_attempt_at: new Date().toISOString() } : {}),
      })
      .eq("id", ev.id)
      .eq("dm_status", "UNKNOWN");
    result = replyAfterDm ? await processEvent(service, ev.id) : "보낸 것으로 처리";
  } else {
    await service.from("post_automation_events").update(resolved).eq("id", ev.id);
    result = await processEvent(service, ev.id, { force: true });
  }
  revalidatePath(PATH);
  return { ok: true, result };
}

// ─────────────────────────────────────────────────────────────────────────────
// 템플릿

export async function saveAutomationTemplate(name: string, config: AutomationConfig): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };
  const n = name.trim();
  if (!n || n.length > 40) return { ok: false, error: "템플릿 이름은 1~40자로 넣어 주세요." };
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) return { ok: false, error: "설정 형식이 맞지 않아요." };
  const service = createServiceClient();
  const { data, error } = await service
    .from("post_automation_templates")
    .insert({ organization_id: auth.organizationId, name: n, config: parsed.data as unknown as AutomationRow["config"], created_by: auth.userId })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  revalidatePath(PATH);
  return { ok: true, id: data.id };
}

export async function deleteAutomationTemplate(id: string): Promise<ActionResult> {
  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };
  const service = createServiceClient();
  const { error } = await service
    .from("post_automation_templates")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", auth.organizationId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(PATH);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// 서랍 — 활동 기록 (최근 순)

export interface EventView {
  id: string;
  username: string | null;
  text: string | null;
  commentedAt: string | null;
  source: string;
  keyword: string | null;
  skipReason: string | null;
  dmStatus: string;
  dmFormat: string | null;
  dmFallback: boolean;
  dmError: string | null;
  dmSentAt: string | null;
  step2Status: string;
  replyStatus: string;
  replyText: string | null;
  replyError: string | null;
  resolution: string | null;
}

export async function listAutomationEvents(automationId: string): Promise<ActionResult<{ events: EventView[] }>> {
  const supabase = await createClient();
  // RLS(같은 조직 SELECT)로 읽는다
  const { data, error } = await supabase
    .from("post_automation_events")
    .select("id, commenter_username, comment_text, commented_at, source, matched_keyword, skip_reason, dm_status, dm_format, dm_fallback, dm_error, dm_sent_at, step2_status, reply_status, reply_text, reply_error, resolution, created_at")
    .eq("automation_id", automationId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return { ok: false, error: error.message };
  return {
    ok: true,
    events: (data ?? []).map((e) => ({
      id: e.id,
      username: e.commenter_username,
      text: e.comment_text,
      commentedAt: e.commented_at,
      source: e.source,
      keyword: e.matched_keyword,
      skipReason: e.skip_reason,
      dmStatus: e.dm_status,
      dmFormat: e.dm_format,
      dmFallback: e.dm_fallback,
      dmError: e.dm_error,
      dmSentAt: e.dm_sent_at,
      step2Status: e.step2_status,
      replyStatus: e.reply_status,
      replyText: e.reply_text,
      replyError: e.reply_error,
      resolution: e.resolution,
    })),
  };
}
