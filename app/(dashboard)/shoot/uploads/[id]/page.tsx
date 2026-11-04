import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { ShootRequestCard } from "@/components/shoot/shoot-request-card";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { REQUEST_SELECT, toRequestCard, type RequestRow } from "@/lib/shoot/request-data";

// 촬영 · 올리기 상세 — 영상 하나의 컷 목록을 보고 컷마다 올린다. 큰 파일은 끊겨도 이어서 올라간다(tus).
// 휴대폰에서 올리는 화면이라 서랍이 아니라 자기 주소를 가진 페이지로 둔다(새로 고쳐도 그 영상).

export const metadata = { title: "촬영 · 올리기 | MCB" };

export default async function ShootUploadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const supabase = await getServerSupabase();
  const { data } = await supabase.from("shoot_requests").select(REQUEST_SELECT).eq("id", id).maybeSingle();
  if (!data || data.status === "CANCELLED") notFound();
  const { data: concept } = await supabase.from("account_concepts").select("shoot_voice_mode").eq("social_account_id", data.content_plans.social_account_id).maybeSingle();
  const card = toRequestCard(data as unknown as RequestRow, concept?.shoot_voice_mode === "LIVE");

  return (
    <main className="space-y-4 p-4 sm:p-6">
      <AutoRefresh active={card.status === "UPLOADED" || card.status === "EDITING"} />
      <Link href="/shoot/uploads" className="inline-flex items-center gap-1 text-[13px] font-medium text-muted-foreground hover:text-foreground">
        <ChevronLeft className="size-4" /> 촬영 · 올리기 목록
      </Link>
      <h1 className="text-xl font-bold tracking-[-0.01em]">{card.ideaTitle ?? card.product?.name ?? "촬영"}</h1>
      <ShootRequestCard request={card} orgId={profile.organization_id} userId={user.id} />
    </main>
  );
}
