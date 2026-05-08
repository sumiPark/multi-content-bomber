import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AcceptInviteForm, CreateOrgForm } from "./onboarding-forms";

export default async function OnboardingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("organization_id")
    .eq("id", user.id)
    .maybeSingle();

  if (profile?.organization_id) redirect("/");

  return (
    <main className="container mx-auto max-w-3xl px-6 py-12 space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">시작하기</h1>
        <p className="text-muted-foreground">
          새 워크스페이스를 만들거나, 관리자에게 받은 초대 토큰으로 합류하세요.
        </p>
      </header>
      <div className="grid gap-6 md:grid-cols-2">
        <CreateOrgForm />
        <AcceptInviteForm />
      </div>
    </main>
  );
}
