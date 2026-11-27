import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse, after } from "next/server";
import {
  findActiveAutomation,
  handleIncomingComment,
  handleQuickReply,
  processEvent,
} from "@/lib/post-automations/server";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";

// 인스타 웹훅 (Instagram 로그인 앱) — 게시물 댓글 · DM 자동화(0062).
//   GET   Meta 앱 대시보드에서 주소를 등록할 때 한 번 확인 (hub.verify_token = INSTAGRAM_WEBHOOK_VERIFY_TOKEN)
//   POST  comments(새 댓글) · messages(빠른 답장) · messaging_postbacks
// 서명(X-Hub-Signature-256)을 INSTAGRAM_APP_SECRET으로 확인하고, 원본을 instagram_webhook_inbox에 남긴 뒤
// 바로 200을 돌려준다. 발송은 응답 뒤(after)에 한다 — Meta는 응답이 늦으면 같은 알림을 다시 보낸다.
// 여기서 처리가 실패해도 cron(/api/cron/post-automations)이 5분 안에 새 댓글을 직접 찾아 보낸다.

export const maxDuration = 60;

export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  const expected = process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN;
  if (expected && sp.get("hub.mode") === "subscribe" && sp.get("hub.verify_token") === expected) {
    return new Response(sp.get("hub.challenge") ?? "", { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return new Response("forbidden", { status: 403 });
}

function validSignature(raw: string, header: string | null, secret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const got = Buffer.from(header.slice("sha256=".length), "hex");
  const want = createHmac("sha256", secret).update(raw, "utf8").digest();
  return got.length === want.length && timingSafeEqual(got, want);
}

interface CommentValue {
  id?: string;
  text?: string;
  parent_id?: string;
  from?: { id?: string; username?: string };
  media?: { id?: string };
}

interface MessagingItem {
  sender?: { id?: string };
  recipient?: { id?: string };
  message?: { is_echo?: boolean; quick_reply?: { payload?: string } };
  postback?: { payload?: string };
}

interface WebhookBody {
  object?: string;
  entry?: Array<{
    id?: string;
    time?: number;
    changes?: Array<{ field?: string; value?: CommentValue }>;
    messaging?: MessagingItem[];
  }>;
}

export async function POST(request: Request) {
  const secret = process.env.INSTAGRAM_APP_SECRET;
  if (!secret) return NextResponse.json({ error: "INSTAGRAM_APP_SECRET not configured" }, { status: 500 });

  const raw = await request.text();
  if (!validSignature(raw, request.headers.get("x-hub-signature-256"), secret)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }
  let body: WebhookBody;
  try {
    body = JSON.parse(raw) as WebhookBody;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const service = createServiceClient();
  const entries = body.entry ?? [];
  const firstField = entries[0]?.changes?.[0]?.field ?? (entries[0]?.messaging ? "messaging" : null);
  const { data: inbox } = await service
    .from("instagram_webhook_inbox")
    .insert({ object: body.object ?? null, ig_account_id: entries[0]?.id ?? null, field: firstField, payload: body as unknown as Json })
    .select("id")
    .maybeSingle();

  after(async () => {
    const results: string[] = [];
    for (const entry of entries) {
      const igAccountId = entry.id ?? "";
      for (const change of entry.changes ?? []) {
        if (change.field !== "comments" || !change.value) continue;
        results.push(await onComment(service, igAccountId, change.value));
      }
      for (const m of entry.messaging ?? []) {
        if (m.message?.is_echo) continue;
        const payload = m.message?.quick_reply?.payload ?? m.postback?.payload;
        if (!payload || !m.sender?.id) continue;
        try {
          results.push(await handleQuickReply(service, { igAccountId, senderId: m.sender.id, payload }));
        } catch (err) {
          results.push(`빠른 답장 처리 실패: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    if (inbox?.id) {
      await service
        .from("instagram_webhook_inbox")
        .update({ processed_at: new Date().toISOString(), result: results.join(" | ").slice(0, 1000) || "대상 없음" })
        .eq("id", inbox.id);
    }
  });

  return NextResponse.json({ ok: true });
}

async function onComment(service: ReturnType<typeof createServiceClient>, igAccountId: string, v: CommentValue): Promise<string> {
  if (!v.id || !v.media?.id) return "댓글 정보 없음";
  try {
    const automation = await findActiveAutomation(service, igAccountId, v.media.id);
    if (!automation) return "켜진 게시물 아님";
    const eventId = await handleIncomingComment(
      service,
      automation,
      {
        id: v.id,
        text: v.text ?? "",
        fromId: v.from?.id ?? null,
        username: v.from?.username ?? null,
        timestamp: null, // 웹훅은 바로 온다 — 받은 시각을 댓글 시각으로
        parentId: v.parent_id ?? null,
      },
      "WEBHOOK",
    );
    if (!eventId) return "반응 안 함";
    return await processEvent(service, eventId);
  } catch (err) {
    return `처리 실패: ${err instanceof Error ? err.message : String(err)}`;
  }
}
