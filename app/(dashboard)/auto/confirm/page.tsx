import Link from "next/link";
import { redirect } from "next/navigation";
import { CalendarCheck } from "lucide-react";
import { ConfirmAllButton, PlanCard, type PlanCardData } from "@/components/auto/plan-card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { RelativeTime } from "@/components/ui/relative-time";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { loadTrackTimes } from "@/lib/schedule/track-times";
import { confirmDeadlineIso, isPastSlot, isPastDeadline } from "@/lib/automation/deadline";
import { kstDate } from "@/lib/automation/time";
import { cn } from "@/lib/utils";

// B 상품 컨펌 — 상품 선정 에이전트(1)가 낸 내일 B 칸(08 · 21시) 제안을 사람이 확인만 한다.
// 컨펌하면 대본 · 영상 · 점검 · 예약은 자동(3단계 나머지). 마감이 지나면 그 칸은 건너뛴다.

type Proposal = { reason?: string; alternatives?: { product_id: string; reason: string }[] };

type SavedScript = {
  beats?: { spoken: string; on_screen: string }[];
  caption?: { text: string };
  hooks?: { spoken: string; score?: number | null }[];
  chosen_hook?: number;
  fixed?: { hook?: unknown; notes?: string[] };
};

function summarizeScript(raw: unknown): PlanCardData["script"] {
  const s = raw as SavedScript | null;
  if (!s?.beats?.length) return null;
  return {
    hookScore: s.hooks?.[s.chosen_hook ?? 0]?.score ?? null,
    beats: s.beats.map((b) => ({ spoken: b.spoken, onScreen: b.on_screen })),
    caption: s.caption?.text ?? "",
    fixedHook: !!s.fixed?.hook,
    fixedNotes: s.fixed?.notes ?? [],
  };
}

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
  // 안내 문구의 칸 시각 — 편성표에서 바뀐다
  const times = await loadTrackTimes(supabase);

  const { data: plans } = await supabase
    .from("content_plans")
    .select("id, social_account_id, slot_time, status, product_id, proposal, product_changed, note, error, script, check_result, social_accounts(display_name)")
    .eq("slot_date", slotDate)
    .eq("track", "B")
    .order("slot_time", { ascending: true });

  const productIds = new Set<string>();
  for (const p of plans ?? []) {
    if (p.product_id) productIds.add(p.product_id);
    for (const a of (p.proposal as Proposal)?.alternatives ?? []) productIds.add(a.product_id);
  }
  const accountIds = [...new Set((plans ?? []).map((p) => p.social_account_id))];
  const [{ data: products }, { data: settings }, { data: sameDay }] = await Promise.all([
    productIds.size
      ? supabase
          .from("products")
          .select("id, name, price, url, represent_image_url, stock_status, kind, product_analyses(summary)")
          .in("id", [...productIds])
      : Promise.resolve({ data: [] }),
    accountIds.length
      ? supabase.from("track_settings").select("social_account_id, b_confirm_deadline").in("social_account_id", accountIds)
      : Promise.resolve({ data: [] }),
    // 같은 날 다른 칸(직접 촬영 포함)이 쓰는 상품 — 다른 후보 목록에서 뺀다
    supabase.from("content_plans").select("id, product_id").eq("slot_date", slotDate).not("status", "in", "(SKIPPED,FAILED)").not("product_id", "is", null),
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
    const deadline = deadlineBy.get(p.social_account_id) ?? "07:00";
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
      // 바꿀 수 있는 후보만 — 지금 상품 · 판매 중이 아닌 상품 · 같은 날 다른 칸이 쓰는 상품은 뺀다
      alternatives: (proposal.alternatives ?? [])
        .filter((a) => a.product_id !== p.product_id && !(sameDay ?? []).some((x) => x.id !== p.id && x.product_id === a.product_id))
        .map((a) => ({ reason: a.reason, product: brief(a.product_id) }))
        .filter((a): a is { reason: string; product: NonNullable<ReturnType<typeof brief>> } => !!a.product && a.product.stock === "available"),
      pastDeadline: isPastDeadline(slotDate, deadline),
      pastSlot: isPastSlot(slotDate, p.slot_time),
      error: p.error,
      script: summarizeScript(p.script),
      issues: ((p.check_result as { issues?: { detail: string }[] } | null)?.issues ?? []).map((i) => i.detail),
    });
    byAccount.set(p.social_account_id, group);
  }

  // 마감 전인 제안만 — 마감이 지나면 하나씩도, 모두도 컨펌할 수 없다
  const proposed = (plans ?? []).filter(
    (p) => p.status === "PROPOSED" && !isPastDeadline(slotDate, deadlineBy.get(p.social_account_id) ?? "07:00"),
  ).length;
  // 상품 제안은 내일 칸까지만 만든다 — 모레 탭은 늘 비어 있어 뺐다(주소로 다른 날짜를 열면 그 날짜도 탭에 보인다)
  const dates = [kstDate(0), tomorrow, ...(slotDate > tomorrow || slotDate < kstDate(0) ? [slotDate] : [])];

  return (
    <main className="space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold tracking-[-0.01em]">AI 자동 업로드</h1>
            {times.B !== "칸 없음" && <Badge variant="outline">매일 {times.B}</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            AI 자동 업로드 칸({times.B})의 <b>상품을 확인</b>하면 AI가 대본 · 캡션을 쓰고 점검해요. 올리는 날 오전 7시까지 확인하지 않은 칸은 건너뜁니다.{" "}
            <b>지금은 대본까지만 자동이에요.</b> 영상 만들기 · 자동 게시는 준비 중이라 아직 올라가지 않아요.
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
            {d === kstDate(0) ? "오늘" : d === tomorrow ? "내일" : ""} {d.slice(5)}
          </Link>
        ))}
      </nav>

      {byAccount.size === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <CalendarCheck className="size-10 text-muted-foreground" />
            <h2 className="text-base font-semibold">{slotDate}에 올릴 상품 제안이 아직 없어요</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              AI가 매일 아침 9시에 다음 날 올릴 상품을 골라 둬요. 판매 중이고 상세페이지 분석이 끝난 상품만 후보가 됩니다.
            </p>
          </CardContent>
        </Card>
      ) : (
        [...byAccount.values()].map((g) => (
          <section key={g.name} className="space-y-3">
            <div className="flex items-baseline gap-2">
              <h2 className="text-base font-semibold">@{g.name}</h2>
              <span className="text-xs text-muted-foreground">
                확인 마감 <RelativeTime iso={g.deadlineIso} />
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
