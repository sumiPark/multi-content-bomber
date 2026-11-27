import { NextResponse } from "next/server";
import { z } from "zod";
import { cleanCampaign, cleanSession, clientIp, detectSource, isBot, visitorHash } from "@/lib/moa/track";
import { createServiceClient } from "@/lib/supabase/service";

// 모아링크 방문 · 노출 기록 받기 (components/moa/moa-tracker.tsx가 보낸다). 로그인 없이 열린 주소.
// 페이지 · 블록이 실제로 있는지 확인한 것만 넣고, 로봇은 버린다. 실패해도 방문자 화면에는 영향 없게 항상 204.

const bodySchema = z.object({
  pageId: z.string().uuid(),
  s: z.string().optional(),
  c: z.string().optional(),
  ref: z.string().max(1000).optional(),
  events: z
    .array(z.object({ kind: z.enum(["VIEW", "IMPRESSION"]), blockId: z.string().uuid().optional() }))
    .min(1)
    .max(60),
});

const noContent = () => new NextResponse(null, { status: 204 });

export async function POST(request: Request) {
  const ua = request.headers.get("user-agent");
  if (isBot(ua)) return noContent();

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(JSON.parse(await request.text()));
  } catch {
    return noContent();
  }

  try {
    const service = createServiceClient();
    const { data: page } = await service.from("moa_pages").select("id, status").eq("id", body.pageId).maybeSingle();
    if (!page || page.status !== "PUBLISHED") return noContent();

    const blockIds = [...new Set(body.events.map((e) => e.blockId).filter((v): v is string => !!v))];
    let valid = new Set<string>();
    if (blockIds.length > 0) {
      const { data: blocks } = await service.from("moa_blocks").select("id").eq("page_id", page.id).in("id", blockIds);
      valid = new Set((blocks ?? []).map((b) => b.id));
    }

    const session = cleanSession(body.s);
    const visitor = visitorHash(clientIp(request.headers), ua);
    const source = detectSource(ua, body.ref || null);
    const campaign = cleanCampaign(body.c ?? null);
    const rows = body.events
      .filter((e) => (e.kind === "VIEW" ? true : !!e.blockId && valid.has(e.blockId)))
      // 노출은 방문 표시가 있어야 방문당 한 번으로 셀 수 있다
      .filter((e) => e.kind === "VIEW" || !!session)
      .map((e) => ({
        page_id: page.id,
        block_id: e.kind === "VIEW" ? "" : e.blockId,
        kind: e.kind,
        session_id: session ?? "",
        visitor_hash: visitor,
        source,
        campaign,
      }));
    if (rows.length > 0) {
      const { error } = await service.rpc("moa_record_events", { p_rows: rows });
      if (error) console.error("[moa/e] 기록 실패:", error.message);
    }
  } catch (err) {
    console.error("[moa/e]", err);
  }
  return noContent();
}
