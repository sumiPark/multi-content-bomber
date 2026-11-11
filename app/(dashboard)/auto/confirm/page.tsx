import Link from "next/link";
import { redirect } from "next/navigation";
import { CalendarCheck } from "lucide-react";
import { ConfirmAllButton, PlanCard, type PlanCardData } from "@/components/auto/plan-card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { usedEvidence, type VideoKnowledge } from "@/lib/agents/knowledge";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { loadTrackTimes } from "@/lib/schedule/track-times";
import { CONFIRM_NOTICE_HOURS, isPastSlot } from "@/lib/automation/deadline";
import { createServiceClient } from "@/lib/supabase/service";
import { kstDate } from "@/lib/automation/time";
import { cn } from "@/lib/utils";

// B 상품 컨펌 — 상품 선정 에이전트(1)가 낸 내일 B 칸(08 · 21시) 제안을 사람이 확인만 한다.
// 컨펌하면 대본 · 영상 · 점검 · 예약은 자동(3단계 나머지). 마감이 지나면 그 칸은 건너뛴다.

// original_product_id = 사람이 바꾸기 전 AI가 처음 제안한 상품(actions.ts가 남긴다). reason은 그 상품의 이유다
type Proposal = { reason?: string; alternatives?: { product_id: string; reason: string }[]; original_product_id?: string };

/** 처음 제안 상품 — 기록이 없으면 바꾸지 않은 칸만 지금 상품이 처음 제안이다 */
const originalOf = (proposal: Proposal, productId: string | null, changed: boolean) => proposal.original_product_id ?? (changed ? null : productId);

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

