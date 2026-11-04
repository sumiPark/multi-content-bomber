import "@/lib/platforms/server-guard";
import { instagramRequest } from "@/lib/platforms/instagram-comments";

// 다른 계정 읽기 — Meta Business Discovery (graph.facebook.com, 시스템 사용자 mcb 키).
//
// 2026-11-04 실측: 조회수 · 좋아요 · 댓글 · 리포스트 · 캡션 · 게시 시각 · 표지는 읽히고,
// saved_count · shares_count는 거절된다. 비즈니스 · 크리에이터 계정만 조회된다.
// 호출 한도: 한 시간에 약 400번 조회하니 #4(Application request limit)로 막혔다 — 워커가 횟수를 제한한다.
// 최근 게시물 50개면 "평소"를 잡는 데 충분해서 다음 페이지는 읽지 않는다.

const API_BASE = "https://graph.facebook.com/v26.0";
const MEDIA_LIMIT = 50;
// 평소 조회수는 최근 릴스 이만큼의 중앙값 (ig-viral-ko 기준)
const BASELINE_REELS = 12;
// 이 비율 아래면 광고로 키운 것으로 추정 — 2026-11-04 실측: 동원 1,357만 회에 좋아요 11개, 아비브 455만 회에 4,488개.
// 좋아요를 숨긴 게시물은 판단하지 않는다.
const AD_LIKE_RATE = 0.001;
export const HIT_MULTIPLE = 3;

export interface BenchmarkMedia {
  id: string;
  media_product_type?: string;
  view_count?: number;
  like_count?: number;
  comments_count?: number;
  reposts_count?: number;
  timestamp?: string;
  caption?: string;
  permalink?: string;
  thumbnail_url?: string;
  media_url?: string;
}

export interface BenchmarkProfile {
  username: string;
  name?: string;
  biography?: string;
  followers_count?: number;
  media_count?: number;
  media?: { data?: BenchmarkMedia[] };
}

export async function readBenchmarkAccount(token: string, baseIgId: string, username: string): Promise<BenchmarkProfile> {
  const media = `media.limit(${MEDIA_LIMIT}){id,media_product_type,view_count,like_count,comments_count,reposts_count,timestamp,caption,permalink,thumbnail_url,media_url}`;
  const url = new URL(`${API_BASE}/${baseIgId}`);
  url.searchParams.set("fields", `business_discovery.username(${username}){username,name,biography,followers_count,media_count,${media}}`);
  url.searchParams.set("access_token", token);
  const res = await instagramRequest<{ business_discovery: BenchmarkProfile }>(url.toString());
  return res.business_discovery;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export function isAdSuspected(m: Pick<BenchmarkMedia, "view_count" | "like_count">): boolean {
  if (!m.view_count || m.like_count == null) return false;
  return m.like_count / m.view_count < AD_LIKE_RATE;
}

/** 평소 조회수 — 최근 릴스의 중앙값. 광고로 키운 것으로 보이는 릴스는 뺀다. */
export function baselineViews(media: BenchmarkMedia[]): { median: number | null; sampled: number } {
  const reels = media.filter((m) => m.media_product_type === "REELS" && typeof m.view_count === "number" && !isAdSuspected(m)).slice(0, BASELINE_REELS);
  return { median: median(reels.map((m) => m.view_count as number)), sampled: reels.length };
}

/** 캡션 첫 줄 — 영상 첫 마디는 API에 없어 대신 쓴다. */
export function firstLine(caption: string | null | undefined): string {
  return (caption ?? "").split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 120) ?? "";
}
