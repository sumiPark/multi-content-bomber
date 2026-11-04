import Link from "next/link";
import { redirect } from "next/navigation";
import { Clapperboard } from "lucide-react";
import { AccountTabs } from "@/components/shoot/account-tabs";
import { ShootAccountActions, ShootIdeaList, ShootProgressRow, type ShootIdeaData, type ShootProgressData } from "@/components/shoot/shoot-plan-card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { AutoRefresh } from "@/components/ui/auto-refresh";

// 촬영 기획 고르기 — 계정 탭(?account=) + 기획 목록(날짜 · 시각 없음, 계정당 5개 유지). 줄을 누르면 서랍에서 대본 초안을 읽고 고른다.
// 고르면 AI가 촬영 컷 리스트를 쓰고 "촬영 · 올리기" 화면에 촬영 요청이 생긴다.

export const metadata = { title: "촬영 기획 고르기 | MCB" };

type Idea = { product_id: string; title: string; format: string; concept: string; why: string; draft?: { hook: string; beats: { scene: string; line: string }[] } };
type Proposal = { ideas?: Idea[]; chosen?: number | null };

const LIST_SIZE = 5;
const PROGRESS = ["CONFIRMED", "SCRIPTED", "SHOT", "RENDERED", "BLOCKED"];

export default async function ShootPlansPage({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");
  const canManage = profile.role === "ADMIN" || profile.role === "MANAGER";
  const supabase = await getServerSupabase();
  const { account: accountParam } = await searchParams;

  const [{ data: settings }, { data: plans }] = await Promise.all([
    supabase.from("track_settings").select("social_account_id, shoot_enabled, social_accounts(display_name, disconnected_at, is_active)").eq("shoot_enabled", true),
    supabase
      .from("content_plans")
      .select("id, social_account_id, status, product_id, proposal, human_brief, note, error, check_result, created_at, social_accounts(display_name), products(id, name, price, url, represent_image_url, stock_status, product_analyses(summary)), shoot_requests(id)")
      .eq("track", "A")
      .in("status", ["PROPOSED", ...PROGRESS])
      .order("created_at", { ascending: true }),
  ]);

  type Row = NonNullable<typeof plans>[number];
  const brief = (p: Row["products"]) =>
    p
      ? {
          id: p.id,
          name: p.name,
          price: p.price,
          url: p.url,
          image: p.represent_image_url,
          stock: p.stock_status,
          oneLine: (p.product_analyses?.summary as { oneLine?: string } | null)?.oneLine ?? null,
        }
      : null;

  const groups = new Map<string, { name: string; off: boolean; ideas: ShootIdeaData[]; progress: ShootProgressData[] }>();
  for (const s of settings ?? []) {
    if (!s.social_accounts || s.social_accounts.disconnected_at) continue;
    groups.set(s.social_account_id, { name: s.social_accounts.display_name ?? "", off: s.social_accounts.is_active === false, ideas: [], progress: [] });
  }
  for (const p of plans ?? []) {
    // 촬영 설정에서 끈 계정도 진행 중인 기획은 끝까지 보인다
    const group = groups.get(p.social_account_id) ?? { name: p.social_accounts?.display_name ?? "", off: false, ideas: [], progress: [] };
    groups.set(p.social_account_id, group);
    const proposal = (p.proposal ?? {}) as Proposal;
    const idea = proposal.ideas?.[proposal.chosen ?? 0];
    if (p.status === "PROPOSED") {
      if (idea) group.ideas.push({ id: p.id, title: idea.title, format: idea.format, concept: idea.concept, why: idea.why, draft: idea.draft ?? null, product: brief(p.products) });
    } else {
      group.progress.push({
        id: p.id,
        requestId: p.shoot_requests?.id ?? null,
        status: p.status,
        title: idea?.title ?? null,
        humanBrief: p.human_brief,
        product: brief(p.products),
        note: p.note,
        error: p.error,
        issues: ((p.check_result as { issues?: { detail: string }[] } | null)?.issues ?? []).map((i) => i.detail),
      });
    }
  }
  const accounts = [...groups.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  const working = (plans ?? []).some((p) => p.status === "CONFIRMED") || accounts.some(([, g]) => !g.off && g.ideas.length === 0);
  const ideaCount = accounts.reduce((n, [, g]) => n + g.ideas.length, 0);
  // 계정을 안 고르면 고를 기획이 있는 첫 계정
  const activeId = accounts.some(([id]) => id === accountParam) ? (accountParam as string) : (accounts.find(([, g]) => g.ideas.length > 0) ?? accounts[0])?.[0];
  const active = accounts.find(([id]) => id === activeId);
  const tabs = accounts.map(([id, g]) => ({ key: id, label: `@${g.name}`, count: g.ideas.length, href: `/shoot/plans?account=${id}` }));

  return (
    <main className="space-y-6 p-4 sm:p-6">
      <AutoRefresh active={working} />
      <header>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold tracking-[-0.01em]">촬영 기획 고르기</h1>
          {ideaCount > 0 && <Badge variant="outline">기획 {ideaCount}개</Badge>}
        </div>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          AI가 계정마다 찍을 거리를 {LIST_SIZE}개씩 준비해 둬요. <b>대본을 읽어 보고 하나를 고르거나 원하는 상품을 추가</b>하세요. 고르면 AI가 찍을 컷 목록을 만들어{" "}
          <Link href="/shoot/uploads" className="underline">
            촬영 · 올리기
          </Link>
          에 올려 둬요. 매일 새벽 판매 중인지 확인하고, 14일 동안 안 고른 기획은 새 기획으로 바꿔요.
          {!canManage && " 고르기 · 추가는 관리자 · 매니저만 할 수 있어요."}
        </p>
      </header>

      {accounts.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Clapperboard className="size-10 text-muted-foreground" />
            <h2 className="text-base font-semibold">기획을 만들 계정이 없어요</h2>
            <p className="max-w-md text-sm text-muted-foreground">촬영 설정에서 계정을 추가하면 몇 분 뒤 기획이 생겨요.</p>
            <Link href="/shoot/settings" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
              촬영 설정으로
            </Link>
          </CardContent>
        </Card>
      ) : (
        <>
          <AccountTabs tabs={tabs} active={activeId ?? ""} label="계정별 기획" />
          {active &&
            (() => {
              const [accountId, g] = active;
              return (
                <section className="space-y-4" aria-label={`@${g.name} 기획`}>
                  {g.off && (
                    <p className="rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">
                      계정 연결이 끊겨 새 기획을 만들지 못해요.{" "}
                      <Link href="/accounts" className="font-semibold underline">
                        계정 연동에서 다시 연결
                      </Link>
                      해 주세요.
                    </p>
                  )}
                  {g.progress.length > 0 && (
                    <div className="space-y-2">
                      <h2 className="text-[15px] font-semibold">
                        진행 중 <span className="text-xs font-medium text-muted-foreground tabular-nums">{g.progress.length}개</span>
                      </h2>
                      <ul className="space-y-2">
                        {g.progress.map((p) => (
                          <ShootProgressRow key={p.id} plan={p} canManage={canManage} />
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <h2 className="text-[15px] font-semibold">
                        고를 기획 <span className="text-xs font-medium text-muted-foreground tabular-nums">{g.ideas.length}개</span>
                      </h2>
                      {canManage && <ShootAccountActions accountId={accountId} name={g.name} listCount={g.ideas.length} />}
                    </div>
                    {g.ideas.length > 0 ? (
                      <ShootIdeaList ideas={g.ideas} account={g.name} canManage={canManage} />
                    ) : (
                      <p className="rounded-md border border-dashed bg-card px-4 py-6 text-center text-[13px] text-muted-foreground">
                        {g.off ? "고를 기획이 없어요." : "기획을 만드는 중이거나 고를 후보가 모자라요. 몇 분 뒤에도 없으면 촬영 설정의 쓸 상품을 확인해 주세요."}
                      </p>
                    )}
                  </div>
                </section>
              );
            })()}
        </>
      )}
    </main>
  );
}