export default async function ConfirmPage({ searchParams }: { searchParams: Promise<{ date?: string; account?: string }> }) {
  const sp = await searchParams;
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");
  const canManage = profile.role === "ADMIN" || profile.role === "MANAGER";

  const tomorrow = kstDate(1);
  const supabase = await getServerSupabase();
  // 계정 탭 — AI 자동 칸이 있는 계정. 고르면 그 계정 칸만 보이고 "모두 확인"도 그 계정에만 적용한다
  const { data: ruleRows } = await supabase.from("slot_rules").select("social_account_id, social_accounts(display_name)").eq("track", "B").eq("active", true);
  const accountTabs = new Map<string, string>();
  for (const r of ruleRows ?? []) accountTabs.set(r.social_account_id, r.social_accounts?.display_name ?? "(이름 없음)");
  const account = sp.account && /^[0-9a-f-]{36}$/i.test(sp.account) ? sp.account : null;
  // 날짜와 상관없이 사람이 볼 칸: 완성본 확인 대기(RENDERED) · 멈춘 칸(BLOCKED) · 시각이 지났는데 아직 만드는 칸.
  // 날짜를 고르지 않고 들어오면 그런 칸이 있는 가장 이른 날을 먼저 연다(없으면 내일)
  let attentionQuery = supabase
    .from("content_plans")
    .select("slot_date, slot_time, status")
    .eq("track", "B")
    .in("status", ["RENDERED", "BLOCKED", "CONFIRMED", "SCRIPTED"])
    .gte("slot_date", kstDate(-14))
    .order("slot_date", { ascending: true })
    .limit(200);
  if (account) attentionQuery = attentionQuery.eq("social_account_id", account);
  const { data: attentionRows } = await attentionQuery;
  const attention = new Map<string, number>();
  for (const r of attentionRows ?? []) {
    const d = r.slot_date as string;
    const late = (r.status === "CONFIRMED" || r.status === "SCRIPTED") && isPastSlot(d, r.slot_time as string);
    if (r.status === "RENDERED" || r.status === "BLOCKED" || late) attention.set(d, (attention.get(d) ?? 0) + 1);
  }
  const slotDate = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : ([...attention.keys()][0] ?? tomorrow);
  // 안내 문구의 칸 시각 — 자동 콘텐츠 설정에서 바뀐다
  const times = await loadTrackTimes(supabase);

  let plansQuery = supabase
    .from("content_plans")
    .select("id, social_account_id, slot_time, status, product_id, proposal, product_changed, note, error, script, check_result, video, board_at:storyboard->>writtenAt, board_scenes:storyboard->board->scenes, board_knowledge:storyboard->knowledge, publish_jobs(status), social_accounts(display_name)")
    .eq("slot_date", slotDate)
    .eq("track", "B")
    .order("slot_time", { ascending: true });
  if (account) plansQuery = plansQuery.eq("social_account_id", account);
  const { data: plans } = await plansQuery;
  // 탭에 칸 설정이 없어진 계정이라도 그날 칸이 있으면 보인다
  for (const p of plans ?? []) if (!accountTabs.has(p.social_account_id)) accountTabs.set(p.social_account_id, p.social_accounts?.display_name ?? "(이름 없음)");

  const productIds = new Set<string>();
  for (const p of plans ?? []) {
    const proposal = (p.proposal ?? {}) as Proposal;
    if (p.product_id) productIds.add(p.product_id);
    if (proposal.original_product_id) productIds.add(proposal.original_product_id);
    for (const a of proposal.alternatives ?? []) productIds.add(a.product_id);
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
    // 이유는 지금 상품 기준 — 처음 제안이면 그 이유, 대안으로 바꿨으면 그 대안의 이유, 사람이 찾아 넣었으면 없다
    const original = originalOf(proposal, p.product_id, p.product_changed);
    const altReason = (proposal.alternatives ?? []).find((a) => a.product_id === p.product_id)?.reason ?? null;
    const isOriginal = !!p.product_id && p.product_id === original;
    // 바꿀 후보 — 처음 제안(바꾼 뒤 되돌리기용) + 대안
    const choices = [
      ...(original && proposal.reason ? [{ product_id: original, reason: proposal.reason, first: true }] : []),
      ...(proposal.alternatives ?? []).map((a) => ({ ...a, first: false })),
    ];
    group.plans.push({
      id: p.id,
      slotTime: p.slot_time as string,
      status: p.status,
      reason: isOriginal ? (proposal.reason ?? null) : altReason,
      humanPicked: !!p.product_id && !isOriginal && !altReason,
      note: p.note,
      productChanged: p.product_changed,
      product: brief(p.product_id),
      // 바꿀 수 있는 후보만 — 지금 상품 · 판매 중이 아닌 상품 · 같은 날 다른 칸이 쓰는 상품은 뺀다
      alternatives: choices
        .filter((a) => a.product_id !== p.product_id && !(sameDay ?? []).some((x) => x.id !== p.id && x.product_id === a.product_id))
        .map((a) => ({ reason: a.reason, first: a.first, product: brief(a.product_id) }))
        .filter((a): a is { reason: string; first: boolean; product: NonNullable<ReturnType<typeof brief>> } => !!a.product && a.product.stock === "available"),
      pastSlot: isPastSlot(slotDate, p.slot_time as string),
      error: p.error,
      script: summarizeScript(p.script),
      issues: ((p.check_result as { issues?: { detail: string }[] } | null)?.issues ?? []).map((i) => i.detail),
      jobStatus: p.publish_jobs?.status ?? null,
      hasStoryboard: !!p.board_at,
      // 장면표를 쓸 때 받은 근거 중 실제로 쓴 것 — 승인 · 초안을 나눠 보여 준다
      evidence: Array.isArray(p.board_scenes) && p.board_knowledge ? usedEvidence(p.board_scenes as { evidence?: string[] }[], p.board_knowledge as unknown as VideoKnowledge) : null,
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
  // 오늘 · 내일 + 볼 칸이 남은 날 + 주소로 연 날
  const dates = [...new Set([...attention.keys(), kstDate(0), tomorrow, slotDate])].sort();
  const href = (date: string, acc: string | null) => `/auto/confirm?date=${date}${acc ? `&account=${acc}` : ""}`;
  const accountName = account ? accountTabs.get(account) : undefined;

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
        {canManage && proposed > 0 && <ConfirmAllButton slotDate={slotDate} count={proposed} accountId={account} accountName={accountName ?? null} />}
      </header>

      <div className="space-y-2">
        <nav className="flex flex-wrap gap-2" aria-label="날짜">
          {dates.map((d) => (
            <Link
              key={d}
              href={href(d, account)}
              className={cn(buttonVariants({ variant: d === slotDate ? "default" : "outline", size: "sm" }))}
            >
              {d === kstDate(0) ? "오늘" : d === tomorrow ? "내일" : ""} {d.slice(5)}
              {attention.get(d) ? <Badge variant={d === slotDate ? "secondary" : "default"}>확인 {attention.get(d)}</Badge> : null}
            </Link>
          ))}
        </nav>
        {accountTabs.size > 1 && (
          <nav className="flex flex-wrap gap-1.5" aria-label="계정">
            <Link href={href(slotDate, null)} className={cn(buttonVariants({ variant: account ? "ghost" : "secondary", size: "sm" }))}>
              전체
            </Link>
            {[...accountTabs].map(([id, name]) => (
              <Link key={id} href={href(slotDate, id)} className={cn(buttonVariants({ variant: account === id ? "secondary" : "ghost", size: "sm" }))}>
                @{name}
              </Link>
            ))}
          </nav>
        )}
      </div>

      {byAccount.size === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <CalendarCheck className="size-10 text-muted-foreground" />
            <h2 className="text-base font-semibold">{slotDate}에 {accountName ? `@${accountName} ` : ""}올릴 상품 제안이 아직 없어요</h2>
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
