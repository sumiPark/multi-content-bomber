import { z } from "zod";

// 최소 MCP 서버 (Streamable HTTP, JSON 응답만, 세션 · SSE 없음) — 요청 하나를 POST 하나로 답한다.
// 리유 분석 프로젝트(ChatGPT-Codex/ai-recommend lib/mcp.ts)와 같은 구조. 도구는 모두 읽기 전용.

export interface McpTool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  input: S;
  run: (args: z.infer<S>) => Promise<unknown>;
}

export interface McpServer {
  name: string;
  version: string;
  instructions: string;
  tools: McpTool[];
}

interface RpcMessage {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: { protocolVersion?: string; name?: string; arguments?: unknown };
}

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const ok = (id: RpcMessage["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });

export const rpcError = (id: RpcMessage["id"] | undefined, code: number, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

const text = (value: unknown, isError = false) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

function toolList(server: McpServer) {
  return server.tools.map((t) => {
    const { $schema: _schema, ...inputSchema } = z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown>;
    void _schema;
    return {
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema,
      annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    };
  });
}

/** 알림(id 없음)이면 null — 라우트가 빈 202로 답한다. */
export async function handleMcp(message: unknown, server: McpServer) {
  const m = message as RpcMessage;
  if (!m || typeof m !== "object" || m.jsonrpc !== "2.0" || typeof m.method !== "string") {
    return rpcError(m?.id, -32600, "Invalid Request");
  }
  if (m.id === undefined || m.id === null) return null;
  const { id, params } = m;

  switch (m.method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      return ok(id, {
        protocolVersion: asked && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: server.name, version: server.version },
        instructions: server.instructions,
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: toolList(server) });
    case "tools/call": {
      const tool = server.tools.find((t) => t.name === params?.name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(params?.name)}`);
      const parsed = tool.input.safeParse(params?.arguments ?? {});
      if (!parsed.success) return ok(id, text(`입력값을 확인해 주세요.\n${z.prettifyError(parsed.error)}`, true));
      try {
        return ok(id, text(await tool.run(parsed.data)));
      } catch (err) {
        return ok(id, text(err instanceof Error ? err.message : "도구 실행에 실패했습니다.", true));
      }
    }
  }
  return rpcError(id, -32601, "Method not found");
}
