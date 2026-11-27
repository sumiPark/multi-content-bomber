import { createHash } from "node:crypto";
import { SHOPS, productUrl, type ShopCode } from "@/lib/products/shops";

// 모아링크 방문 · 클릭 기록 도우미 (서버 전용).
// 개인정보를 저장하지 않는다: IP · 브라우저 정보는 하루 단위로 바뀌는 값과 함께 해시해 방문자 수 추정에만 쓴다.

// 링크 미리보기 · 검색 로봇 · 점검 도구는 집계에서 제외한다
const BOT_RE =
  /bot|crawl|spider|slurp|preview|facebookexternalhit|meta-externalagent|kakaotalk-scrap|yeti|daum|bingpreview|headless|lighthouse|pingdom|uptime|curl|wget|python|node-fetch|axios|go-http|java\//i;

export function isBot(ua: string | null): boolean {
  return !ua || BOT_RE.test(ua);
}

/** 유입 경로 — 인스타 · 스레드 · 페이스북 앱 안 브라우저는 User-Agent로, 나머지는 referrer로 */
export function detectSource(ua: string | null, referrer: string | null): string {
  const u = ua ?? "";
  if (/Barcelona|Threads/i.test(u)) return "threads";
  if (/Instagram/i.test(u)) return "instagram";
  if (/FBAN|FBAV|FB_IAB/i.test(u)) return "facebook";
  if (/KAKAOTALK/i.test(u)) return "kakao";
  if (!referrer) return "direct";
  let host = "";
  try {
    host = new URL(referrer).hostname.toLowerCase();
  } catch {
    return "other";
  }
  if (host.endsWith("instagram.com")) return "instagram";
  if (host.endsWith("threads.net") || host.endsWith("threads.com")) return "threads";
  if (host.endsWith("facebook.com")) return "facebook";
  if (host.includes("kakao")) return "kakao";
  if (host.endsWith("youtube.com") || host === "youtu.be") return "youtube";
  if (host.endsWith("naver.com")) return "naver";
  if (host.endsWith("cuma.co.kr")) return "direct";
  return "other";
}

function kstDay(): string {
  return new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
}

export function visitorHash(ip: string | null, ua: string | null): string {
  const salt = process.env.MOA_HASH_SALT ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "moa";
  return createHash("sha256").update(`${kstDay()}|${ip ?? ""}|${ua ?? ""}|${salt}`).digest("hex").slice(0, 32);
}

export function clientIp(headers: Headers): string | null {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return headers.get("x-real-ip");
}

const SHOP_HOSTS = new Set(Object.values(SHOPS).map((s) => new URL(s.siteBase).hostname.replace(/^www\./, "")));

/**
 * 몰로 넘어갈 때 utm 꼬리표를 붙인다 (몰 분석에서도 계정을 구분하게).
 * 몰이 아닌 외부 링크와 이미 utm이 붙은 링크는 그대로 둔다.
 */
export function withUtm(target: string, slug: string, campaign: string): string {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return target;
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, "");
  if (!SHOP_HOSTS.has(host) || u.searchParams.has("utm_source")) return target;
  u.searchParams.set("utm_source", "instagram");
  u.searchParams.set("utm_medium", "moa");
  u.searchParams.set("utm_campaign", slug);
  if (campaign) u.searchParams.set("utm_content", campaign);
  return u.toString();
}

/** 블록을 누르면 갈 주소 */
export function blockTarget(b: { kind: string; url: string | null; shop_code: string | null; shop_product_id: number | null }): string | null {
  if (b.url) return b.url;
  if (b.shop_code && b.shop_product_id != null && b.shop_code in SHOPS) return productUrl(b.shop_code as ShopCode, b.shop_product_id);
  return null;
}

/** 캠페인 값 정리 (?c=) */
export function cleanCampaign(v: string | null): string {
  return (v ?? "").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 40);
}

/** sessionStorage 난수 — 형식만 확인 */
export function cleanSession(v: unknown): string | null {
  return typeof v === "string" && /^[a-zA-Z0-9_-]{8,64}$/.test(v) ? v : null;
}
