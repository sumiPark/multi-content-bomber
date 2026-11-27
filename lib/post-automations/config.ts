// 게시물 댓글 · DM 자동화 — 설정 형식 · 기본값 · 검사 · 문구 채우기.
// 화면(설정 창)과 서버(액션 · 웹훅 · cron)가 같이 쓴다. 서버 전용 import 금지.
//
// 인스타 제약 (Meta 공식 문서, 2026-11-27 확인):
//   - 댓글 기반 DM(private reply): 댓글 하나에 한 번, 댓글이 달리고 7일 안
//   - 글자 메시지 1,000바이트 · 버튼 메시지 글 640자 · 버튼 1~3개 · 빠른 답장 이름 20자에서 잘림
//   - 고객이 답장 · 빠른 답장을 누르면 그때부터 24시간 이어서 보낼 수 있다
import { z } from "zod";

export const DM_TEXT_MAX_BYTES = 1000;
export const BUTTON_TEXT_MAX_CHARS = 640;
export const BUTTON_LABEL_MAX = 20;
export const QUICK_LABEL_MAX = 20;
export const MAX_BUTTONS = 3;
export const MAX_REPLIES = 10;
export const MAX_KEYWORDS = 20;
export const PRIVATE_REPLY_WINDOW_DAYS = 7;
export const PERIOD_PRESETS = [7, 14, 30] as const;

export type AutomationPlatform = "INSTAGRAM" | "YOUTUBE";
export type Preset = "link" | "comment" | "custom";
export type DmFormat = "button" | "twostep" | "text";
export type LinkTarget = "product" | "home" | "custom";

const word = z.string().trim().min(1).max(30);

export const buttonSchema = z.object({
  label: z.string().max(40),
  link: z.enum(["product", "home", "custom"]),
  url: z.string().max(2000),
});

export const configSchema = z.object({
  preset: z.enum(["link", "comment", "custom"]),
  first: z.object({ on: z.boolean(), text: z.string().max(2200) }),
  trig: z.object({
    mode: z.enum(["keyword", "all"]),
    keywords: z.array(word).max(MAX_KEYWORDS),
    match: z.enum(["contains", "exact"]),
    exclude: z.array(word).max(MAX_KEYWORDS),
    emojiOnly: z.boolean(),
  }),
  dm: z.object({
    on: z.boolean(),
    format: z.enum(["button", "twostep", "text"]),
    text: z.string().max(3000),
    btnText: z.string().max(2000),
    buttons: z.array(buttonSchema).min(1).max(MAX_BUTTONS),
    step1: z.string().max(3000),
    quick: z.string().max(40),
    soldout: z.string().max(3000),
  }),
  reply: z.object({
    on: z.boolean(),
    when: z.enum(["dm", "all"]),
    texts: z.array(z.string().max(300)).max(MAX_REPLIES),
  }),
  period: z.object({ days: z.number().int().min(1).max(90), backfill: z.boolean() }),
});

export type AutomationConfig = z.infer<typeof configSchema>;
export type ButtonConfig = z.infer<typeof buttonSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// 기본 문구 (시안과 같다). 키워드 · 상품명 뒤에는 조사를 붙이지 않는다 — 받침에 따라 틀어져서.

export const FIRST_KEYWORD = "{상품명} 구매 링크가 필요하면 댓글로 {키워드} 남겨 주세요. DM으로 보내 드려요.";
export const FIRST_ALL = "댓글 남겨 주시면 {상품명} 구매 링크를 DM으로 보내 드려요.";
export const FIRST_YOUTUBE = "{상품명} 구매 링크는 채널 프로필에 있어요. 궁금하면 댓글로 {키워드} 남겨 주세요.";
export const DM_TEXT = "요청하신 {상품명} 링크예요.\n{상품링크}\n궁금한 점은 이 대화로 남겨 주세요.";
export const DM_BUTTON_TEXT = "요청하신 {상품명} 링크예요.\n아래 버튼을 눌러 주세요.";
export const DM_STEP1 = "{아이디}님, 댓글 고마워요.\n아래 버튼을 누르면 {상품명} 링크를 보내 드려요.";
export const QUICK_LABEL = "링크 받기";
export const INSTAGRAM_REPLIES = [
  "DM으로 보내 드렸어요. 메시지 요청함도 확인해 주세요.",
  "보내 드렸어요! 안 보이면 메시지 요청함을 확인해 주세요.",
  "DM 확인해 주세요. 링크 넣어 뒀어요.",
];
export const YOUTUBE_REPLIES = [
  "{상품명} 구매 링크는 채널 프로필에 있어요.",
  "관심 가져 주셔서 고마워요. 링크는 채널 프로필에서 볼 수 있어요.",
  "채널 프로필 링크에서 {상품명} 정보를 볼 수 있어요.",
];

