import "server-only";
import crypto from "crypto";

// Meta가 연결 해제 · 데이터 삭제 콜백에 보내는 signed_request 검증.
//   signed_request = base64url(HMAC-SHA256 서명) + "." + base64url(payload JSON)
// 서명 키는 그 사용 사례의 앱 시크릿(스레드면 THREADS_APP_SECRET).

export interface SignedRequestPayload {
  algorithm: string;
  issued_at?: number;
  user_id: string;
}

function base64UrlDecode(input: string): Buffer {
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function verifySignedRequest(signedRequest: string, appSecret: string): SignedRequestPayload {
  const [encodedSig, encodedPayload] = signedRequest.split(".");
  if (!encodedSig || !encodedPayload) throw new Error("signed_request 형식 오류");
  const payload = JSON.parse(base64UrlDecode(encodedPayload).toString("utf8")) as SignedRequestPayload;
  if (payload.algorithm?.toUpperCase() !== "HMAC-SHA256") {
    throw new Error(`지원하지 않는 서명 방식: ${payload.algorithm}`);
  }
  const sig = base64UrlDecode(encodedSig);
  const expected = crypto.createHmac("sha256", appSecret).update(encodedPayload).digest();
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) {
    throw new Error("서명 불일치");
  }
  if (!payload.user_id) throw new Error("user_id 없음");
  return payload;
}

// form(urlencoded) · JSON 둘 다 받는다.
export async function readSignedRequest(request: Request): Promise<string | null> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as { signed_request?: string } | null;
    return body?.signed_request ?? null;
  }
  const form = await request.formData().catch(() => null);
  const value = form?.get("signed_request");
  return typeof value === "string" ? value : null;
}
