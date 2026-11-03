import "@/lib/platforms/server-guard";
import { InstagramApiError, instagramRequest, listAllComments } from "@/lib/platforms/instagram-comments";
import { listRecentMedia, type InstagramMedia } from "@/lib/platforms/instagram-insights";

// 계정 점검 — 프로필 채점에 필요한 인스타 값 (Instagram 로그인, graph.instagram.com).
//
// 기본 권한(instagram_business_basic)으로 읽는다. 성과 권한은 필요 없다.
// 소개(biography) · 링크(website)는 API 판에 따라 안 줄 수 있어, 못 받으면 칸을 빼고 다시 묻는다 —
// 그때는 프로필 캡처에서 읽은 값으로 채운다. 하이라이트 · 고정 게시물 · 연락 버튼은 API에 아예 없다.
// 스토리는 "지금 떠 있는 것"만 보여서, 워커가 매일 세어 account_story_days(0035)에 쌓는다.

const GRAPH_API_BASE = "https://graph.instagram.com/v23.0";
const DAY_MS = 24 * 60 * 60_000;
// 피드 첫 9칸 + 답 안 한 댓글을 볼 최근 게시물
const GRID = 9;
const COMMENT_POSTS = 3;

const FIELD_SETS = [
  "user_id,username,name,account_type,biography,website,followers_count,media_count,profile_picture_url",
  "user_id,username,name,account_type,followers_count,media_count,profile_picture_url",
  "user_id,username,followers_count,media_count,profile_picture_url",
];

export interface ProfileDetails {
  username: string;
  name: string | null;
  biography: string | null;
  website: string | null;
  accountType: string | null;
  followersCount: number | null;
  mediaCount: number | null;
  profilePictureUrl: string | null;
  // API가 준 칸 — 안 준 칸은 사람 입력으로 채운다
  fields: string[];
  grid: Pick<InstagramMedia, "id" | "thumbnailUrl" | "caption" | "mediaProductType" | "timestamp">[];
  daysSinceLastPost: number | null;
  unansweredComments: number | null;
  // 지금 떠 있는 스토리 수 = 지난 24시간에 올린 것. 못 읽으면 null
  liveStories: number | null;
}

function url(path: string, token: string, params: Record<string, string>) {
  const u = new URL(`${GRAPH_API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("access_token", token);
  return u.toString();
}

type RawMe = {
  username: string;
  name?: string;
  account_type?: string;
  biography?: string;
  website?: string;
  followers_count?: number;
  media_count?: number;
  profile_picture_url?: string;
};

async function getMe(token: string): Promise<{ me: RawMe; fields: string[] }> {
  let last: unknown = null;
  for (const fields of FIELD_SETS) {
    try {
      const me = await instagramRequest<RawMe>(url("/me", token, { fields }));
      return { me, fields: fields.split(",") };
    } catch (err) {
      // 없는 칸(100)만 다음 묶음으로. 토큰 · 한도 에러는 그대로 던진다.
      if (!(err instanceof InstagramApiError) || err.kind !== "OTHER") throw err;
      last = err;
    }
  }
  throw last;
}

/** 최근 게시물 몇 개에서, 계정 주인이 답하지 않은 다른 사람 댓글 수. */
async function countUnanswered(token: string, handle: string, media: InstagramMedia[]): Promise<number | null> {
  const targets = media.filter((m) => (m.commentsCount ?? 0) > 0).slice(0, COMMENT_POSTS);
  if (targets.length === 0) return 0;
  let total = 0;
  for (const m of targets) {
    try {
      const comments = await listAllComments(m.id, token);
      const repliedTo = new Set(
        comments.filter((c) => c.parentId && c.username === handle).map((c) => c.parentId as string),
      );
      total += comments.filter((c) => !c.parentId && c.username !== handle && !c.hidden && !repliedTo.has(c.id)).length;
    } catch (err) {
      if (err instanceof InstagramApiError && (err.kind === "TOKEN" || err.kind === "RATE_LIMIT")) throw err;
      return null; // 댓글을 못 읽으면 모름으로
    }
  }
  return total;
}

/** 지금 떠 있는 스토리 수. 권한 · 판 차이로 못 읽으면 null(모름). */
async function countLiveStories(token: string): Promise<number | null> {
  try {
    const res = await instagramRequest<{ data: { id: string }[] }>(url("/me/stories", token, { fields: "id,timestamp" }));
    return res.data.length;
  } catch (err) {
    if (err instanceof InstagramApiError && (err.kind === "TOKEN" || err.kind === "RATE_LIMIT")) throw err;
    return null;
  }
}

export async function getProfileDetails(token: string, now = Date.now()): Promise<ProfileDetails> {
  const { me, fields } = await getMe(token);
  const media = await listRecentMedia(token, GRID);
  const lastAt = media[0]?.timestamp ? Date.parse(media[0].timestamp) : NaN;

  return {
    username: me.username,
    name: me.name ?? null,
    biography: me.biography ?? null,
    website: me.website ?? null,
    accountType: me.account_type ?? null,
    followersCount: me.followers_count ?? null,
    mediaCount: me.media_count ?? null,
    profilePictureUrl: me.profile_picture_url ?? null,
    fields,
    grid: media.map(({ id, thumbnailUrl, caption, mediaProductType, timestamp }) => ({
      id,
      thumbnailUrl,
      caption,
      mediaProductType,
      timestamp,
    })),
    daysSinceLastPost: Number.isFinite(lastAt) ? Math.max(0, Math.floor((now - lastAt) / DAY_MS)) : null,
    unansweredComments: await countUnanswered(token, me.username, media),
    liveStories: await countLiveStories(token),
  };
}
