import { NextResponse } from "next/server";
import { readSignedRequest, verifySignedRequest } from "@/lib/meta/signed-request";
import { revokeThreadsAccount } from "@/lib/meta/threads-revoke";

// 스레드 앱 연결 해제 콜백 — 사용자가 스레드 설정에서 MCB 연결을 끊으면 Meta가 POST로 알린다.
// 메타 콘솔 등록 주소: https://mcb.cuma.co.kr/api/auth/threads/deauthorize
export async function POST(request: Request) {
  const appSecret = process.env.THREADS_APP_SECRET;
  if (!appSecret) {
    return NextResponse.json({ error: "THREADS_APP_SECRET not configured" }, { status: 500 });
  }
  const signed = await readSignedRequest(request);
  if (!signed) return NextResponse.json({ error: "missing signed_request" }, { status: 400 });

  let userId: string;
  try {
    userId = verifySignedRequest(signed, appSecret).user_id;
  } catch (err) {
    return NextResponse.json(
      { error: `signature verification failed: ${err instanceof Error ? err.message : err}` },
      { status: 400 },
    );
  }

  try {
    await revokeThreadsAccount(userId);
  } catch (err) {
    // Meta가 다시 보내지 않게 200으로 답하고 로그만 남긴다.
    console.error(`[threads deauthorize] user_id=${userId}:`, err);
  }
  return NextResponse.json({ ok: true });
}