export function defaultConfig(
  platform: AutomationPlatform,
  opts: { keyword?: string | null; hasProduct?: boolean } = {},
): AutomationConfig {
  const yt = platform === "YOUTUBE";
  const c: AutomationConfig = {
    preset: "link",
    first: { on: true, text: yt ? FIRST_YOUTUBE : FIRST_KEYWORD },
    trig: {
      mode: "keyword",
      keywords: opts.keyword ? [opts.keyword] : [],
      match: "contains",
      exclude: ["광고", "홍보"],
      emojiOnly: true,
    },
    dm: {
      on: !yt,
      // 기본 형태: 버튼 메시지(사용자 결정, 2026-11-27). 실측에서 첫 DM 버튼이 거절되면
      // DEFAULT_DM_FORMAT을 "twostep"으로 바꾼다 — 화면 기본값이 여기 한 곳에서 나온다.
      format: DEFAULT_DM_FORMAT,
      text: DM_TEXT,
      btnText: DM_BUTTON_TEXT,
      buttons: [{ label: "구매하러 가기", link: opts.hasProduct === false ? "home" : "product", url: "" }],
      step1: DM_STEP1,
      quick: QUICK_LABEL,
      soldout: "",
    },
    reply: { on: true, when: yt ? "all" : "dm", texts: [...(yt ? YOUTUBE_REPLIES : INSTAGRAM_REPLIES)] },
    period: { days: 7, backfill: false },
  };
  return c;
}

export const DEFAULT_DM_FORMAT: DmFormat = "button";

// "무엇을 할까요?" — 고르면 켜고 끄는 칸이 정해진다. 문구는 건드리지 않는다.
export function applyPreset(c: AutomationConfig, preset: Preset, platform: AutomationPlatform): AutomationConfig {
  const yt = platform === "YOUTUBE";
  const next = structuredClone(c);
  next.preset = preset;
  if (preset === "link") {
    next.first.on = true;
    next.dm.on = !yt;
    next.reply.on = true;
    next.reply.when = yt ? "all" : "dm";
    next.trig.mode = "keyword";
  } else if (preset === "comment") {
    next.first.on = true;
    next.dm.on = false;
    next.reply.on = false;
  }
  return next;
}

// 유튜브는 DM이 없다 — 저장 전에 항상 끈다.
export function normalizeForPlatform(c: AutomationConfig, platform: AutomationPlatform): AutomationConfig {
  if (platform !== "YOUTUBE") return c;
  return { ...c, dm: { ...c.dm, on: false }, reply: { ...c.reply, when: "all" } };
}

export const isTriggerRelevant = (c: AutomationConfig) => c.dm.on || c.reply.on;
// 답글을 누구에게 다는지 — DM이 꺼져 있으면 반응한 댓글 모두에
export const effectiveReplyWhen = (c: AutomationConfig) => (c.dm.on ? c.reply.when : "all");

// ─────────────────────────────────────────────────────────────────────────────
// 문구 채우기

export interface RenderContext {
  productName?: string | null;
  productUrl?: string | null; // 상품 페이지 (utm 붙인 주소)
  username?: string | null; // 댓글 단 사람 (없으면 {아이디}님 → 고객님)
}

export function firstKeyword(c: AutomationConfig): string {
  return c.trig.mode === "keyword" && c.trig.keywords[0] ? `'${c.trig.keywords[0]}'` : "";
}

export function renderText(c: AutomationConfig, text: string, ctx: RenderContext): string {
  const user = ctx.username ? `@${ctx.username.replace(/^@/, "")}` : "고객";
  return text
    .replaceAll("{키워드}", firstKeyword(c))
    .replaceAll("{상품명}", ctx.productName ?? "상품")
    .replaceAll("{상품링크}", ctx.productUrl ?? "")
    .replaceAll("{아이디}", user)
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;
export const charCount = (s: string) => [...s].length;

// 상품 링크에 붙이는 표시 — 몰 통계에서 DM 유입을 나눠 본다.
export function withUtm(url: string, platform: AutomationPlatform, medium: "dm" | "comment", campaign?: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("utm_source", platform === "YOUTUBE" ? "youtube" : "instagram");
    u.searchParams.set("utm_medium", medium);
    if (campaign) u.searchParams.set("utm_campaign", campaign);
    return u.toString();
  } catch {
    return url;
  }
}

