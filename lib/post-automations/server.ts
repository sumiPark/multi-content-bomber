// 게시물 댓글 · DM 자동화 — 발송 엔진. service_role 클라이언트 전용(웹훅 · cron · 서버 액션 · 발행 워커).
// server-only는 쓰지 않는다 — 발행 워커(tsx + plain Node)에서도 import한다.
//
// 한 댓글의 흐름:
//   handleIncomingComment  조건 확인(키워드 · 제외 · 같은 사람) → 기록(post_automation_events) 만들기
//   processEvent           보내기 직전 다시 확인(켜짐 · 기간 · 7일 · 품절 · 상한) → DM → 성공하면 답글
// DM 결과를 모르면(네트워크 · 인스타 서버 오류) UNKNOWN으로 두고 다시 보내지 않는다 — 사람이 확인.
import { randomBytes } from "node:crypto";
import { decryptToken } from "@/lib/crypto";
import {
  InstagramApiError,
  getInstagramMe,
  getInstagramMedia,
  listAllComments,
  replyToComment,
} from "@/lib/platforms/instagram-comments";
import {
  looksLikeFormatRejected,
  postMediaComment,
  sendDirectMessage,
  sendPrivateReply,
  type OutgoingMessage,
  type SendOutcome,
} from "@/lib/platforms/instagram-messages";
import type { createServiceClient } from "@/lib/supabase/service";
import type { Database, Json } from "@/types/database";
import {
  PRIVATE_REPLY_WINDOW_DAYS,
  configSchema,
  effectiveReplyWhen,
  renderText,
  shopHomeUrl,
  withUtm,
  type AutomationConfig,
  type AutomationPlatform,
} from "./config";
import { matchComment } from "./match";

type Service = ReturnType<typeof createServiceClient>;
export type AutomationRow = Database["public"]["Tables"]["post_automations"]["Row"];
export type EventRow = Database["public"]["Tables"]["post_automation_events"]["Row"];

// 계정별 발송 상한 기본값 — 처음엔 낮게, 시범 운영 결과로 올린다(사용자 결정, 2026-11-27).
// 시리즈 댓글 답글과 합쳐서 센다(DM · 답글 각각 한 건).
export const DEFAULT_LIMITS = { hourly: 40, daily: 200 };
// 두 단계: 빠른 답장 payload 앞머리. 뒤에 기록 id가 붙는다.
export const QUICK_PAYLOAD_PREFIX = "MCBPA:";
const MAX_ATTEMPTS = 3;
const DAY_MS = 24 * 60 * 60_000;

export class PostAutomationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostAutomationError";
  }
}

export function parseConfig(json: Json | unknown): AutomationConfig {
  return configSchema.parse(json);
}

export function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || "https://mcb.cuma.co.kr").replace(/\/$/, "");
}

const nowIso = () => new Date().toISOString();
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

// ─────────────────────────────────────────────────────────────────────────────
// 계정 · 상품

export interface AccountAuth {
  id: string;
  organizationId: string;
  platform: AutomationPlatform;
  platformAccountId: string;
  username: string | null;
  token: string;
  // 내 댓글을 가려낼 ID들 (/me의 id와 user_id가 다를 수 있다 — instagram-comments.ts 실측 메모)
  ownIds: Set<string>;
}

const accountCache = new Map<string, Promise<AccountAuth>>();

