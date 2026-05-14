// Meta App Review 검수자용 reviewer@cuma.co.kr 계정 상태 점검 + 필요 시 승인 처리.
// 실행: npx tsx scripts/setup-reviewer-account.ts
//
// 동작:
//  1. Supabase Auth에 계정이 있는지 확인
//  2. email_confirmed 아니면 service_role로 이메일 인증 통과
//  3. profiles 행 + organization 멤버십 확인 — 없으면 빈 organization을
//     생성해 owner로 붙임 (검수자가 자기 IG 테스트 계정으로 자유롭게
//     연동/publish 가능하도록)

import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";

loadEnv({ path: ".env.local" });
loadEnv();

const REVIEWER_EMAIL = "reviewer@cuma.co.kr";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

async function main() {
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 없음");
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  console.log("─".repeat(70));
  console.log(`reviewer 계정 점검: ${REVIEWER_EMAIL}`);
  console.log("─".repeat(70));

  // 1. Auth 사용자 확인
  // listUsers는 페이징 — 한 페이지 1000명 안에 있을 거라 가정.
  const { data: list, error: listErr } =
    await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) {
    console.error("listUsers 실패:", listErr.message);
    process.exit(1);
  }

  const user = list.users.find((u) => u.email === REVIEWER_EMAIL);

  if (!user) {
    console.log(`❌ Auth에 해당 계정 없음.`);
    console.log(`   → 두 가지 길:`);
    console.log(`     (A) 사용자가 /signup에서 직접 가입`);
    console.log(`     (B) 이 스크립트가 service_role로 직접 생성 (비번 인자 필요)`);
    console.log();
    console.log(`   현재 옵션 (B)는 비활성. 직접 가입 권장.`);
    return;
  }

  console.log(`✅ Auth 계정 존재  id=${user.id}`);
  console.log(`   email_confirmed_at: ${user.email_confirmed_at ?? "null"}`);
  console.log(`   created_at:          ${user.created_at}`);

  // 2. 이메일 인증 안 됐으면 통과 처리
  if (!user.email_confirmed_at) {
    const { error } = await supabase.auth.admin.updateUserById(user.id, {
      email_confirm: true,
    });
    if (error) {
      console.error("❌ 이메일 인증 통과 실패:", error.message);
    } else {
      console.log("✅ 이메일 인증 통과 처리 완료");
    }
  } else {
    console.log("   (이메일 인증 이미 됨 — 건너뜀)");
  }

  // 3. profile + organization 상태
  const { data: profile, error: profErr } = await supabase
    .from("profiles")
    .select("id, organization_id, role, organizations ( name )")
    .eq("id", user.id)
    .maybeSingle();

  if (profErr) {
    console.error("profiles 조회 실패:", profErr.message);
    process.exit(1);
  }

  if (!profile) {
    console.log("⚠️  profiles 행 없음 — 신규 가입 직후 onboarding 미진행 상태.");
  } else {
    console.log(`✅ profile 존재  organization_id=${profile.organization_id ?? "null"}  role=${profile.role ?? "null"}`);
    const org = Array.isArray(profile.organizations)
      ? profile.organizations[0]
      : (profile.organizations as { name?: string } | null);
    if (org?.name) {
      console.log(`   organization: ${org.name}`);
    }
  }

  // 4. organization 없으면 자동 생성
  //    RPC create_organization은 auth.uid() 기반(SECURITY DEFINER)이라
  //    service_role에서 못 부른다 → 같은 일을 직접 INSERT + UPDATE.
  //    service_role은 RLS와 column-level revoke 모두 우회.
  if (!profile || !profile.organization_id) {
    console.log();
    console.log("→ organization 직접 생성 (service_role)…");

    const orgName = "Meta App Review (reviewer)";

    const { data: newOrg, error: insertErr } = await supabase
      .from("organizations")
      .insert({ name: orgName })
      .select("id, name")
      .single();
    if (insertErr || !newOrg) {
      console.error("❌ organizations INSERT 실패:", insertErr?.message);
      return;
    }
    console.log(`   ✅ organization 생성: ${newOrg.name} (id=${newOrg.id})`);

    const { error: updErr } = await supabase
      .from("profiles")
      .update({ organization_id: newOrg.id, role: "ADMIN" })
      .eq("id", user.id);
    if (updErr) {
      console.error("❌ profiles UPDATE 실패:", updErr.message);
      return;
    }
    console.log(`   ✅ profile 갱신: organization_id 부여 + role=ADMIN`);
  }

  console.log();
  console.log("─".repeat(70));
  console.log("끝");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
