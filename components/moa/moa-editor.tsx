"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Copy, ExternalLink, Pause, Play, RefreshCw } from "lucide-react";
import { refreshPageProducts, setPageStatus } from "@/app/(dashboard)/moa/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { toast } from "@/components/ui/toast";
import type { BlockTotals, DayPoint, PageTotals } from "@/lib/moa/stats";
import type { MoaTheme } from "@/lib/moa/theme";
import { PAGE_STATUS_LABEL, type MoaBlockKind, type MoaPageView as PageData } from "@/lib/moa/types";
import { cn } from "@/lib/utils";
import { BlockList } from "./block-list";
import { DesignForm } from "./design-form";
import { MoaPageView } from "./moa-page-view";
import { MoaStats } from "./moa-stats";
import { SettingsForm } from "./settings-form";

export interface MoaStatsView {
  /** 기간(일) */
  days: number;
  totals: PageTotals;
  daily: DayPoint[];
  sources: (PageTotals & { source: string })[];
  blocks: BlockTotals[];
  blockMeta: { id: string; kind: MoaBlockKind; name: string; inAutoSection: boolean; deleted: boolean }[];
}

type Tab = "blocks" | "design" | "settings" | "stats";

const TAB_LABEL: Record<Tab, string> = { blocks: "블록", design: "꾸미기", settings: "설정", stats: "통계" };

export function MoaEditor({
  page,
  tab,
  url,
  accountName,
  organizationId,
  canManage,
  otherPages,
  stats,
}: {
  page: PageData;
  tab: Tab;
  url: string;
  accountName: string | null;
  organizationId: string;
  canManage: boolean;
  otherPages: { id: string; label: string }[];
  stats: MoaStatsView | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [draftTheme, setDraftTheme] = useState<MoaTheme | null>(null);
  const [confirmPause, setConfirmPause] = useState(false);
  // 미리보기 기준 시각 (공개 기간 판정)
  const [now] = useState(() => Date.now());

  const preview: PageData = draftTheme ? { ...page, theme: draftTheme } : page;

  const changeStatus = (status: "PUBLISHED" | "PAUSED") => {
    start(async () => {
      const res = await setPageStatus({ pageId: page.id, status });
      if (!res.ok) return toast(res.error, "risk");
      toast(status === "PUBLISHED" ? "페이지를 공개했어요." : "페이지를 일시 중지했어요.");
      setConfirmPause(false);
      router.refresh();
    });
  };

  const checkNow = () => {
    start(async () => {
      const res = await refreshPageProducts({ pageId: page.id });
      if (!res.ok) return toast(res.error, "risk");
      toast(res.failed > 0 ? `상품 ${res.checked}개를 확인했어요. ${res.failed}개는 몰 응답이 없어 마지막 상태를 유지했어요.` : `상품 ${res.checked}개의 판매 상태를 확인했어요.`);
      router.refresh();
    });
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast("주소를 복사했어요.");
    } catch {
      toast("복사하지 못했어요.", "risk");
    }
  };

  return (
    <main className="space-y-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <Link href="/moa" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" /> 모아링크 목록
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold tracking-[-0.01em]">{page.title || `@${page.slug}`}</h1>
            <Badge variant={page.status === "PUBLISHED" ? "ok" : page.status === "PAUSED" ? "warn" : "secondary"}>{PAGE_STATUS_LABEL[page.status]}</Badge>
          </div>
          <div className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
            {accountName && <span>{accountName} 계정 · </span>}
            <span className="text-ink-2">moa.cuma.co.kr/{page.slug}</span>
            <Button variant="ghost" size="icon-sm" aria-label="주소 복사" onClick={copy}>
              <Copy />
            </Button>
            <a
              href={`/m/${page.slug}`}
              target="_blank"
              rel="noreferrer"
              aria-label="새 탭에서 열기"
              className="inline-flex size-8 items-center justify-center rounded-md hover:bg-muted"
            >
              <ExternalLink className="size-4" />
            </a>
          </div>
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={checkNow} disabled={pending}>
              <RefreshCw /> 판매 상태 지금 확인
            </Button>
            {page.status === "PUBLISHED" ? (
              <Button variant="outline" onClick={() => setConfirmPause(true)} disabled={pending}>
                <Pause /> 일시 중지
              </Button>
            ) : (
              <Button onClick={() => changeStatus("PUBLISHED")} disabled={pending}>
                <Play /> {page.status === "PAUSED" ? "다시 공개하기" : "공개하기"}
              </Button>
            )}
          </div>
        )}
      </header>

      {page.status === "DRAFT" && (
        <p className="rounded-lg bg-brand-soft px-4 py-3 text-sm text-ink-2">
          아직 비공개예요. 블록과 디자인을 정리한 뒤 “공개하기”를 누르면 moa.cuma.co.kr/{page.slug}에서 열리고 방문 · 클릭이 집계돼요.
        </p>
      )}

      <nav className="inline-flex w-fit max-w-full items-center overflow-x-auto rounded-md border bg-surface-2 p-[2px]" aria-label="편집 메뉴">
        {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
          <Link
            key={t}
            href={`/moa/${page.id}${t === "blocks" ? "" : `?tab=${t}`}`}
            aria-current={t === tab ? "page" : undefined}
            className={cn(
              "inline-flex h-[30px] items-center rounded-[6px] px-4 text-xs font-medium whitespace-nowrap text-muted-foreground hover:text-foreground",
              t === tab && "bg-card font-semibold text-foreground shadow-[0_1px_2px_rgb(16_24_40/0.12)]",
            )}
          >
            {TAB_LABEL[t]}
          </Link>
        ))}
      </nav>

      {tab === "stats" && stats ? (
        <MoaStats pageId={page.id} stats={stats} />
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_400px]">
          <div className="min-w-0">
            {tab === "blocks" && <BlockList page={page} organizationId={organizationId} canManage={canManage} />}
            {tab === "design" && (
              <DesignForm page={page} organizationId={organizationId} canManage={canManage} otherPages={otherPages} onDraft={setDraftTheme} />
            )}
            {tab === "settings" && <SettingsForm page={page} organizationId={organizationId} canManage={canManage} />}
          </div>
          <aside className="lg:sticky lg:top-20" aria-label="휴대폰 미리보기">
            <p className="mb-2 text-xs text-muted-foreground">미리보기 — 방문자에게 보이는 모습(지금 시각 기준). 미리보기는 집계하지 않아요.</p>
            <div className="mx-auto h-[720px] w-full max-w-[390px] overflow-y-auto rounded-[28px] border-[6px] border-foreground/85 bg-card">
              <MoaPageView page={preview} now={now} linkBase={null} emptyHint="보이는 블록이 없어요. 왼쪽에서 블록을 추가해 주세요." />
            </div>
          </aside>
        </div>
      )}

      <ConfirmDialog
        open={confirmPause}
        title="페이지를 일시 중지할까요?"
        confirmLabel="일시 중지"
        pending={pending}
        onConfirm={() => changeStatus("PAUSED")}
        onClose={() => setConfirmPause(false)}
      >
        <p className="text-sm text-ink-2">
          방문자에게는 “페이지를 잠시 정리하고 있어요” 안내만 보여요. 프로필에 이 주소가 걸려 있다면 그동안 상품 링크를 누를 수 없어요.
        </p>
      </ConfirmDialog>
    </main>
  );
}