export function loadAccount(service: Service, socialAccountId: string): Promise<AccountAuth> {
  let p = accountCache.get(socialAccountId);
  if (!p) {
    p = (async () => {
      const { data: a } = await service
        .from("social_accounts")
        .select("id, organization_id, platform, platform_account_id, display_name, is_active, disconnected_at, access_token_encrypted")
        .eq("id", socialAccountId)
        .maybeSingle();
      if (!a) throw new PostAutomationError("계정을 찾을 수 없어요.");
      if (a.disconnected_at) throw new PostAutomationError("연결이 해제된 계정이에요. 계정 연동에서 다시 연결해 주세요.");
      if (!a.is_active || !a.access_token_encrypted) throw new PostAutomationError("계정 토큰이 만료됐어요. 계정 연동에서 다시 연결해 주세요.");
      if (a.platform !== "INSTAGRAM") throw new PostAutomationError("지금은 인스타그램 계정만 보낼 수 있어요.");
      const token = decryptToken(a.access_token_encrypted);
      const ownIds = new Set<string>([a.platform_account_id]);
      try {
        const me = await getInstagramMe(token);
        ownIds.add(me.id);
        if (me.userId) ownIds.add(me.userId);
      } catch {
        // /me 실패해도 platform_account_id · 이름으로 가린다
      }
      return {
        id: a.id,
        organizationId: a.organization_id,
        platform: "INSTAGRAM",
        platformAccountId: a.platform_account_id,
        username: a.display_name?.replace(/^@/, "") ?? null,
        token,
        ownIds,
      } satisfies AccountAuth;
    })();
    p.catch(() => accountCache.delete(socialAccountId));
    accountCache.set(socialAccountId, p);
  }
  return p;
}

export interface ProductInfo {
  id: string;
  name: string;
  url: string;
  soldOut: boolean;
}

export async function loadProduct(service: Service, productId: string | null): Promise<ProductInfo | null> {
  if (!productId) return null;
  const { data } = await service.from("products").select("id, name, url, stock_status").eq("id", productId).maybeSingle();
  if (!data) return null;
  return { id: data.id, name: data.name, url: data.url, soldOut: data.stock_status !== "available" };
}

// ─────────────────────────────────────────────────────────────────────────────
// 버튼 링크 — MCB 주소(/r/<code>)를 거쳐 클릭을 센다. 설정을 저장할 때마다 대상 주소를 맞춘다.

function newCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(10);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export function buttonTargetUrl(
  b: AutomationConfig["dm"]["buttons"][number],
  product: ProductInfo | null,
  platform: AutomationPlatform,
  campaign: string,
): string | null {
  if (b.link === "custom") return b.url.trim() || null;
  const base = b.link === "product" ? product?.url : shopHomeUrl(product?.url);
  return base ? withUtm(base, platform, "dm", campaign) : null;
}

