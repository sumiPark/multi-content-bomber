import { redirect } from "next/navigation";
import { getCurrentProfile, getSessionUser } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * 단일 공유 워크스페이스 정책.
 *
 * 모든 가입자는 DB 트리거(handle_new_user)가 가입 즉시 공유 워크스페이스에
 * ADMIN으로 배정한다. 따라서 별도 온보딩 화면(생성/초대 합류)은 없다.
 *
 * 이 라우트는 트리거 도입 이전에 만들어진 레거시 계정 등 organization_id가
 * 비어 있는 드문 경우를 위한 자가치유 경로다 — service_role로 공유 조직에
 * 합류시킨 뒤 대시보드로 보낸다. (각 보호 페이지가 org 없는 사용자를 여기로
 * 보내므로, 리다이렉트 루프를 막으려면 여기서 반드시 org를 채워야 한다.)
 */
export default async function OnboardingPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const profile = await getCurrentProfile();
  if (!profile?.organization_id) {
    const service = createServiceClient();
    const { data: org } = await service
      .from("organizations")
      .select("id")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (org) {
      await service
        .from("profiles")
        .update({ organization_id: org.id, role: "ADMIN" })
        .eq("id", user.id);
    }
  }

  redirect("/");
}
