import { NextResponse, after, type NextRequest } from "next/server";
import { inSchedule, saleDisplay } from "@/lib/moa/status";
import { MOA_HOST, publicUrl } from "@/lib/moa/slug";
import { blockTarget, cleanCampaign, cleanSession, clientIp, detectSource, isBot, visitorHash, withUtm } from "@/lib/moa/track";
import { parseBlockData } from "@/lib/moa/types";
import { createServiceClient } from "@/lib/supabase/service";

// 모아링크 클릭 — 기록하고 목적지로 보낸다 (moa.cuma.co.kr/r/<블록>은 proxy가 여기로 넘긴다).
// 서버가 기록하므로 스크립트가 막힌 브라우저에서도 클릭이 빠지지 않는다. 기록은 응답을 보낸 뒤(after) 넣는다.
//   ?i=  SOCIAL 블록의 몇 번째 버튼인지
//   ?s=  방문 표시(sessionStorage), ?c= 캠페인 링크 값

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest, ctx: { params: Promise<{ blockId: string }> }) {
  const { blockId } = await ctx.params;
  const fallback = new URL("/", request.url);
  if (!UUID_RE.test(blockId)) return NextResponse.redirect(fallback, 302);

  const service = createServiceClient();
  const { data: block } = await service
    .from("moa_blocks")
    .select("id, page_id, kind, url, shop_code, shop_product_id, data, enabled, starts_at, ends_at, deleted_at")
    .eq("id", blockId)
    .maybeSingle();
  if (!block) return NextResponse.redirect(fallback, 302);

  const { data: page } = await service.from("moa_pages").select("id, slug, status, hide_sold_out").eq("id", block.page_id).maybeSingle();
  if (!page) return NextResponse.redirect(fallback, 302);
  // 돌려보낼 페이지 — 들어온 도메인 그대로(공개 도메인 연결 전 앱 도메인 /m/ 시험도 되게)
  const host = (request.headers.get("host") ?? "").toLowerCase().split(":")[0];
  const pageUrl = host === MOA_HOST ? publicUrl(page.slug) : new URL(`/m/${page.slug}`, request.url).toString();

  const sp = request.nextUrl.searchParams;
  let target: string | null;
  if (block.kind === "SOCIAL") {
    const items = parseBlockData(block.data).items ?? [];
    const item = items[Number(sp.get("i") ?? -1)];
    target = item ? socialTarget(item.type, item.url) : null;
  } else {
    target = blockTarget(block);
  }

  // 지운 · 끈 · 기간 밖 블록, 못 사는 상품은 페이지로 돌려보낸다(옛 화면을 띄워 둔 방문자)
  let ok = !block.deleted_at && block.enabled && inSchedule({ startsAt: block.starts_at, endsAt: block.ends_at }, Date.now());
  if (ok && block.shop_code && block.shop_product_id != null) {
    const { data: st } = await service
      .from("moa_product_status")
      .select("landing_status")
      .eq("shop_code", block.shop_code)
      .eq("shop_product_id", block.shop_product_id)
      .maybeSingle();
    ok = saleDisplay(st?.landing_status ?? null, page.hide_sold_out).kind === "normal";
  }
  if (!target || !ok) return NextResponse.redirect(pageUrl, 302);

  const campaign = cleanCampaign(sp.get("c"));
  const destination = withUtm(target, page.slug, campaign);

  const ua = request.headers.get("user-agent");
  if (page.status === "PUBLISHED" && !isBot(ua)) {
    const row = {
      page_id: page.id,
      block_id: block.id,
      kind: "CLICK",
      session_id: cleanSession(sp.get("s")) ?? "",
      visitor_hash: visitorHash(clientIp(request.headers), ua),
      source: detectSource(ua, request.headers.get("referer")),
      campaign,
    };
    after(async () => {
      const { error } = await service.rpc("moa_record_events", { p_rows: [row] });
      if (error) console.error("[moa/r] 기록 실패:", error.message);
    });
  }
  return NextResponse.redirect(destination, 302);
}

function socialTarget(type: string, url: string): string | null {
  if (type === "email") return url.startsWith("mailto:") ? url : `mailto:${url}`;
  if (type === "phone") return url.startsWith("tel:") ? url : `tel:${url.replace(/[^0-9+]/g, "")}`;
  return /^https?:\/\//i.test(url) ? url : null;
}
