import Link from "next/link";
import { redirect } from "next/navigation";
import { CalendarCheck } from "lucide-react";
import { ConfirmAllButton, PlanCard, type PlanCardData } from "@/components/auto/plan-card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { RelativeTime } from "@/components/ui/relative-time";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { confirmDeadlineIso, isPastDeadline } from "@/lib/automation/deadline";
import { addDays, kstDate } from "@/lib/automation/time";
import { cn } from "@/lib/utils";

// B 상품 컨펌 — 상품 선정 에이전트(1)가 낸 내일 B 칸(08 · 21시) 제안을 사람이 확인만 한다.
// 컨펌하면 대본 · 영상 · 점검 · 예약은 자동(3단계 나머지). 마감이 지나면 그 칸은 건너뛴다.

type Proposal = { reason?: string; alternatives?: { product_id: string; reason: string }[] };

export default async function ConfirmPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
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
    .select("id, social_account_id, slot_time, status, product_id, proposal, product_changed, note, social_accounts(display_name)")
    .eq("slot_date", slotDate)
    .eq("track", "B")
    .order("slot_time", { ascending: true });

  const productIds = new Set<string>();
  for (const p of plans ?? []) {
    if (p.product_id) productIds.add(p.product_id);
    for (const a of (p.proposal as Proposal)?.alternatives ?? []) productIds.add(a.product_id);
  }
  const accountIds = [...new Set((plans ?? []).map((p) => p.social_account_id))];
  const [{ data: products }, { data: settings }] = await Promise.all([
    productIds.size
      ? supabase
          .from("products")
          .select("id, name, price, url, represent_image_url, stock_status, kind, product_analyses(summary)")
          .in("id", [...productIds])
      : Promise.resolve({ data: [] }),
    accountIds.length
      ? supabase.from("track_settings").select("social_account_id, b_confirm_deadline").in("social_account_id", accountIds)
      : Promise.resolve({ data: [] }),
  ]);
  type ProductRow = NonNullable<typeof products>[number];
  const productById = new Map<string, ProductRow>((products ?? []).map((p) => [p.id, p]));
  const deadlineBy = new Map((settings ?? []).map((s) => [s.social_account_id, s.b_confirm_deadline]));

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

  // 계정별로 묶는다
  const byAccount = new Map<string, { name: string; deadlineIso: string; plans: PlanCardData[] }>();
  for (const p of plans ?? []) {
    const name = p.social_accounts?.display_name ?? "(이름 없음)";
    const deadline = deadlineBy.get(p.social_account_id) ?? "18:00";
    const deadlineIso = confirmDeadlineIso(slotDate, deadline);
    const group = byAccount.get(p.social_account_id) ?? { name, deadlineIso, plans: [] };
    const proposal = (p.proposal ?? {}) as Proposal;
    group.plans.push({
      id: p.id,
      slotTime: p.slot_time,
      status: p.status,
      reason: proposal.reason ?? null,
      note: p.note,
      productChanged: p.product_changed,
      product: brief(p.product_id),
      alternatives: (proposal.alternatives ?? [])
        .map((a) => ({ reason: a.reason, product: brief(a.product_id) }))
        .filter((a): a is { reason: string; product: NonNullable<ReturnType<typeof brief>> } => !!a.product),
      pastDeadline: isPastDeadline(slotDate, deadline),
    });
    byAccount.set(p.social_account_id, group);
  }

  const proposed = (plans ?? []).filter((p) => p.status === "PROPOSED").length;
  const dates = [kstDate(0), tomorrow, addDays(tomorrow, 1)];

  return (
    <main className="container mx-auto max-w-6xl space-y-6 px-6 py-10">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-3xl font-bold tracking-tight">B 상품 컨펌</h1>
            <Badge variant="outline">B 트랙 · AI 자동 생성</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            AI가 고른 상품을 확인만 하면 대본 · 영상 · 점검 · 예약은 자동으로 진행돼요. 발행 전날 마감(기본 18시)이 지나면 그
            칸은 건너뜁니다.
          </p>
        </div>
        {canManage && proposed > 0 && <ConfirmAllButton slotDate={slotDate} count={proposed} />}
      </header>

      <nav className="flex gap-2">
        {dates.map((d) => (
          <Link
            key={d}
            href={`/auto/confirm?date=${d}`}
            className={cn(buttonVariants({ variant: d === slotDate ? "default" : "outline", size: "sm" }))}
          >
            {d === kstDate(0) ? "오늘" : d === tomorrow ? "내일" : "모레"} {d.slice(5)}
          </Link>
        ))}
      </nav>

      {byAccount.size === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <CalendarCheck className="size-10 text-muted-foreground" />
            <h2 className="text-lg font-semibold">{slotDate} B 칸 제안이 아직 없어요</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              상품 선정 에이전트가 매일 아침 내일 칸을 채워요. 판매 중이고 상세페이지 분석이 끝난 상품만 후보가 됩니다.
            </p>
          </CardContent>
        </Card>
      ) : (
        [...byAccount.values()].map((g) => (
          <section key={g.name} className="space-y-3">
            <div className="flex items-baseline gap-2">
              <h2 className="text-lg font-semibold">@{g.name}</h2>
              <span className="text-xs text-muted-foreground">
                컨펌 마감 <RelativeTime iso={g.deadlineIso} />
              </span>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {g.plans.map((p) => (
                <PlanCard key={p.id} plan={p} canManage={canManage} />
              ))}
            </div>
          </section>
        ))
      )}
    </main>
  );
}
