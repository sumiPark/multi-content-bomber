// 진단: social_accounts.access_token_encrypted 형식 점검
// 실행: npx tsx scripts/diagnose-tokens.ts
//
// "Invalid initialization vector" 에러의 원인을 찾는다:
//  - 저장된 값이 "hex32:hex..." 형식인지
//  - IV(콜론 앞)가 정확히 32자 hex인지
//  - decryptToken을 실제로 호출했을 때 어떤 에러가 나는지

import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

loadEnv({ path: ".env.local" });
loadEnv(); // .env fallback

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "";

console.log("─".repeat(70));
console.log("ENCRYPTION_KEY 점검");
console.log("─".repeat(70));
console.log("env 존재:", ENCRYPTION_KEY ? "yes" : "NO");
console.log("env 길이(문자):", ENCRYPTION_KEY.length);
console.log("env 끝 6자:", ENCRYPTION_KEY.slice(-6));
const keyBuf = Buffer.from(ENCRYPTION_KEY, "base64");
console.log("base64 디코딩 후 바이트:", keyBuf.length, "(32여야 정상)");
console.log();

async function main() {
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

const { data, error } = await supabase
  .from("social_accounts")
  .select(
    "id, platform, display_name, is_active, access_token_encrypted, refresh_token_encrypted, updated_at",
  )
  .order("updated_at", { ascending: false });

if (error) {
  console.error("조회 실패:", error.message);
  process.exit(1);
}

console.log("─".repeat(70));
console.log(`social_accounts ${data?.length ?? 0}건`);
console.log("─".repeat(70));

for (const row of data ?? []) {
  console.log();
  console.log(`[${row.platform}] ${row.display_name} (id=${row.id})`);
  console.log(`  active=${row.is_active}  updated_at=${row.updated_at}`);

  for (const field of ["access_token_encrypted", "refresh_token_encrypted"] as const) {
    const v = row[field];
    if (!v) {
      console.log(`  ${field}: null`);
      continue;
    }
    const parts = v.split(":");
    const ivPart = parts[0] ?? "";
    const cipherPart = parts.slice(1).join(":");
    const ivBuf = Buffer.from(ivPart, "hex");
    const cipherBuf = Buffer.from(cipherPart, "hex");
    console.log(`  ${field}:`);
    console.log(`    전체길이=${v.length}  콜론개수=${parts.length - 1}`);
    console.log(`    IV 문자열길이=${ivPart.length} (32 정상)  hex디코딩바이트=${ivBuf.length} (16 정상)`);
    console.log(`    cipher 문자열길이=${cipherPart.length}  hex디코딩바이트=${cipherBuf.length}`);
    console.log(`    앞 40자: ${v.slice(0, 40)}${v.length > 40 ? "…" : ""}`);

    try {
      const decipher = crypto.createDecipheriv("aes-256-cbc", keyBuf, ivBuf);
      let dec = decipher.update(cipherBuf);
      dec = Buffer.concat([dec, decipher.final()]);
      const plain = dec.toString();
      console.log(`    ✅ 복호화 성공 (${plain.length}자, 앞 12자: ${plain.slice(0, 12)}…)`);
    } catch (e) {
      console.log(`    ❌ 복호화 실패: ${(e as Error).message}`);
    }

    // === bytea 추정 가설 검증: \x prefix면 ASCII 복원 후 재시도 ===
    if (v.startsWith("\\x")) {
      const asciiBytes = Buffer.from(v.slice(2), "hex");
      const recovered = asciiBytes.toString("utf8");
      console.log(`    [bytea→ASCII 복원] 길이=${recovered.length} 앞40자="${recovered.slice(0, 40)}${recovered.length > 40 ? "…" : ""}"`);
      const parts2 = recovered.split(":");
      if (parts2.length === 2) {
        const iv2 = Buffer.from(parts2[0], "hex");
        const ct2 = Buffer.from(parts2[1], "hex");
        console.log(`    [bytea→ASCII 복원] IV=${iv2.length}바이트  cipher=${ct2.length}바이트`);
        try {
          const dec = crypto.createDecipheriv("aes-256-cbc", keyBuf, iv2);
          let out = dec.update(ct2);
          out = Buffer.concat([out, dec.final()]);
          const plain = out.toString();
          console.log(`    ✅ [복원후 복호화] 성공 (${plain.length}자, 앞 12자: "${plain.slice(0, 12)}…")`);
        } catch (e) {
          console.log(`    ❌ [복원후 복호화] 실패: ${(e as Error).message}`);
        }
      }
    }
  }
}

console.log();
console.log("─".repeat(70));
console.log("끝");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
