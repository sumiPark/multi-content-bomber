import "./server-guard";
import { InstagramApiError, instagramRequest } from "./instagram-comments";

// 게시물 댓글 · DM 자동화용 인스타 메시지 · 첫 댓글 API (Instagram 로그인, graph.instagram.com).
//
// 공식 문서 (2026-11-27 확인):
//   - 댓글 기반 DM(private reply): POST /<IG_ID>/messages  recipient.comment_id
//     권한 표: Instagram 로그인은 instagram_business_basic + instagram_business_manage_comments.
//     (메시지 문서는 /messages에 instagram_business_manage_messages를 요구 — 실측으로 확인)
//     댓글 하나에 한 번 · 댓글이 달리고 7일 안 · 예시는 글자뿐(버튼 허용 여부는 문서에 없음)
//   - 일반 DM: recipient.id(IGSID). 고객이 메시지 · 빠른 답장을 보낸 뒤 24시간 안
//   - 버튼 메시지: template_type "button", 글 640자, 버튼 1~3개(web_url · postback)
//   - 빠른 답장: content_type "text", 최대 13개, 20자에서 잘림. 누르면 messages 웹훅으로 payload가 온다
//   - 글자 메시지 1,000바이트

const GRAPH_API_BASE = "https://graph.instagram.com/v23.0";

export type OutgoingMessage =
  | { kind: "text"; text: string }
  | { kind: "button"; text: string; buttons: Array<{ title: string; url: string }> }
  | { kind: "quick"; text: string; quickReplies: Array<{ title: string; payload: string }> };

function toGraphMessage(m: OutgoingMessage): Record<string, unknown> {
  if (m.kind === "text") return { text: m.text };
  if (m.kind === "quick") {
    return {
      text: m.text,
      quick_replies: m.quickReplies.map((q) => ({ content_type: "text", title: q.title, payload: q.payload })),
    };
  }
  return {
    attachment: {
      type: "template",
      payload: {
        template_type: "button",
        text: m.text,
        buttons: m.buttons.map((b) => ({ type: "web_url", url: b.url, title: b.title })),
      },
    },
  };
}

// 보낸 결과. UNKNOWN = 요청은 나갔는데 응답을 못 받음(네트워크 · 서버 오류) — 갔을 수도 있어 다시 보내지 않는다.
export type SendOutcome =
  | { ok: true; messageId: string | null; recipientId: string | null }
  | { ok: false; unknown: true; error: string }
  | { ok: false; unknown: false; error: string; apiError: InstagramApiError };

async function postMessage(igUserId: string, token: string, recipient: Record<string, string>, message: OutgoingMessage): Promise<SendOutcome> {
  try {
    const res = await instagramRequest<{ recipient_id?: string; message_id?: string }>(
      `${GRAPH_API_BASE}/${igUserId}/messages?access_token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipient, message: toGraphMessage(message) }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    return { ok: true, messageId: res.message_id ?? null, recipientId: res.recipient_id ?? null };
  } catch (err) {
    if (err instanceof InstagramApiError) {
      // 5xx는 인스타 쪽에서 처리됐는지 알 수 없다
      if (err.status >= 500) return { ok: false, unknown: true, error: err.message };
      return { ok: false, unknown: false, error: err.message, apiError: err };
    }
    // 시간 초과 · 연결 끊김
    return { ok: false, unknown: true, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 댓글 기반 첫 DM (private reply) */
export function sendPrivateReply(igUserId: string, token: string, commentId: string, message: OutgoingMessage) {
  return postMessage(igUserId, token, { comment_id: commentId }, message);
}

/** 대화가 열린 사람에게 보내는 DM (두 단계의 두 번째 메시지) */
export function sendDirectMessage(igUserId: string, token: string, recipientIgsid: string, message: OutgoingMessage) {
  return postMessage(igUserId, token, { id: recipientIgsid }, message);
}

/**
 * 버튼 · 빠른 답장 형태 자체가 거절된 것으로 보이는지 — 그러면 같은 내용을 글자 + 링크로 다시 보낸다.
 * 첫 DM 템플릿 허용 여부가 문서에 없어 정확한 코드는 실측 전이다. 잘못된 매개변수(100)이면서
 * 대상이 없다는 뜻(33)이 아니면 형태 문제로 본다. 토큰 · 한도 · 차단은 형태 문제가 아니다.
 */
export function looksLikeFormatRejected(err: InstagramApiError): boolean {
  if (err.kind === "TOKEN" || err.kind === "RATE_LIMIT" || err.kind === "BLOCKED" || err.kind === "NOT_FOUND") return false;
  if (err.code === 100) return true;
  return /template|quick_repl|attachment|payload|not supported|unsupported/i.test(err.message);
}

/** 게시물에 우리 계정 댓글 달기 (첫 댓글) */
export async function postMediaComment(mediaId: string, message: string, token: string): Promise<{ id: string }> {
  const body = new URLSearchParams({ message, access_token: token });
  return instagramRequest<{ id: string }>(`${GRAPH_API_BASE}/${mediaId}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
}

/** 계정을 이 앱 웹훅(comments · messages)에 구독 — 계정마다 한 번. 이미 구독돼 있어도 성공한다. */
export async function subscribeAccountWebhooks(token: string): Promise<boolean> {
  const url = new URL(`${GRAPH_API_BASE}/me/subscribed_apps`);
  url.searchParams.set("subscribed_fields", "comments,messages,messaging_postbacks");
  url.searchParams.set("access_token", token);
  const res = await instagramRequest<{ success?: boolean }>(url.toString(), { method: "POST" });
  return res.success === true;
}

export async function getSubscribedFields(token: string): Promise<string[]> {
  const url = new URL(`${GRAPH_API_BASE}/me/subscribed_apps`);
  url.searchParams.set("access_token", token);
  const res = await instagramRequest<{ data?: Array<{ subscribed_fields?: string[] }> }>(url.toString());
  return res.data?.flatMap((d) => d.subscribed_fields ?? []) ?? [];
}
