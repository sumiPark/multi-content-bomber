"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Copy, ExternalLink, Plus } from "lucide-react";
import { createPage } from "@/app/(dashboard)/moa/actions";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { PlatformIcon } from "@/components/ui/platform-icon";
import { toast } from "@/components/ui/toast";
import { formatRate, rate, type PageTotals } from "@/lib/moa/stats";
import { PAGE_STATUS_LABEL, type MoaPageStatus } from "@/lib/moa/types";

export interface MoaAccountRow {
  accountId: string;
  platform: "YOUTUBE" | "INSTAGRAM" | "TIKTOK" | "THREADS";
  accountName: string;
  accountAvatar: string | null;
  page: {
    id: string;
    slug: string;
    url: string;
    title: string;
    status: MoaPageStatus;
    totals: PageTotals;
    issues: { gray: number; deleted: number; failing: number };
  } | null;
}

const STATUS_VARIANT: Record<MoaPageStatus, "ok" | "secondary" | "warn"> = {
  PUBLISHED: "ok",
  DRAFT: "secondary",
  PAUSED: "warn",
};

export function MoaListPage({ rows, canManage }: { rows: MoaAccountRow[]; canManage: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  const create = (accountId: string) => {
    setBusyId(accountId);
    start(async () => {
      const res = await createPage({ socialAccountId: accountId });
      setBusyId(null);
      if (!res.ok) {
        toast(res.error, "risk");
        return;
      }
      toast("페이지를 만들었어요. 꾸민 뒤 공개해 주세요.");
      router.push(`/moa/${res.pageId}`);
    });
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast("주소를 복사했어요.");
    } catch {
      toast("복사하지 못했어요. 주소를 직접 선택해 복사해 주세요.", "risk");
    }
  };

  const withPage = rows.filter((r) => r.page);
  const sum = withPage.reduce(
    (acc, r) => ({ visits: acc.visits + r.page!.totals.visits, clicks: acc.clicks + r.page!.totals.clicks, clickVisits: acc.clickVisits + r.page!.totals.clickVisits }),
    { visits: 0, clicks: 0, clickVisits: 0 },
  );

  return (
    <main className="space-y-6 p-4 sm:p-6">
      <header className="space-y-1.5">
        <h1 className="text-xl font-bold tracking-[-0.01em]">모아링크</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          계정마다 프로필에 넣는 링크 모음 페이지예요(moa.cuma.co.kr/계정). 상품은 판매 상태를 3분마다 확인해 품절이면 회색으로 바꾸고, 방문 · 클릭을 집계해요.
        </p>
      </header>

      <section className="grid gap-3 sm:grid-cols-3" aria-label="최근 7일 합계">
        <Kpi label="만든 페이지" value={`${withPage.length}개`} sub={`공개 중 ${withPage.filter((r) => r.page!.status === "PUBLISHED").length}개`} />
        <Kpi label="방문 (최근 7일)" value={sum.visits.toLocaleString("ko-KR")} sub="모든 페이지 합계" />
        <Kpi label="클릭 (최근 7일)" value={sum.clicks.toLocaleString("ko-KR")} sub={`클릭 전환율 ${formatRate(rate(sum.clickVisits, sum.visits))}`} />
      </section>

      <section className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full min-w-[860px] text-sm">
          <thead className="bg-surface-2 text-left text-xs text-muted-foreground">
            <tr>
              <th className="h-11 px-3.5 font-medium">계정</th>
              <th className="px-3.5 font-medium">상태</th>
              <th className="px-3.5 font-medium">주소</th>
              <th className="px-3.5 text-right font-medium">방문 (7일)</th>
              <th className="px-3.5 text-right font-medium">클릭 (7일)</th>
              <th className="px-3.5 text-right font-medium">클릭 전환율</th>
              <th className="px-3.5 font-medium">확인할 것</th>
              <th className="px-3.5" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3.5 py-10 text-center text-muted-foreground">
                  연결된 계정이 없어요. 계정 연동에서 먼저 연결해 주세요.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const p = r.page;
              const issueText = p
                ? [
                    p.issues.gray > 0 ? `품절 · 판매 종료 ${p.issues.gray}개` : null,
                    p.issues.deleted > 0 ? `몰에서 삭제 ${p.issues.deleted}개` : null,
                    p.issues.failing > 0 ? `판매 상태 확인 실패 ${p.issues.failing}개` : null,
                  ].filter(Boolean)
                : [];
              return (
                <tr key={r.accountId} className="h-[52px] border-t">
                  <td className="px-3.5">
                    <div className="flex items-center gap-2">
                      <PlatformIcon platform={r.platform} size={18} />
                      <span className="font-medium">{r.accountName}</span>
                    </div>
                  </td>
                  <td className="px-3.5">
                    {p ? <Badge variant={STATUS_VARIANT[p.status]}>{PAGE_STATUS_LABEL[p.status]}</Badge> : <span className="text-xs text-faint">페이지 없음</span>}
                  </td>
                  <td className="px-3.5">
                    {p ? (
                      <div className="flex items-center gap-1">
                        <span className="text-ink-2">moa.cuma.co.kr/{p.slug}</span>
                        <Button variant="ghost" size="icon-sm" aria-label="주소 복사" onClick={() => copy(p.url)}>
                          <Copy />
                        </Button>
                        <a
                          href={`/m/${p.slug}`}
                          target="_blank"
                          rel="noreferrer"
                          aria-label="새 탭에서 열기"
                          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
                        >
                          <ExternalLink className="size-4" />
                        </a>
                      </div>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3.5 text-right tabular-nums">{p ? p.totals.visits.toLocaleString("ko-KR") : "—"}</td>
                  <td className="px-3.5 text-right tabular-nums">{p ? p.totals.clicks.toLocaleString("ko-KR") : "—"}</td>
                  <td className="px-3.5 text-right tabular-nums">{p ? formatRate(rate(p.totals.clickVisits, p.totals.visits)) : "—"}</td>
                  <td className="px-3.5">
                    {issueText.length > 0 ? (
                      <span className="inline-flex items-center gap-1 text-xs text-warn">
                        <AlertTriangle className="size-3.5" aria-hidden />
                        {issueText.join(" · ")}
                      </span>
                    ) : (
                      <span className="text-xs text-faint">없음</span>
                    )}
                  </td>
                  <td className="px-3.5 text-right whitespace-nowrap">
                    {p ? (
                      <div className="flex justify-end gap-1.5">
                        <Link href={`/moa/${p.id}?tab=stats`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                          통계
                        </Link>
                        <Link href={`/moa/${p.id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                          꾸미기
                        </Link>
                      </div>
                    ) : canManage ? (
                      <Button size="sm" onClick={() => create(r.accountId)} disabled={pending}>
                        <Plus />
                        {busyId === r.accountId ? "만드는 중…" : "페이지 만들기"}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </main>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}
