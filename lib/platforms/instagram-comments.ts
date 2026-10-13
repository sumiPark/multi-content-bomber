import "./server-guard";

// 시리즈 댓글 자동화용 인스타 댓글 API (Instagram 로그인, graph.instagram.com).
// 권한: instagram_business_basic + instagram_business_manage_comments (이미 OAuth 요청 목록에 있음).
//
// 발행 어댑터(instagram.ts)와 분리한 이유: 발행 에러는 Publish/RateLimited/TokenExpired
// 세 갈래면 충분하지만, 답글은 "잠시 제한됨(368)"과 "댓글이 지워짐(100/33)"을 따로 다뤄야
// 작업 전체를 멈출지 그 댓글만 건너뛸지 정할 수 있다.
//
// 공식 제약 (Meta 문서):
//   - GET /{media}/comments: 최상위 댓글만, 최신순, 한 번에 최대 50개, 날짜 필터 불가
//     ⚠️ 실측(2026-10-13, 댓글 653개 릴스): 문서와 달리 계정 주인이 단 답글도 parent_id가
//     채워진 채 목록에 섞여 내려온다. 반대로 replies{...} 펼치기는 id·timestamp만 줘서 답글
//     작성자를 알 수 없다. 그래서 parent_id로 답글을 골라내고, 내 답글은 이걸로 판별한다.
//     또 댓글의 from.id는 /me의 id가 아니라 user_id와 같다.
//   - POST /{comment}/replies: 최상위 댓글에만. 숨긴 댓글·라이브 댓글 불가
//   - 호출 한도: 계정마다 24시간 4800 × 노출 수 (초과 시 80002)

const GRAPH_API_BASE = "https://graph.instagram.com/v23.0";

// 한 게시물에서 댓글을 끝까지 가져올 때의 안전 상한 (50 × 200 = 1만 개).
const MAX_COMMENT_PAGES = 200;

export type InstagramErrorKind =
  | "TOKEN" // 토큰 만료/무효 — 재연결 필요
  | "RATE_LIMIT" // 호출 한도 — 잠시 뒤 재시도
  | "BLOCKED" // 인스타가 활동을 일시 제한(368) — 하루쯤 쉬어야 함
  | "NOT_FOUND" // 댓글/게시물이 없거나 답글 불가 — 그 건만 건너뜀
  | "OTHER";

export class InstagramApiError extends Error {
  constructor(
    message: string,
    readonly kind: InstagramErrorKind,
    readonly status: number,
    readonly code?: number,
    readonly subcode?: number,
  ) {
    super(message);
    this.name = "InstagramApiError";
  }
}

interface GraphErrorBody {
  error?: { message?: string; code?: number; error_subcode?: number };
}

function toError(status: number, body: string): InstagramApiError {
  let parsed: GraphErrorBody | null = null;
  try {
    parsed = JSON.parse(body) as GraphErrorBody;
  } catch {
    // 그대로
  }
  const code = parsed?.error?.code;
  const subcode = parsed?.error?.error_subcode;
  const message = parsed?.error?.message ?? body.slice(0, 300);

  let kind: InstagramErrorKind = "OTHER";
  if (status === 401 || code === 190 || code === 102) kind = "TOKEN";
  else if (status === 429 || [4, 17, 32, 613, 80002].includes(code ?? -1)) {
    kind = "RATE_LIMIT";
  } else if (code === 368) kind = "BLOCKED";
  // 100/33 = 대상 객체가 없거나(삭제) 이 작업을 지원하지 않음.
  else if (code === 100 && subcode === 33) kind = "NOT_FOUND";
  return new InstagramApiError(message, kind, status, code, subcode);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw toError(res.status, await res.text());
  return (await res.json()) as T;
}

