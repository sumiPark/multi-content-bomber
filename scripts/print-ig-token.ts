// DB에 저장된 Instagram access_token을 복호화해서 출력.
// Graph API Explorer의 "액세스 토큰" 입력란에 그대로 붙여넣어 사용.
//
// 실행: npx tsx scripts/print-ig-token.ts
//
// ⚠️ 출력된 토큰은 60일짜리 long-lived. 화면/터미널 캡처/공유 주의.

import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

loadEnv({ path: ".env.local" });
loadEnv();

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "";

function decryptToken(text: string): string {
  const [ivHex, ...rest] = text.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const cipher = Buffer.from(rest.join(":"), "hex");
  const key = Buffer.from(ENCRYPTION_KEY, "base64");
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  let dec = decipher.update(cipher);
  dec = Buffer.concat([dec, decipher.final()]);
  return dec.toString();
}

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const { data, error } = await supabase
    .from("social_accounts")
    .select(
      "id, display_name, platform_account_id, access_token_encrypted, token_expires_at",
    )
    .eq("platform", "INSTAGRAM")
    .eq("is_active", true);

  if (error || !data) {
    console.error("조회 실패:", error?.message);
    process.exit(1);
  }
  if (data.length === 0) {
    console.log("활성 IG 계정 없음.");
    return;
  }

  console.log("─".repeat(70));
  console.log("Instagram access tokens");
  console.log("─".repeat(70));

  for (const row of data) {
    console.log();
    console.log(`Account: ${row.display_name}`);
    console.log(`  IG_USER_ID:    ${row.platform_account_id}`);
    console.log(`  expires_at:    ${row.token_expires_at ?? "n/a"}`);
    if (!row.access_token_encrypted) {
      console.log("  token: (none)");
      continue;
    }
    try {
      const token = decryptToken(row.access_token_encrypted);
      console.log(`  access_token:`);
      console.log(`  ${token}`);
    } catch (e) {
      console.log(`  복호화 실패: ${(e as Error).message}`);
    }
  }

  console.log();
  console.log("─".repeat(70));
  console.log("Graph API Explorer 사용법:");
  console.log("  1. 우측 상단 '액세스 토큰' 입력란에 위 access_token 붙여넣기");
  console.log("  2. URL: graph.instagram.com / v23.0 / IG_USER_ID/media");
  console.log("     POST, query: image_url=<공개 이미지>&caption=<텍스트>");
  console.log("  3. 응답의 container id로:");
  console.log("     POST IG_USER_ID/media_publish?creation_id=<container_id>");
  console.log("─".repeat(70));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
