import Link from "next/link";
import { redirect } from "next/navigation";
import { Clapperboard } from "lucide-react";
import { ShootPlanCard, type ShootPlanCardData } from "@/components/shoot/shoot-plan-card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { isPastSlot } from "@/lib/automation/deadline";
import { addDays, kstDate } from "@/lib/automation/time";
import { cn } from "@/lib/utils";

// 촬영 기획 고르기 — 직접 촬영 칸(12 · 18시)마다 AI가 낸 기획안 후보 중 하나를 고르거나 상품을 직접 지정한다.
// 고르면 AI가 촬영 컷 리스트를 쓰고 "촬영 · 올리기" 화면에 촬영 요청이 생긴다.

type Idea = { product_id: string; title: string; format: string; concept: string; why: string };
type Proposal = { ideas?: Idea[]; chosen?: number | null };

export default async function ShootPlansPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const sp = await searchParams;
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");
  const canManage = profile.role === "ADMIN" || profile.role === "MANAGER";

  const tomorrow = kstDate(1);
  const slotDate = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : tomorrow;
  const supabase = await getServerSupabase();

  const { data: plans } = await supabase
    .from("content_plans")
    .select("id, social_account_id, slot_time, status, product_id, proposal, product_changed, human_brief, note, error, check_result, social_accounts(display_name)")
    .eq("slot_date", slotDate)
    .eq("track", "A")
    .order("slot_time", { ascending: true });

  const productIds = new Set<string>();
  for (const p of plans ?? []) {
    if (p.product_id) productIds.add(p.product_id);
    for (const i of (p.proposal as Proposal)?.ideas ?? []) productIds.add(i.product_id);
  }
  const { data: products } = productIds.size
    ? await supabase
        .from("products")
        .select("id, name, price, url, represent_image_url, stock_status, product_analyses(summary)")
        .in("id", [...productIds])
    : { data: [] };
  type ProductRow = NonNullable<typeof products>[number];
  const productById = new Map<string, ProductRow>((products ?? []).map((p) => [p.id, p]));
  const brief = (id: string | null) => {
    const p = id ? productById.get(id) : undefined;
    if (!p) return null;
    return {
      id: p.id,
      name: p.name,
      price: p.price,
      url: p.url,
      image: p.represent_image_url,
      stock: p.stock_status,
      oneLine: (p.product_analyses?.summary as { oneLine?: string } | null)?.oneLine ?? null,
    };
  };

  const byAccount = new Map<string, { name: string; plans: ShootPlanCardData[] }>();
  for (const p of plans ?? []) {
    const name = p.social_accounts?.display_name ?? "(이름 없음)";
    const group = byAccount.get(p.social_account_id) ?? { name, plans: [] };
    const proposal = (p.proposal ?? {}) as Proposal;
    group.plans.push({
      id: p.id,
      slotTime: p.slot_time,
      status: p.status,
      product: brief(p.product_id),
      productChanged: p.product_changed,
      humanBrief: p.human_brief,
      chosen: proposal.chosen ?? null,
      ideas: (proposal.ideas ?? []).map((i) => ({ title: i.title, format: i.format, concept: i.concept, why: i.why, product: brief(i.product_id) })),
      note: p.note,
      error: p.error,
      issues: ((p.check_result as { issues?: { detail: string }[] } | null)?.issues ?? []).map((i) => i.detail),
      // 서버에서 계산 — 렌더 중 시계를 읽으면 서버 · 클라이언트 결과가 갈린다
      pastSlot: isPastSlot(slotDate, p.slot_time),
    });
    byAccount.set(p.social_account_id, group);
  }

  const toChoose = (plans ?? []).filter((p) => p.status === "PROPOSED").length;
  const dates = [kstDate(0), tomorrow, addDays(tomorrow, 1)];

  return (
    <main className="container mx-auto max-w-6xl space-y-6 px-6 py-10">
      <header>
        <div className="flex items-center gap-2">
          <h1 className="text-3xl font-bold tracking-tight">촬영 기획 고르기</h1>
          <Badge variant="outline">매일 12시 · 18시</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          12시 · 18시 칸은 직접 찍어 올려요. AI가 칸마다 찍을 거리 2~3개를 골라 두니 <b>하나를 고르거나 상품을 직접 지정</b>하세요.
          고르면 AI가 찍을 컷 목록을 만들어 <Link href="/shoot/uploads" className="underline">촬영 · 올리기</Link>에 올려 둡니다.
          {toChoose > 0 && <b> 고를 칸 {toChoose}개.</b>}
        </p>
      </header>

      <nav className="flex gap-2">
        {dates.map((d) => (
          <Link
            key={d}
            href={`/shoot/plans?date=${d}`}
            className={cn(buttonVariants({ variant: d === slotDate ? "default" : "outline", size: "sm" }))}
          >
            {d === kstDate(0) ? "오늘" : d === tomorrow ? "내일" : "모레"} {d.slice(5)}
          </Link>
        ))}
      </nav>

      {byAccount.size === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Clapperboard className="size-10 text-muted-foreground" />
            <h2 className="text-lg font-semibold">{slotDate}에 찍을 기획안이 아직 없어요</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              AI가 매일 새벽 5시에 다음 날 12시 · 18시 칸의 기획안 후보를 만들어 둬요. 판매 중이고 상세페이지 분석이 끝난 상품만 후보가 됩니다.
            </p>
          </CardContent>
        </Card>
      ) : (
        [...byAccount.values()].map((g) => (
          <section key={g.name} className="space-y-3">
            <h2 className="text-lg font-semibold">@{g.name}</h2>
            <div className="grid gap-3 md:grid-cols-2">
              {g.plans.map((p) => (
                <ShootPlanCard key={p.id} plan={p} canManage={canManage} />
              ))}
            </div>
          </section>
        ))
      )}
    </main>
  );
}
