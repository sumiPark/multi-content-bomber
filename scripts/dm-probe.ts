// 댓글 · DM 자동화 0단계 실측 — 지금 권한으로 댓글 기반 DM(private reply)이 어떤 형태까지 되는지 확인한다.
//
// 실행 (조회는 아무것도 보내지 않는다):
//   npx tsx scripts/dm-probe.ts accounts                         인스타 계정 · 연결 상태 · 토큰 권한 범위
//   npx tsx scripts/dm-probe.ts media <username>                 최근 게시물 10개
//   npx tsx scripts/dm-probe.ts comments <username> <mediaId>    게시물 최근 댓글 20개
//   npx tsx scripts/dm-probe.ts subs <username>                  계정의 웹훅 구독 상태
//
// 실제 발송 (그 댓글 작성자에게 DM이 간다 — 시험용 댓글에만, --yes 필수):
//   npx tsx scripts/dm-probe.ts send <username> <commentId> text|button|quick --yes
//
// ⚠️ 토큰은 출력하지 않는다. 댓글 하나에는 DM을 한 번만 보낼 수 있어 형태마다 다른 시험 댓글을 쓴다.

import "../worker/load-env";
import { createClient } from "@supabase/supabase-js";
import { decryptToken } from "@/lib/crypto";

const GRAPH = "https://graph.instagram.com/v23.0";

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

interface Account {
  id: string;
  username: string;
  igId: string;
  token: string;
}

async function loadAccounts(): Promise<Array<Omit<Account, "token"> & { active: boolean; disconnected: boolean; enc: string | null; expires: string | null; scopes: string[] | null }>> {
  const { data, error } = await service
    .from("social_accounts")
    .select("id, display_name, platform_account_id, is_active, disconnected_at, access_token_encrypted, token_expires_at, granted_scopes")
    .eq("platform", "INSTAGRAM");
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    username: String(r.display_name ?? "").replace(/^@/, ""),
    igId: r.platform_account_id as string,
    active: r.is_active as boolean,
    disconnected: !!r.disconnected_at,
    enc: r.access_token_encrypted as string | null,
    expires: r.token_expires_at as string | null,
    scopes: (r.granted_scopes as string[] | null) ?? null,
  }));
}

async function account(username: string): Promise<Account> {
  const rows = await loadAccounts();
  const row = rows.find((r) => r.username.replace(/^@/, "") === username.replace(/^@/, ""));
  if (!row) throw new Error(`계정 없음: ${username} (accounts로 이름 확인)`);
  if (!row.active || row.disconnected || !row.enc) throw new Error(`${username}: 연결이 끊겼거나 토큰이 없어요`);
  return { id: row.id, username: row.username, igId: row.igId, token: decryptToken(row.enc) };
}

async function graph(method: "GET" | "POST", path: string, token: string, params: Record<string, string> = {}, body?: unknown) {
  const url = new URL(`${GRAPH}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", token);
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = text;
  try { json = JSON.parse(text); } catch { /* 그대로 */ }
  return { status: res.status, json };
}

const MESSAGES = {
  text: { text: "[MCB 실측] 글자만 형태 DM이에요.\nhttps://mcb.cuma.co.kr\n이 메시지는 시험용이에요." },
  button: {
    attachment: {
      type: "template",
      payload: {
        template_type: "button",
        text: "[MCB 실측] 버튼 메시지 형태 DM이에요. 아래 버튼을 눌러 보세요.",
        buttons: [{ type: "web_url", url: "https://mcb.cuma.co.kr", title: "열어 보기" }],
      },
    },
  },
  quick: {
    text: "[MCB 실측] 두 단계 형태의 첫 DM이에요. 아래 버튼을 눌러 보세요.",
    quick_replies: [{ content_type: "text", title: "링크 받기", payload: "MCB_PROBE_LINK" }],
  },
} as const;

async function main() {
  const [cmd, a1, a2, a3] = process.argv.slice(2);
  const yes = process.argv.includes("--yes");

  if (cmd === "accounts") {
    for (const r of await loadAccounts()) {
      let me = "-";
      if (r.active && !r.disconnected && r.enc) {
        const res = await graph("GET", "/me", decryptToken(r.enc), { fields: "id,user_id,username" });
        me = res.status === 200 ? `토큰 OK (@${(res.json as { username?: string }).username ?? "?"})` : `토큰 실패 ${res.status}`;
      }
      console.log(`${r.username.padEnd(16)} active=${r.active} disconnected=${r.disconnected} expires=${r.expires?.slice(0, 10) ?? "-"} ${me}`);
      console.log(`${"".padEnd(16)} 권한: ${r.scopes?.join(", ") ?? "(기록 없음)"}`);
    }
    return;
  }

  if (cmd === "media") {
    const acc = await account(a1);
    const r = await graph("GET", "/me/media", acc.token, { fields: "id,caption,media_product_type,timestamp,comments_count,permalink", limit: "10" });
    if (r.status !== 200) return console.log(r.status, JSON.stringify(r.json));
    for (const m of (r.json as { data: Array<Record<string, unknown>> }).data) {
      console.log(`${m.id}  ${String(m.timestamp).slice(0, 16)}  댓글 ${m.comments_count ?? "?"}  ${String(m.caption ?? "").replace(/\s+/g, " ").slice(0, 40)}`);
    }
    return;
  }

  if (cmd === "comments") {
    const acc = await account(a1);
    const r = await graph("GET", `/${a2}/comments`, acc.token, { fields: "id,text,timestamp,username,from,parent_id", limit: "20" });
    if (r.status !== 200) return console.log(r.status, JSON.stringify(r.json));
    for (const c of (r.json as { data: Array<Record<string, unknown>> }).data) {
      console.log(`${c.id}  ${String(c.timestamp).slice(0, 16)}  @${c.username ?? "?"}${c.parent_id ? " (답글)" : ""}  ${String(c.text ?? "").slice(0, 50)}`);
    }
    return;
  }

  if (cmd === "subs") {
    const acc = await account(a1);
    const r = await graph("GET", "/me/subscribed_apps", acc.token);
    console.log(r.status, JSON.stringify(r.json, null, 2));
    return;
  }

  if (cmd === "send") {
    const kind = a3 as keyof typeof MESSAGES;
    if (!MESSAGES[kind]) throw new Error("형태는 text | button | quick 중 하나");
    const acc = await account(a1);
    console.log(`보낼 곳: @${acc.username}의 댓글 ${a2} 작성자 · 형태 ${kind}`);
    console.log(JSON.stringify(MESSAGES[kind], null, 2));
    if (!yes) return console.log("\n--yes 를 붙여야 실제로 보내요.");
    const r = await graph("POST", `/${acc.igId}/messages`, acc.token, {}, { recipient: { comment_id: a2 }, message: MESSAGES[kind] });
    console.log(`\n결과 ${r.status}:`, JSON.stringify(r.json, null, 2));
    return;
  }

  console.log("명령: accounts | media <username> | comments <username> <mediaId> | subs <username> | send <username> <commentId> text|button|quick --yes");
}

main().catch((e) => {
  console.error("실패:", e instanceof Error ? e.message : e);
  process.exit(1);
});
