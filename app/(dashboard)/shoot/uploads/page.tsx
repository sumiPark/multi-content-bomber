import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronRight, Video } from "lucide-react";
import { AccountTabs } from "@/components/shoot/account-tabs";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { ideaTitleOf, REQUEST_SELECT, REQUEST_STATUS, type RequestRow } from "@/lib/shoot/request-data";

// 촬영 · 올리기 목록 — 고른 기획을 짧은 줄로 보여 주고, 줄을 누르면 상세(/shoot/uploads/[id])에서 컷을 보고 올린다.

export const metadata = { title: "촬영 · 올리기 | MCB" };

// 사람 차례인 것부터
const ORDER: Record<string, number> = { OPEN: 0, FAILED: 1, EDITED: 2, UPLOADED: 3, EDITING: 4 };

export default async function ShootUploadsPage({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");
  const supabase = await getServerSupabase();
  const { account: accountParam } = await searchParams;

  const { data } = await supabase
    .from("shoot_requests")
    .select(REQUEST_SELECT)
    .in("status", ["OPEN", "UPLOADED", "EDITING", "EDITED", "FAILED"])
    // 올린 뒤의 기획은 완성본 받기에서 본다
    .in("content_plans.status", ["SCRIPTED", "SHOT", "RENDERED"])
    .order("created_at", { ascending: true });

  const rows = (data ?? [])
    .map((r) => {
      const row = r as unknown as RequestRow;
      const cuts = ((r.cuts ?? []) as unknown as { no: number; skipped?: boolean; seconds?: number }[]).filter((c) => !c.skipped);
      const clips = (r.clips ?? []) as unknown as { cut: number }[];
      const product = row.content_plans.products;
      return {
        id: r.id,
        status: r.status,
        accountId: r.content_plans.social_account_id,
        account: row.content_plans.social_accounts?.display_name ?? "",
        title: ideaTitleOf(row.content_plans.proposal) ?? product?.name ?? "기획",
        productName: product?.name ?? null,
        image: product?.represent_image_url ?? null,
        total: cuts.length,
        uploaded: cuts.filter((c) => clips.some((k) => k.cut === c.no)).length,
        seconds: Math.round(cuts.reduce((sum, c) => sum + (c.seconds ?? 0), 0)),
      };
    })
    .sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9));

  const accounts = new Map<string, { name: string; count: number }>();
  for (const r of rows) accounts.set(r.accountId, { name: r.account, count: (accounts.get(r.accountId)?.count ?? 0) + 1 });
  const active = accountParam && accounts.has(accountParam) ? accountParam : "all";
  const visible = active === "all" ? rows : rows.filter((r) => r.accountId === active);
  const open = rows.filter((r) => r.status === "OPEN").length;
  const working = rows.some((r) => r.status === "UPLOADED" || r.status === "EDITING");
  const tabs = [
    { key: "all", label: "전체", count: rows.length, href: "/shoot/uploads" },
    ...[...accounts.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([id, a]) => ({ key: id, label: `@${a.name}`, count: a.count, href: `/shoot/uploads?account=${id}` })),
  ];

  return (
    <main className="space-y-6 p-4 sm:p-6">
      <AutoRefresh active={working} />
      <header>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold tracking-[-0.01em]">촬영 · 올리기</h1>
          {open > 0 && <Badge>찍을 것 {open}건</Badge>}
        </div>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          찍을 영상을 눌러 컷 목록을 보고 <b>컷마다 휴대폰에서 바로 올리세요.</b> 다 올리면 AI가 컷을 잇고 화면 문구를 입혀요.
        </p>
      </header>

      {rows.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Video className="size-10 text-muted-foreground" />
            <h2 className="text-base font-semibold">지금 찍을 영상이 없어요</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              <Link href="/shoot/plans" className="underline">
                촬영 기획 고르기
              </Link>
              에서 찍을 거리를 고르면 몇 분 뒤 여기에 생겨요.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {accounts.size > 1 && <AccountTabs tabs={tabs} active={active} label="계정별 보기" />}
          <ul className="divide-y overflow-hidden rounded-lg border bg-card">
            {visible.map((r) => {
              const s = REQUEST_STATUS[r.status] ?? { label: r.status, variant: "outline" as const };
              const percent = r.total ? Math.round((r.uploaded / r.total) * 100) : 0;
              return (
                <li key={r.id}>
                  <Link href={`/shoot/uploads/${r.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2">
                    {r.image ? (
                      // 몰 CDN 이미지
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.image} alt="" className="size-12 shrink-0 rounded object-cover" />
                    ) : (
                      <span className="size-12 shrink-0 rounded bg-muted" />
                    )}
                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-sm font-semibold">{r.title}</span>
                        <Badge variant={s.variant}>{s.label}</Badge>
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        @{r.account}
                        {r.productName && r.productName !== r.title && ` · ${r.productName}`}
                      </span>
                      {r.status === "OPEN" && (
                        <span className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
                          <span className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-3" aria-hidden>
                            <span className="block h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
                          </span>
                          컷 {r.uploaded}/{r.total} 올림 · 약 {r.seconds}초
                        </span>
                      )}
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </main>
  );
}
