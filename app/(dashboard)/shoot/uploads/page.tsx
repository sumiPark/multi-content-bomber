import Link from "next/link";
import { redirect } from "next/navigation";
import { Video } from "lucide-react";
import { ShootRequestCard, type ShootRequestCardData } from "@/components/shoot/shoot-request-card";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { kstDate } from "@/lib/automation/time";

// 촬영 · 올리기 — 기획을 고른 칸마다 AI가 쓴 컷 목록대로 찍고, 컷마다 휴대폰에서 바로 올린다.
// 큰 파일은 끊겨도 이어서 올라간다(tus). 다 올리면 자동 편집으로 넘어간다.

type Cut = { no: number; seconds: number; shot: string; how: string; on_screen: string; voice: string; done?: boolean };
type Clip = { cut: number; name: string; size: number };
type SavedShotlist = {
  hooks?: { spoken: string; on_screen: string; score?: number | null }[];
  chosen_hook?: number;
  caption?: { text: string };
};

export default async function ShootUploadsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");
  const supabase = await getServerSupabase();

  const { data: requests } = await supabase
    .from("shoot_requests")
    .select(
      "id, status, cuts, clips, due_at, error, content_plans!inner(id, slot_date, slot_time, status, human_brief, script, check_result, social_accounts(display_name), products(name, url, represent_image_url))",
    )
    .in("status", ["OPEN", "UPLOADED", "EDITING", "EDITED", "FAILED"])
    .gte("content_plans.slot_date", kstDate(0))
    .order("due_at", { ascending: true, nullsFirst: false });

  const cards: ShootRequestCardData[] = (requests ?? [])
    .map((r) => {
      const plan = r.content_plans;
      const script = (plan.script ?? {}) as SavedShotlist;
      const hook = script.hooks?.[script.chosen_hook ?? 0];
      return {
        id: r.id,
        status: r.status,
        account: plan.social_accounts?.display_name ?? "",
        slotDate: plan.slot_date,
        slotTime: plan.slot_time,
        dueIso: r.due_at,
        product: plan.products ? { name: plan.products.name, url: plan.products.url, image: plan.products.represent_image_url } : null,
        brief: plan.human_brief,
        hook: hook ? { spoken: hook.spoken, onScreen: hook.on_screen, score: hook.score ?? null } : null,
        caption: script.caption?.text ?? "",
        cuts: ((r.cuts ?? []) as Cut[]).map((c) => ({
          no: c.no,
          seconds: c.seconds,
          shot: c.shot,
          how: c.how,
          onScreen: c.on_screen,
          voice: c.voice,
          done: !!c.done,
        })),
        clips: ((r.clips ?? []) as Clip[]).map((c) => ({ cut: c.cut, name: c.name, size: c.size })),
        issues: ((plan.check_result as { issues?: { detail: string }[] } | null)?.issues ?? []).map((i) => i.detail),
        error: r.error,
      };
    })
    .sort((a, b) => (a.slotDate + a.slotTime).localeCompare(b.slotDate + b.slotTime));

  const open = cards.filter((c) => c.status === "OPEN").length;

  return (
    <main className="max-w-4xl space-y-6 p-4 sm:p-6">
      <header>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold tracking-[-0.01em]">촬영 · 올리기</h1>
          {open > 0 && <Badge>찍을 것 {open}건</Badge>}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          컷 목록대로 찍고 <b>컷마다 휴대폰에서 바로 올리세요.</b> 큰 영상은 끊겨도 같은 파일을 다시 고르면 이어서 올라가요. 다 올리면 AI가 컷을 잇고
          화면 문구를 입혀요.
        </p>
      </header>

      {cards.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Video className="size-10 text-muted-foreground" />
            <h2 className="text-lg font-semibold">지금 찍을 촬영 요청이 없어요</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              <Link href="/shoot/plans" className="underline">
                촬영 기획 고르기
              </Link>
              에서 칸마다 찍을 거리를 고르면 1~2분 뒤 여기에 컷 목록이 생겨요.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {cards.map((c) => (
            <ShootRequestCard key={c.id} request={c} orgId={profile.organization_id!} userId={user.id} />
          ))}
        </div>
      )}
    </main>
  );
}
