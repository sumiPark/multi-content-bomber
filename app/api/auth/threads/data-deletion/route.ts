import crypto from "crypto";
import { NextResponse } from "next/server";
import { readSignedRequest, verifySignedRequest } from "@/lib/meta/signed-request";
import { revokeThreadsAccount } from "@/lib/meta/threads-revoke";

// 스레드 데이터 삭제 콜백. 인스타용 /api/auth/data-deletion과 같은 응답 형식
// ({ url, confirmation_code })이고, 서명 키만 THREADS_APP_SECRET이다.
// 메타 콘솔 등록 주소: https://mcb.cuma.co.kr/api/auth/threads/data-deletion
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
    console.error(`[threads data-deletion] user_id=${userId}:`, err);
  }

  const confirmationCode = `MCB-TH-${crypto
    .createHash("sha256")
    .update(`${userId}-${Date.now()}`)
    .digest("hex")
    .slice(0, 12)
    .toUpperCase()}`;
  return NextResponse.json({
    url: `https://mcb.cuma.co.kr/data-deletion?code=${confirmationCode}`,
    confirmation_code: confirmationCode,
  });
}

export async function GET() {
  return NextResponse.redirect("https://mcb.cuma.co.kr/data-deletion", 308);
}
