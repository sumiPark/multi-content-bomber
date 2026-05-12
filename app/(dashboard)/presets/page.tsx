import { redirect } from "next/navigation";
import { PresetsManager } from "@/components/presets/presets-manager";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";

export default async function PresetsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");

  const supabase = await getServerSupabase();

  const { data: presets } = await supabase
    .from("caption_presets")
    .select("id, name, description, instructions, created_by, updated_at")
    .order("created_at", { ascending: false });

  return (
    <main className="container mx-auto max-w-4xl px-6 py-10 space-y-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">캡션 프리셋</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          자주 쓰는 캡션 스타일을 저장해 AI 생성에 적용하세요. 워크스페이스
          멤버가 함께 사용합니다.
        </p>
      </header>
      <PresetsManager
        presets={presets ?? []}
        currentUserId={user.id}
        isAdmin={profile.role === "ADMIN"}
      />
    </main>
  );
}
