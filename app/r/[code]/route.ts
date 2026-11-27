import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

// 게시물 댓글 · DM 자동화(0062) — DM 버튼 링크. 클릭을 하나 올리고 상품 페이지로 보낸다.
// 인스타는 버튼 클릭을 알려 주지 않아 MCB 주소를 거쳐 직접 집계한다.

const CODE_RE = /^[A-Za-z0-9]{8,16}$/;

export async function GET(_request: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  if (CODE_RE.test(code)) {
    const service = createServiceClient();
    const { data: target, error } = await service.rpc("record_post_automation_link_click", { p_code: code });
    if (error) console.error("[r] 클릭 기록 실패:", error.message);
    if (typeof target === "string" && /^https?:\/\//.test(target)) {
      return NextResponse.redirect(target, 302);
    }
  }
  return new Response("링크가 만료됐거나 없는 주소예요.", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
