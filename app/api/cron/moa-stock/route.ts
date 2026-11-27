import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { MOA_CACHE_TAG } from "@/lib/moa/public";
import { dueProductRefs, refreshProductStatuses } from "@/lib/moa/stock";
import { createServiceClient } from "@/lib/supabase/service";

// 모아링크 판매 상태 · 가격 점검 (0063). Supabase pg_cron이 3분마다, 페이지에 올라간 상품이 있을 때만 부른다.
// 몰 공개 API만 쓴다(AI 비용 없음). 바뀐 상품이 있으면 공개 페이지 캐시를 바로 비워 5분 안에 반영한다.
// 인증은 0022 publish-due와 같다(Vault 비밀값을 RPC로 대조).

export const maxDuration = 60;

// 직전 회차와 겹치지 않게 2분 30초 지난 상품만 다시 조회한다
const RECHECK_MS = 150_000;
const LIMIT = 150;

export async function POST(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const secret = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!secret) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const service = createServiceClient();
  const { data: valid, error: verifyError } = await service.rpc("verify_episode_replies_cron_secret", { p_secret: secret });
  if (verifyError) {
    console.error("[moa-stock] 비밀값 확인 실패:", verifyError.message);
    return NextResponse.json({ error: verifyError.message }, { status: 500 });
  }
  if (valid !== true) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const refs = await dueProductRefs(service, RECHECK_MS, LIMIT);
    const result = await refreshProductStatuses(service, refs, Date.now() + 45_000);
    if (result.changed > 0) revalidateTag(MOA_CACHE_TAG, { expire: 0 });
    console.log("[moa-stock]", JSON.stringify({ due: refs.length, ...result }));
    return NextResponse.json({ due: refs.length, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[moa-stock]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
