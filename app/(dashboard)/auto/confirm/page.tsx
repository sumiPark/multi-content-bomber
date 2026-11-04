import Link from "next/link";
import { redirect } from "next/navigation";
import { CalendarCheck } from "lucide-react";
import { ConfirmAllButton, PlanCard, type PlanCardData } from "@/components/auto/plan-card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { loadTrackTimes } from "@/lib/schedule/track-times";
import { CONFIRM_NOTICE_HOURS, isPastSlot } from "@/lib/automation/deadline";
import { createServiceClient } from "@/lib/supabase/service";
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
  // 안내 문구의 칸 시각 — 자동 콘텐츠 설정에서 바뀐다
  const times = await loadTrackTimes(supabase);

  const { data: plans } = await supabase
    .from("content_plans")
    .select("id, social_account_id, slot_time, status, product_id, proposal, product_changed, note, error, script, check_result, video, publish_jobs(status), social_accounts(display_name)")
    .eq("slot_date", slotDate)
    .eq("track", "B")
    .order("slot_time", { ascending: true });

  const productIds = new Set<string>();
  for (const p of plans ?? []) {
    if (p.product_id) productIds.add(p.product_id);
    for (const a of (p.proposal as Proposal)?.alternatives ?? []) productIds.add(a.product_id);
  }
  const [{ data: products }, { data: sameDay }] = await Promise.all([
    productIds.size
      ? supabase
          .from("products")
          .select("id, name, price, url, represent_image_url, stock_status, kind, product_analyses(summary)")
          .in("id", [...productIds])
      : Promise.resolve({ data: [] }),
    // 같은 날 다른 칸(직접 촬영 포함)이 쓰는 상품 — 다른 후보 목록에서 뺀다
    supabase.from("content_plans").select("id, product_id").eq("slot_date", slotDate).not("status", "in", "(SKIPPED,FAILED)").not("product_id", "is", null),
  ]);
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

  // 완성본 — 비공개 버킷이라 서명 주소로 보여 준다
  const videoPaths = (plans ?? []).map((p) => (p.video as { path?: string } | null)?.path).filter((x): x is string => !!x);
  const signed = new Map<string, string>();
  if (videoPaths.length) {
    const { data: urls } = await createServiceClient().storage.from("media").createSignedUrls(videoPaths, 3600);
    for (const u of urls ?? []) if (u.path && u.signedUrl) signed.set(u.path, u.signedUrl);
  }

  // 계정별로 묶는다
  const byAccount = new Map<string, { name: string; plans: PlanCardData[] }>();
  for (const p of plans ?? []) {
    const name = p.social_accounts?.display_name ?? "(이름 없음)";
    const group = byAccount.get(p.social_account_id) ?? { name, plans: [] };
    const proposal = (p.proposal ?? {}) as Proposal;
    group.plans.push({
      id: p.id,
      slotTime: p.slot_time as string,
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
      pastSlot: isPastSlot(slotDate, p.slot_time as string),
      error: p.error,
      script: summarizeScript(p.script),
      issues: ((p.check_result as { issues?: { detail: string }[] } | null)?.issues ?? []).map((i) => i.detail),
      jobStatus: p.publish_jobs?.status ?? null,
      video: (() => {
        const v = p.video as { path?: string; seconds?: number; plan?: { look?: { reading?: string } }; sounds?: { music?: string | null; musicSource?: { title?: string; creator?: string; license?: string; landing?: string } | null } } | null;
        const url = v?.path ? signed.get(v.path) : undefined;
        return url ? { url, seconds: v?.seconds ?? null, reading: v?.plan?.look?.reading ?? null, music: v?.sounds?.musicSource ?? (v?.sounds?.music ? { title: v.sounds.music } : null) } : null;
      })(),
    });
    byAccount.set(p.social_account_id, group);
  }

  // 올릴 시각 전인 제안만 — 시각이 지나면 하나씩도, 모두도 확인할 수 없다
  const proposed = (plans ?? []).filter(
    (p) => p.status === "PROPOSED" && !isPastSlot(slotDate, p.slot_time as string),
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
            AI 자동 업로드 칸({times.B})의 <b>상품을 확인</b>하면 AI가 대본 · 캡션을 쓰고 점검해요. 올리기 {CONFIRM_NOTICE_HOURS}시간 전에 알려 드리고, 올릴 시각까지 확인하지 않은 칸은 건너뛰어요. 확인한 칸은 영상 만들기가 늦어져도 끝나는 즉시 올라가요.{" "}
            <b>확인한 상품은 대본과 영상까지 자동으로 만들어요.</b> 완성본은 여기서 보고 올려요.
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
            <h2 className="text-base font-semibold">@{g.name}</h2>
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