export async function syncButtonLinks(service: Service, automation: AutomationRow, cfg: AutomationConfig, product: ProductInfo | null) {
  const campaign = `mcb_${automation.id.slice(0, 8)}`;
  const { data: existing } = await service
    .from("post_automation_links")
    .select("code, button_index")
    .eq("automation_id", automation.id);
  const codeByIndex = new Map((existing ?? []).map((l) => [l.button_index, l.code]));
  const rows = cfg.dm.buttons
    .map((b, i) => {
      const target = buttonTargetUrl(b, product, automation.platform as AutomationPlatform, campaign);
      if (!target) return null;
      return {
        code: codeByIndex.get(i) ?? newCode(),
        automation_id: automation.id,
        organization_id: automation.organization_id,
        button_index: i,
        label: b.label.trim(),
        target_url: target,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  if (rows.length) {
    const { error } = await service.from("post_automation_links").upsert(rows, { onConflict: "automation_id,button_index" });
    if (error) throw new Error(`버튼 링크 저장 실패: ${error.message}`);
  }
}

async function buttonUrls(service: Service, automationId: string): Promise<Map<number, string>> {
  const { data } = await service.from("post_automation_links").select("code, button_index").eq("automation_id", automationId);
  return new Map((data ?? []).map((l) => [l.button_index, `${siteUrl()}/r/${l.code}`]));
}

// ─────────────────────────────────────────────────────────────────────────────
// 발송 상한 — 최근 1시간 · 24시간에 이 계정이 보낸 DM · 답글(시리즈 답글 포함)

export async function loadLimits(service: Service, socialAccountId: string) {
  const { data } = await service
    .from("comment_dm_settings")
    .select("hourly_limit, daily_limit")
    .eq("social_account_id", socialAccountId)
    .maybeSingle();
  return { hourly: data?.hourly_limit ?? DEFAULT_LIMITS.hourly, daily: data?.daily_limit ?? DEFAULT_LIMITS.daily };
}

async function countSent(service: Service, socialAccountId: string, sinceIso: string): Promise<number> {
  const [dm, reply] = await Promise.all([
    service.from("post_automation_events").select("id", { count: "exact", head: true })
      .eq("social_account_id", socialAccountId).gte("dm_sent_at", sinceIso),
    service.from("post_automation_events").select("id", { count: "exact", head: true })
      .eq("social_account_id", socialAccountId).gte("reply_sent_at", sinceIso),
  ]);
  let series = 0;
  const { data: tasks } = await service.from("episode_alert_tasks").select("id").eq("social_account_id", socialAccountId)
    .gte("updated_at", new Date(Date.now() - 8 * DAY_MS).toISOString());
  const taskIds = (tasks ?? []).map((t) => t.id);
  if (taskIds.length) {
    const { count } = await service.from("episode_alert_replies").select("id", { count: "exact", head: true })
      .in("task_id", taskIds).eq("status", "SENT").gte("sent_at", sinceIso);
    series = count ?? 0;
  }
  return (dm.count ?? 0) + (reply.count ?? 0) + series;
}

/** 지금 보내도 되는지. 넘었으면 다시 시도할 시각을 돌려준다. */
export async function checkSendBudget(service: Service, socialAccountId: string): Promise<{ ok: true } | { ok: false; retryAt: string }> {
  const limits = await loadLimits(service, socialAccountId);
  const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
  const dayAgo = new Date(Date.now() - DAY_MS).toISOString();
  const [hour, day] = await Promise.all([countSent(service, socialAccountId, hourAgo), countSent(service, socialAccountId, dayAgo)]);
  if (day >= limits.daily) return { ok: false, retryAt: new Date(Date.now() + 60 * 60_000).toISOString() };
  if (hour >= limits.hourly) return { ok: false, retryAt: new Date(Date.now() + 10 * 60_000).toISOString() };
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// 들어온 댓글 처리

export interface IncomingComment {
  id: string;
  text: string;
  fromId: string | null;
  username: string | null;
  timestamp: string | null;
  parentId: string | null;
}

export type CommentSource = "WEBHOOK" | "POLL" | "BACKFILL";

const isActiveNow = (a: AutomationRow) =>
  !a.deleted_at && a.status === "ACTIVE" && (!a.ends_at || new Date(a.ends_at).getTime() > Date.now());

/**
 * 댓글 하나를 받아 기록을 만든다. 반응할 대상이면 PENDING으로 만들고 id를 돌려준다(보내기는 processEvent).
 * 이미 기록된 댓글(웹훅 중복 · 확인 겹침)이면 null.
 */
export async function handleIncomingComment(
  service: Service,
  automation: AutomationRow,
  comment: IncomingComment,
  source: CommentSource,
): Promise<string | null> {
  // 답글(대댓글)에는 반응하지 않는다 — 우리 자동 답글이 다시 들어와 이어지는 것도 여기서 끊긴다.
  if (comment.parentId) return null;
  if (!isActiveNow(automation)) return null;
  const cfg = parseConfig(automation.config);
  const account = await loadAccount(service, automation.social_account_id);

  const commentedAt = comment.timestamp ? new Date(comment.timestamp) : new Date();
  // 켜기 전에 달린 댓글은 "이미 달린 댓글에도 보내기"일 때만(7일 안)
  const startedAt = automation.starts_at ? new Date(automation.starts_at).getTime() : 0;
  if (commentedAt.getTime() < startedAt) {
    if (!cfg.period.backfill) return null;
    if (Date.now() - commentedAt.getTime() > PRIVATE_REPLY_WINDOW_DAYS * DAY_MS) return null;
  }

  const base = {
    automation_id: automation.id,
    organization_id: automation.organization_id,
    social_account_id: automation.social_account_id,
    comment_id: comment.id,
    commenter_id: comment.fromId,
    commenter_username: comment.username,
    comment_text: comment.text.slice(0, 2000),
    commented_at: commentedAt.toISOString(),
    source,
  };

  const own =
    (comment.fromId && account.ownIds.has(comment.fromId)) ||
    (!!comment.username && !!account.username && comment.username.replace(/^@/, "") === account.username);
  if (own) {
    await service.from("post_automation_events").upsert({ ...base, skip_reason: "OWN" }, { onConflict: "automation_id,comment_id", ignoreDuplicates: true });
    return null;
  }

  const m = matchComment(cfg, comment.text);
  if (!m.matched) {
    // 제외 단어로 빠진 것만 남긴다 (키워드가 없는 일반 댓글까지 남기면 기록이 너무 많아진다)
    if (m.reason === "EXCLUDED") {
      await service.from("post_automation_events").upsert({ ...base, skip_reason: "EXCLUDED" }, { onConflict: "automation_id,comment_id", ignoreDuplicates: true });
    }
    return null;
  }

  const dmOn = cfg.dm.on && automation.platform === "INSTAGRAM";
  const replyNow = cfg.reply.on && effectiveReplyWhen(cfg) === "all";
  const row = {
    ...base,
    matched_keyword: m.keyword,
    dm_status: dmOn ? "PENDING" : "NONE",
    reply_status: replyNow ? "PENDING" : "NONE",
    next_attempt_at: nowIso(),
  };

  const { data, error } = await service
    .from("post_automation_events")
    .upsert(row, { onConflict: "automation_id,comment_id", ignoreDuplicates: true })
    .select("id");
  if (error) {
    // 23505 = 같은 게시물에서 이 사람에게 이미 DM을 보냈거나 보내는 중 (one_dm_per_person)
    if (error.code === "23505") {
      await service.from("post_automation_events").upsert(
        { ...base, matched_keyword: m.keyword, dm_status: "SKIPPED", skip_reason: "ALREADY_SENT" },
        { onConflict: "automation_id,comment_id", ignoreDuplicates: true },
      );
      return null;
    }
    throw new Error(`댓글 기록 실패: ${error.message}`);
  }
  return data?.[0]?.id ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 보내기

function buildDm(
  cfg: AutomationConfig,
  ctx: { productName: string | null; productUrl: string | null; username: string | null },
  urls: Map<number, string>,
  eventId: string,
  soldOut: boolean,
): { format: "button" | "twostep" | "text" | "soldout"; message: OutgoingMessage; fallback: OutgoingMessage } {
  const r = (t: string) => renderText(cfg, t, ctx);
  const buttons = cfg.dm.buttons
    .map((b, i) => ({ title: b.label.trim(), url: urls.get(i) ?? "" }))
    .filter((b) => b.title && b.url);
  // 버튼이 거절됐을 때 같은 내용을 글자 + 링크로
  const asText = (head: string) => ({
    kind: "text" as const,
    text: [r(head), ...buttons.map((b) => `${b.title}: ${b.url}`)].join("\n").slice(0, 900),
  });

  if (soldOut && cfg.dm.soldout.trim()) {
    const t = { kind: "text" as const, text: r(cfg.dm.soldout) };
    return { format: "soldout", message: t, fallback: t };
  }
  if (cfg.dm.format === "text") {
    const t = { kind: "text" as const, text: r(cfg.dm.text) };
    return { format: "text", message: t, fallback: t };
  }
  if (cfg.dm.format === "button") {
    return { format: "button", message: { kind: "button", text: r(cfg.dm.btnText), buttons }, fallback: asText(cfg.dm.btnText) };
  }
  return {
    format: "twostep",
    message: { kind: "quick", text: r(cfg.dm.step1), quickReplies: [{ title: cfg.dm.quick.trim().slice(0, 20), payload: `${QUICK_PAYLOAD_PREFIX}${eventId}` }] },
    fallback: asText(cfg.dm.btnText),
  };
}

function pickReplyText(cfg: AutomationConfig, seed: string): string | null {
  const texts = cfg.reply.texts.map((t) => t.trim()).filter(Boolean);
  if (!texts.length) return null;
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return texts[h % texts.length];
}

async function releaseWithRetry(service: Service, ev: EventRow, patch: Partial<EventRow>, retryAt: string) {
  await service.from("post_automation_events").update({ ...patch, next_attempt_at: retryAt, locked_at: null }).eq("id", ev.id);
}

/** 기록 하나를 보낸다. 웹훅(after) · cron · 사람의 "다시 보내기"가 부른다. */
export async function processEvent(service: Service, eventId: string, opts: { force?: boolean } = {}): Promise<string> {
  const { data: ev } = await service.from("post_automation_events").select("*").eq("id", eventId).maybeSingle();
  if (!ev) return "기록 없음";
  const { data: automation } = await service.from("post_automations").select("*").eq("id", ev.automation_id).maybeSingle();
  if (!automation) return "설정 없음";

  // 보내기 직전 다시 확인 — 사람이 끈(멈춤) 설정은 미뤄 두고(다시 켜면 7일 안이면 이어서 보낸다),
  // 끝난 · 지운 설정은 남은 것을 건너뜀으로
  const endedOrDeleted =
    !!automation.deleted_at || automation.status === "ENDED" || (!!automation.ends_at && new Date(automation.ends_at).getTime() <= Date.now());
  if (!endedOrDeleted && automation.status !== "ACTIVE") {
    await releaseWithRetry(service, ev, {}, new Date(Date.now() + 30 * 60_000).toISOString());
    return "멈춘 설정 — 미룸";
  }
  if (!isActiveNow(automation)) {
    await service.from("post_automation_events").update({
      dm_status: ev.dm_status === "PENDING" ? "SKIPPED" : ev.dm_status,
      reply_status: ev.reply_status === "PENDING" ? "SKIPPED" : ev.reply_status,
      skip_reason: ev.skip_reason ?? "PAUSED",
      locked_at: null,
    }).eq("id", ev.id);
    return "꺼진 설정";
  }

  const cfg = parseConfig(automation.config);
  let account: AccountAuth;
  try {
    account = await loadAccount(service, automation.social_account_id);
  } catch (e) {
    await service.from("post_automations").update({ status: "PAUSED", paused_reason: "ACCOUNT" }).eq("id", automation.id);
    await releaseWithRetry(service, ev, {}, new Date(Date.now() + 30 * 60_000).toISOString());
    return `계정 오류: ${errMsg(e)}`;
  }

  const budget = await checkSendBudget(service, automation.social_account_id);
  if (!budget.ok) {
    await releaseWithRetry(service, ev, {}, budget.retryAt);
    return "상한 초과 — 미룸";
  }

  const product = await loadProduct(service, automation.product_id);
  const notes: string[] = [];

  // ── DM ──
  let dmJustSent = false;
  if (ev.dm_status === "PENDING" || (opts.force && ev.dm_status === "UNKNOWN")) {
    const expired = ev.commented_at && Date.now() - new Date(ev.commented_at).getTime() > PRIVATE_REPLY_WINDOW_DAYS * DAY_MS;
    if (expired) {
      await service.from("post_automation_events").update({ dm_status: "SKIPPED", skip_reason: "EXPIRED", locked_at: null }).eq("id", ev.id);
      return "7일 지남";
    }
    if (product?.soldOut && !cfg.dm.soldout.trim()) {
      await service.from("post_automations").update({ status: "PAUSED", paused_reason: "SOLDOUT" }).eq("id", automation.id);
      await releaseWithRetry(service, ev, {}, new Date(Date.now() + 30 * 60_000).toISOString());
      return "품절 — 멈춤";
    }
    // 보내는 중으로 바꾼다 (다른 실행이 먼저 잡았으면 끝)
    const claim = await service.from("post_automation_events")
      .update({ dm_status: "SENDING", attempts: ev.attempts + 1 })
      .eq("id", ev.id).in("dm_status", opts.force ? ["UNKNOWN", "PENDING"] : ["PENDING"]).select("id");
    if (!claim.data?.length) return "이미 처리 중";

    const urls = await buttonUrls(service, automation.id);
    const ctx = {
      productName: product?.name ?? null,
      productUrl: product ? withUtm(product.url, "INSTAGRAM", "dm", `mcb_${automation.id.slice(0, 8)}`) : null,
      username: ev.commenter_username,
    };
    const built = buildDm(cfg, ctx, urls, ev.id, !!product?.soldOut);
    let out: SendOutcome = await sendPrivateReply(account.platformAccountId, account.token, ev.comment_id, built.message);
    let format: string = built.format;
    let fallback = false;
    if (!out.ok && !out.unknown && built.message.kind !== "text" && looksLikeFormatRejected(out.apiError)) {
      notes.push(`버튼 형태 거절(${out.error}) → 글자로 다시`);
      out = await sendPrivateReply(account.platformAccountId, account.token, ev.comment_id, built.fallback);
      format = "text";
      fallback = true;
    }

    if (out.ok) {
      dmJustSent = true;
      await service.from("post_automation_events").update({
        dm_status: "SENT",
        dm_format: format,
        dm_fallback: fallback,
        dm_message_id: out.messageId,
        dm_sent_at: nowIso(),
        dm_error: fallback ? notes.join(" · ") : null,
        step2_status: format === "twostep" ? "WAITING" : "NONE",
        reply_status: cfg.reply.on && effectiveReplyWhen(cfg) === "dm" ? "PENDING" : ev.reply_status,
        locked_at: null,
      }).eq("id", ev.id);
    } else if (out.unknown) {
      await service.from("post_automation_events").update({
        dm_status: "UNKNOWN", dm_format: format, dm_error: `인스타에서 응답이 끊겨 DM이 갔는지 확인되지 않았어요. (${out.error})`, locked_at: null,
      }).eq("id", ev.id);
      return "DM 결과 모름";
    } else {
      const e = out.apiError;
      if (e.kind === "RATE_LIMIT" || e.kind === "BLOCKED") {
        const retry = ev.attempts + 1 < MAX_ATTEMPTS;
        await service.from("post_automation_events").update({
          dm_status: retry ? "PENDING" : "FAILED",
          dm_error: e.kind === "BLOCKED" ? "인스타가 활동을 잠시 제한했어요." : "인스타 호출 한도에 걸렸어요.",
          next_attempt_at: new Date(Date.now() + (e.kind === "BLOCKED" ? 6 * 60 : 15) * 60_000).toISOString(),
          locked_at: null,
        }).eq("id", ev.id);
        return "한도 — 미룸";
      }
      if (e.kind === "TOKEN") {
        await service.from("post_automations").update({ status: "PAUSED", paused_reason: "ACCOUNT" }).eq("id", automation.id);
      }
      await service.from("post_automation_events").update({
        dm_status: "FAILED", dm_format: format, dm_error: dmErrorText(e), reply_status: ev.reply_status === "PENDING" && effectiveReplyWhen(cfg) === "dm" ? "SKIPPED" : ev.reply_status, locked_at: null,
      }).eq("id", ev.id);
      return `DM 실패: ${e.message}`;
    }
  }

  // ── 답글 ──
  const { data: fresh } = await service.from("post_automation_events").select("reply_status, attempts").eq("id", ev.id).maybeSingle();
  if (fresh?.reply_status === "PENDING") {
    const claim = await service.from("post_automation_events").update({ reply_status: "SENDING" }).eq("id", ev.id).eq("reply_status", "PENDING").select("id");
    if (claim.data?.length) {
      const text = pickReplyText(cfg, ev.comment_id);
      if (!text) {
        await service.from("post_automation_events").update({ reply_status: "SKIPPED", locked_at: null }).eq("id", ev.id);
      } else {
        const rendered = renderText(cfg, text, { productName: product?.name ?? null, username: ev.commenter_username });
        try {
          const res = await replyToComment(ev.comment_id, rendered, account.token);
          await service.from("post_automation_events").update({
            reply_status: "SENT", reply_id: res.id, reply_text: rendered, reply_sent_at: nowIso(), reply_error: null, locked_at: null,
          }).eq("id", ev.id);
        } catch (e) {
          const api = e instanceof InstagramApiError ? e : null;
          const retry = api && (api.kind === "RATE_LIMIT" || api.kind === "BLOCKED") && (fresh.attempts ?? 0) < MAX_ATTEMPTS;
          await service.from("post_automation_events").update({
            reply_status: retry ? "PENDING" : api?.kind === "NOT_FOUND" ? "SKIPPED" : "FAILED",
            reply_error: api?.kind === "NOT_FOUND" ? "댓글이 지워져 답글을 달지 못했어요." : errMsg(e),
            next_attempt_at: retry ? new Date(Date.now() + 15 * 60_000).toISOString() : null,
            locked_at: null,
          }).eq("id", ev.id);
        }
      }
    }
  } else {
    await service.from("post_automation_events").update({ locked_at: null }).eq("id", ev.id);
  }
  return dmJustSent ? "보냄" : "답글 처리";
}

function dmErrorText(e: InstagramApiError): string {
  if (e.kind === "TOKEN") return "계정 연결이 끊겨 보내지 못했어요. 계정 연동에서 다시 연결해 주세요.";
  if (e.kind === "NOT_FOUND") return "댓글이 지워졌거나 DM을 보낼 수 없는 댓글이에요.";
  return `보내지 못했어요: ${e.message}`.slice(0, 400);
}

// ─────────────────────────────────────────────────────────────────────────────
// 두 단계 — 고객이 빠른 답장을 누르면 버튼 메시지를 보낸다 (24시간 안)

export async function handleQuickReply(service: Service, args: { igAccountId: string; senderId: string; payload: string }): Promise<string> {
  if (!args.payload.startsWith(QUICK_PAYLOAD_PREFIX)) return "다른 payload";
  const eventId = args.payload.slice(QUICK_PAYLOAD_PREFIX.length);
  if (!/^[0-9a-f-]{36}$/i.test(eventId)) return "잘못된 payload";
  const claim = await service.from("post_automation_events")
    .update({ step2_status: "SENT", step2_sent_at: nowIso() })
    .eq("id", eventId).eq("step2_status", "WAITING").select("*");
  const ev = claim.data?.[0];
  if (!ev) return "이미 보냈거나 대상 아님";
  const { data: automation } = await service.from("post_automations").select("*").eq("id", ev.automation_id).maybeSingle();
  if (!automation) return "설정 없음";
  const cfg = parseConfig(automation.config);
  const account = await loadAccount(service, automation.social_account_id);
  const product = await loadProduct(service, automation.product_id);
  const urls = await buttonUrls(service, automation.id);
  const buttons = cfg.dm.buttons.map((b, i) => ({ title: b.label.trim(), url: urls.get(i) ?? "" })).filter((b) => b.title && b.url);
  const text = renderText(cfg, cfg.dm.btnText, { productName: product?.name ?? null, username: ev.commenter_username });
  let out = await sendDirectMessage(account.platformAccountId, account.token, args.senderId, { kind: "button", text, buttons });
  if (!out.ok && !out.unknown && looksLikeFormatRejected(out.apiError)) {
    out = await sendDirectMessage(account.platformAccountId, account.token, args.senderId, {
      kind: "text",
      text: [text, ...buttons.map((b) => `${b.title}: ${b.url}`)].join("\n"),
    });
  }
  if (!out.ok) {
    await service.from("post_automation_events").update({ step2_status: "FAILED", dm_error: `2번 DM 실패: ${out.error}`.slice(0, 400) }).eq("id", ev.id);
    return "2번 DM 실패";
  }
  return "2번 DM 보냄";
}

// ─────────────────────────────────────────────────────────────────────────────
// 첫 댓글 — 켤 때(이미 올라간 게시물) · 발행 성공 때(콘텐츠 생성)

export async function postFirstComment(service: Service, automationId: string): Promise<string> {
  const claim = await service.from("post_automations")
    .update({ first_comment_status: "SENT", first_comment_at: nowIso() }) // 먼저 잡아 두고, 실패하면 FAILED로
    .eq("id", automationId).eq("first_comment_status", "PENDING").not("platform_post_id", "is", null)
    .select("*");
  const a = claim.data?.[0];
  if (!a) return "대상 아님";
  try {
    const cfg = parseConfig(a.config);
    if (!cfg.first.on || !cfg.first.text.trim()) {
      await service.from("post_automations").update({ first_comment_status: "NONE", first_comment_at: null }).eq("id", a.id);
      return "첫 댓글 꺼짐";
    }
    const account = await loadAccount(service, a.social_account_id);
    const product = await loadProduct(service, a.product_id);
    const text = renderText(cfg, cfg.first.text, { productName: product?.name ?? null });
    const res = await postMediaComment(a.platform_post_id!, text, account.token);
    await service.from("post_automations").update({ first_comment_id: res.id, first_comment_error: null }).eq("id", a.id);
    return "첫 댓글 등록";
  } catch (e) {
    await service.from("post_automations").update({ first_comment_status: "FAILED", first_comment_error: errMsg(e) }).eq("id", a.id);
    return `첫 댓글 실패: ${errMsg(e)}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 놓친 댓글 찾기 — 웹훅이 빠졌을 때 대비 (5분마다) + 켤 때 "이미 달린 댓글에도"

export async function pollAutomation(service: Service, automation: AutomationRow): Promise<{ newEvents: string[] }> {
  const cfg = parseConfig(automation.config);
  const needBackfill = cfg.period.backfill && !automation.backfill_done_at;
  const newEvents: string[] = [];
  if (!automation.platform_post_id || automation.platform !== "INSTAGRAM") {
    await service.from("post_automations").update({ last_polled_at: nowIso() }).eq("id", automation.id);
    return { newEvents };
  }
  const account = await loadAccount(service, automation.social_account_id);
  const media = await getInstagramMedia(automation.platform_post_id, account.token);
  const count = media.commentsCount ?? null;
  if (needBackfill || count === null || count !== automation.last_comment_count) {
    const comments = await listAllComments(automation.platform_post_id, account.token);
    const since = needBackfill
      ? Date.now() - PRIVATE_REPLY_WINDOW_DAYS * DAY_MS
      : automation.starts_at ? new Date(automation.starts_at).getTime() : 0;
    for (const c of comments) {
      if (c.parentId || new Date(c.timestamp).getTime() < since) continue;
      const id = await handleIncomingComment(service, automation, {
        id: c.id, text: c.text, fromId: c.fromId, username: c.username, timestamp: c.timestamp, parentId: c.parentId,
      }, needBackfill ? "BACKFILL" : "POLL");
      if (id) newEvents.push(id);
    }
  }
  await service.from("post_automations").update({
    last_polled_at: nowIso(),
    last_comment_count: count,
    ...(needBackfill ? { backfill_done_at: nowIso() } : {}),
  }).eq("id", automation.id);
  return { newEvents };
}

// ─────────────────────────────────────────────────────────────────────────────
// 웹훅 — 게시물 ID로 켜진 설정 찾기

export async function findActiveAutomation(service: Service, igAccountId: string, mediaId: string): Promise<AutomationRow | null> {
  const { data: rows } = await service
    .from("post_automations")
    .select("*")
    .eq("platform_post_id", mediaId)
    .eq("status", "ACTIVE")
    .is("deleted_at", null)
    .limit(5);
  if (!rows?.length) return null;
  if (rows.length === 1) return rows[0];
  // 같은 게시물 ID는 한 계정에만 있다. 계정 ID가 맞는 것을 고르되, ID 체계가 달라 안 맞으면 첫 행.
  const { data: accounts } = await service
    .from("social_accounts")
    .select("id, platform_account_id")
    .in("id", rows.map((r) => r.social_account_id));
  const accountId = accounts?.find((a) => a.platform_account_id === igAccountId)?.id;
  return rows.find((r) => r.social_account_id === accountId) ?? rows[0];
}
