import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { catalogServer } from "@/lib/mcp/catalog";
import { handleMcp, rpcError } from "@/lib/mcp/server";

// MCB 상품 MCP 엔드포인트 (읽기 전용) — 외부(Claude)가 부르는 경로라 REST 라우트로 둔다.
// 인증: MCP_ACCESS_TOKEN(32자 이상). Claude Code는 Bearer 헤더로, claude.ai 커스텀 커넥터는
// 헤더를 못 넣어 경로 /api/mcp/<token>으로 보낸다. 토큰이 비어 있으면 503으로 막아 둔다.

export const maxDuration = 60;
const headers = { "Cache-Control": "no-store" };

function expectedToken(): string {
  const token = process.env.MCP_ACCESS_TOKEN?.trim() ?? "";
  return token.length >= 32 ? token : "";
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function authorized(req: Request, params: Promise<{ key?: string[] }>): Promise<boolean> {
  const token = expectedToken();
  const { key = [] } = await params;
  if (key.length > 1) return false;
  const offered = [req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "", key[0] ?? ""];
  return offered.some((v) => v && same(v, token));
}

export async function POST(req: Request, { params }: { params: Promise<{ key?: string[] }> }) {
  if (!expectedToken()) {
    return NextResponse.json({ error: "MCP_ACCESS_TOKEN(32자 이상)이 설정되지 않았습니다." }, { status: 503, headers });
  }
  if (!(await authorized(req, params))) {
    return NextResponse.json({ error: "인증 실패" }, { status: 401, headers });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(rpcError(null, -32700, "Parse error"), { status: 400, headers });
  }
  const messages = Array.isArray(body) ? body : [body];
  const replies = (await Promise.all(messages.map((m) => handleMcp(m, catalogServer)))).filter(Boolean);
  if (replies.length === 0) return new Response(null, { status: 202, headers });
  return NextResponse.json(Array.isArray(body) ? replies : replies[0], { headers });
}

// 상태 없는 서버: 서버가 먼저 여는 스트림도, 끝낼 세션도 없다.
export async function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST", ...headers } });
}
export const DELETE = GET;