// 몰 첫 화면 = 상품 주소의 origin
export function shopHomeUrl(productUrl: string | null | undefined): string | null {
  if (!productUrl) return null;
  try {
    return new URL(productUrl).origin;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 검사 — 켜기 · 저장 전에. 칸 이름(first · trig · dm · reply · period · product)별 문구.

export type ConfigErrorKey = "first" | "trig" | "dm" | "reply" | "period" | "product";
export type ConfigErrors = Partial<Record<ConfigErrorKey, string>>;

export interface ValidateContext {
  platform: AutomationPlatform;
  product: { name: string; url: string; soldOut: boolean } | null;
}

export function validateConfig(c: AutomationConfig, ctx: ValidateContext): ConfigErrors {
  const E: ConfigErrors = {};
  const p = ctx.product;
  const sample: RenderContext = { productName: p?.name ?? "상품", productUrl: p ? withUtm(p.url, ctx.platform, "dm") : "", username: "sample_user" };

  if (!c.first.on && !c.dm.on && !c.reply.on) E.first = "켜진 기능이 없어요. 하나 이상 켜 주세요.";
  if (c.first.on && !c.first.text.trim()) E.first = "첫 댓글 문구를 넣어 주세요.";
  if (isTriggerRelevant(c) && c.trig.mode === "keyword" && c.trig.keywords.length === 0) {
    E.trig = "반응할 키워드를 하나 이상 넣어 주세요.";
  }

  if (c.dm.on && ctx.platform === "INSTAGRAM") {
    const d = c.dm;
    if (d.format === "text") {
      if (!d.text.trim()) E.dm = "보낼 DM 문구를 넣어 주세요.";
      else if (utf8Bytes(renderText(c, d.text, sample)) > DM_TEXT_MAX_BYTES) {
        E.dm = "DM은 1,000바이트(한글 약 330자)까지 보낼 수 있어요. 문구를 줄여 주세요.";
      }
    } else {
      if (d.format === "twostep") {
        if (!d.step1.trim()) E.dm = "첫 DM 글을 넣어 주세요.";
        else if (utf8Bytes(renderText(c, d.step1, sample)) > DM_TEXT_MAX_BYTES) E.dm = "첫 DM은 1,000바이트(한글 약 330자)까지 보낼 수 있어요.";
        else if (!d.quick.trim()) E.dm = "빠른 답장 버튼 이름을 넣어 주세요.";
        else if (charCount(d.quick.trim()) > QUICK_LABEL_MAX) E.dm = "빠른 답장 버튼 이름은 20자까지예요.";
      }
      if (!E.dm) {
        if (!d.btnText.trim()) E.dm = "버튼 위에 보일 글을 넣어 주세요.";
        else if (charCount(renderText(c, d.btnText, sample)) > BUTTON_TEXT_MAX_CHARS) E.dm = "버튼 메시지 글은 640자까지 보낼 수 있어요.";
        else if (d.buttons.some((b) => !b.label.trim())) E.dm = "버튼 이름을 넣어 주세요.";
        else if (d.buttons.some((b) => charCount(b.label.trim()) > BUTTON_LABEL_MAX)) E.dm = "버튼 이름은 20자까지예요.";
        else if (d.buttons.some((b) => b.link !== "custom") && !p) {
          E.dm = "상품 페이지 · 몰 첫 화면 버튼이 있어요. 상품을 골라 주세요.";
          E.product = "버튼에 연결할 상품을 골라 주세요.";
        } else if (d.buttons.some((b) => b.link === "custom" && !/^https:\/\/\S+\.\S+/.test(b.url.trim()))) {
          E.dm = "직접 입력한 버튼 링크를 https://로 시작하게 넣어 주세요.";
        }
      }
    }
    const used = d.format === "text" ? d.text : d.format === "twostep" ? d.step1 + d.btnText : d.btnText;
    if (!E.dm && !p && /\{상품(명|링크)\}/.test(used)) {
      E.dm = "문구에 상품이 들어 있어요. 상품을 골라 주세요.";
      E.product = "DM 문구에 쓸 상품을 골라 주세요.";
    }
    if (!E.dm && p?.soldOut && !d.soldout.trim()) {
      E.dm = "상품이 품절이에요. 품절 안내 문구를 넣거나 다른 상품을 골라 주세요.";
    }
  }

  if (c.reply.on && !c.reply.texts.some((t) => t.trim())) E.reply = "답글 문구를 하나 이상 넣어 주세요.";
  if (c.period.days < 1 || c.period.days > 90) E.period = "기간은 1~90일로 정해 주세요.";
  return E;
}
