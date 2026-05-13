import { NextResponse } from "next/server";
import crypto from "crypto";
import { createServiceClient } from "@/lib/supabase/service";

// Meta Data Deletion Callback.
// 공식 문서: https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback
//
// 흐름:
//   1. Meta가 POST + signed_request 폼 필드 전송
//   2. signed_request = base64url(signature) + "." + base64url(payload)
//   3. signature를 INSTAGRAM_APP_SECRET HMAC-SHA256으로 검증
//   4. payload.user_id로 우리 시스템에서 해당 사용자의 데이터 삭제
//   5. { url, confirmation_code } JSON 응답 — 사용자가 url에서 code로 상태 조회 가능
//
// 콘솔 등록: Meta App Settings → 기본 설정 → 사용자 데이터 삭제
//   드롭다운: "데이터 삭제 콜백 URL" 선택
//   URL: https://mcb.cuma.co.kr/api/auth/data-deletion

function base64UrlDecode(input: string): Buffer {
  // base64url → 표준 base64로 변환 후 패딩 보완
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64");
}

interface SignedRequestPayload {
  algorithm: string;
  expires?: number;
  issued_at?: number;
  user_id: string;
}

function verifySignedRequest(
  signedRequest: string,
  appSecret: string,
): SignedRequestPayload {
  const [encodedSig, encodedPayload] = signedRequest.split(".");
  if (!encodedSig || !encodedPayload) {
    throw new Error("Invalid signed_request format");
  }

  const sig = base64UrlDecode(encodedSig);
  const payload = JSON.parse(
    base64UrlDecode(encodedPayload).toString("utf8"),
  ) as SignedRequestPayload;

  if (payload.algorithm !== "HMAC-SHA256") {
    throw new Error(`Unsupported algorithm: ${payload.algorithm}`);
  }

  const expectedSig = crypto
    .createHmac("sha256", appSecret)
    .update(encodedPayload)
    .digest();

  if (sig.length !== expectedSig.length) {
    throw new Error("Signature length mismatch");
  }
  if (!crypto.timingSafeEqual(sig, expectedSig)) {
    throw new Error("Signature mismatch");
  }

  return payload;
}

export async function POST(request: Request) {
  const appSecret = process.env.INSTAGRAM_APP_SECRET;
  if (!appSecret) {
    return NextResponse.json(
      { error: "INSTAGRAM_APP_SECRET not configured" },
      { status: 500 },
    );
  }

  // Meta는 application/x-www-form-urlencoded로 signed_request 필드 전송
  let signedRequest: string;
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await request.formData();
      const value = formData.get("signed_request");
      if (typeof value !== "string") {
        return NextResponse.json(
          { error: "missing signed_request field" },
          { status: 400 },
        );
      }
      signedRequest = value;
    } else if (contentType.includes("application/json")) {
      // 일부 테스트 도구는 JSON으로 보낼 수 있음
      const body = (await request.json()) as { signed_request?: string };
      if (!body.signed_request) {
        return NextResponse.json(
          { error: "missing signed_request" },
          { status: 400 },
        );
      }
      signedRequest = body.signed_request;
    } else {
      // 명시되지 않은 형식 — 일단 raw text로 시도
      signedRequest = await request.text();
    }
  } catch (err) {
    return NextResponse.json(
      { error: `failed to parse request: ${err instanceof Error ? err.message : err}` },
      { status: 400 },
    );
  }

  let payload: SignedRequestPayload;
  try {
    payload = verifySignedRequest(signedRequest, appSecret);
  } catch (err) {
    return NextResponse.json(
      {
        error: `signature verification failed: ${err instanceof Error ? err.message : err}`,
      },
      { status: 400 },
    );
  }

  const userId = payload.user_id;

  // 데이터 삭제 처리:
  //   user_id는 Instagram의 platform_account_id에 매핑. 해당 social_accounts 행을
  //   비활성화 + 토큰 컬럼을 null로 (즉시 사용 불가). 나머지 콘텐츠/조직 데이터는
  //   사용자가 명시적으로 요청한 게 아니라 SNS 연동 해제이므로 보존.
  //
  //   실제 운영에선 비동기 큐로 옮기는 게 안정적이지만, 현재는 단순 동기 처리 +
  //   Meta가 응답을 빠르게 받도록 단일 UPDATE.
  try {
    const supabase = createServiceClient();
    await supabase
      .from("social_accounts")
      .update({
        is_active: false,
        access_token_encrypted: null,
        refresh_token_encrypted: null,
        token_expires_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("platform", "INSTAGRAM")
      .eq("platform_account_id", userId);
  } catch (err) {
    // DB 실패해도 Meta에 200을 줘야 재시도 폭주를 막을 수 있다. 로그만 남기고
    // 사람이 모니터링에서 확인하도록.
    console.error(
      `[data-deletion] DB cleanup failed for user_id=${userId}:`,
      err,
    );
  }

  // Meta가 사용자에게 보여줄 상태 페이지 URL + 사용자가 입력해 조회 가능한 코드.
  // 코드는 user_id + 짧은 해시. 우리가 DB에 별도 보관하지 않더라도 user_id 자체가
  // 추적 가능한 identifier이므로 안내 페이지에서 그 코드만 받으면 처리 상태 확인 가능.
  const confirmationCode = `MCB-${crypto
    .createHash("sha256")
    .update(`${userId}-${Date.now()}`)
    .digest("hex")
    .slice(0, 12)
    .toUpperCase()}`;

  const statusUrl = `https://mcb.cuma.co.kr/data-deletion?code=${confirmationCode}`;

  return NextResponse.json({
    url: statusUrl,
    confirmation_code: confirmationCode,
  });
}

// Meta가 URL 등록 시 GET ping을 보내는 경우가 있음. 그 케이스에서 안내 페이지로 안내.
export async function GET() {
  return NextResponse.redirect("https://mcb.cuma.co.kr/data-deletion", 308);
}