function getUrl(path: string, token: string, params: Record<string, string>) {
  const url = new URL(`${GRAPH_API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", token);
  return url.toString();
}

// ─────────────────────────────────────────────────────────────────────────────

export interface InstagramMe {
  id: string;
  userId: string | null;
  username: string;
}

// 내 댓글을 걸러낼 때 쓴다. social_accounts.platform_account_id(= /me의 id)와
// 댓글 from.id의 ID 체계가 다를 수 있어 id와 user_id를 둘 다 받아둔다.
export async function getInstagramMe(token: string): Promise<InstagramMe> {
  const data = await request<{ id: string; user_id?: string | number; username: string }>(
    getUrl("/me", token, { fields: "id,user_id,username" }),
  );
  return {
    id: String(data.id),
    userId: data.user_id != null ? String(data.user_id) : null,
    username: data.username,
  };
}

export interface InstagramMedia {
  id: string;
  caption: string | null;
  mediaType: string;
  mediaProductType: string | null;
  previewUrl: string | null;
  permalink: string | null;
  timestamp: string;
  commentsCount: number | null;
}

const MEDIA_FIELDS =
  "id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,comments_count";

interface RawMedia {
  id: string;
  caption?: string;
  media_type: string;
  media_product_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp: string;
  comments_count?: number;
}

function toMedia(m: RawMedia): InstagramMedia {
  return {
    id: m.id,
    caption: m.caption ?? null,
    mediaType: m.media_type,
    mediaProductType: m.media_product_type ?? null,
    // 영상은 thumbnail_url, 이미지·캐러셀은 media_url이 미리보기. 인스타 CDN 주소라
    // 며칠 뒤 만료되므로 DB에 저장하지 않고 화면 표시용으로만 쓴다.
    previewUrl: m.thumbnail_url ?? m.media_url ?? null,
    permalink: m.permalink ?? null,
    timestamp: m.timestamp,
    commentsCount: m.comments_count ?? null,
  };
}

export async function listInstagramMedia(
  token: string,
  opts: { after?: string | null; limit?: number } = {},
): Promise<{ items: InstagramMedia[]; nextCursor: string | null }> {
  const params: Record<string, string> = {
    fields: MEDIA_FIELDS,
    limit: String(opts.limit ?? 24),
  };
  if (opts.after) params.after = opts.after;
  const data = await request<{
    data: RawMedia[];
    paging?: { cursors?: { after?: string }; next?: string };
  }>(getUrl("/me/media", token, params));
  return {
    items: data.data.map(toMedia),
    nextCursor: data.paging?.next ? (data.paging.cursors?.after ?? null) : null,
  };
}

export async function getInstagramMedia(
  mediaId: string,
  token: string,
): Promise<InstagramMedia> {
  const data = await request<RawMedia>(
    getUrl(`/${mediaId}`, token, { fields: MEDIA_FIELDS }),
  );
  return toMedia(data);
}

export interface InstagramComment {
  id: string;
  text: string;
  timestamp: string;
  fromId: string | null;
  username: string | null;
  hidden: boolean;
  // 답글이면 원 댓글 id. 최상위 댓글이면 null.
  parentId: string | null;
}

interface RawComment {
  id: string;
  text?: string;
  timestamp: string;
  username?: string;
  from?: { id?: string; username?: string };
  hidden?: boolean;
  parent_id?: string;
}

// 댓글을 마지막 페이지까지 가져온다 (최신순). 계정 주인의 답글도 parentId와 함께 섞여 온다.
export async function listAllComments(
  mediaId: string,
  token: string,
): Promise<InstagramComment[]> {
  const out: InstagramComment[] = [];
  let url: string | null = getUrl(`/${mediaId}/comments`, token, {
    fields: "id,text,timestamp,username,from,hidden,parent_id",
    limit: "50",
  });
  for (let page = 0; url && page < MAX_COMMENT_PAGES; page++) {
    const data: { data: RawComment[]; paging?: { next?: string } } =
      await request(url);
    for (const c of data.data) {
      out.push({
        id: c.id,
        text: c.text ?? "",
        timestamp: c.timestamp,
        fromId: c.from?.id ?? null,
        username: c.username ?? c.from?.username ?? null,
        hidden: c.hidden === true,
        parentId: c.parent_id ?? null,
      });
    }
    // paging.next에는 access_token이 이미 들어 있다.
    url = data.paging?.next ?? null;
  }
  return out;
}

export async function replyToComment(
  commentId: string,
  message: string,
  token: string,
): Promise<{ id: string }> {
  const body = new URLSearchParams({ message, access_token: token });
  return request<{ id: string }>(`${GRAPH_API_BASE}/${commentId}/replies`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
}
