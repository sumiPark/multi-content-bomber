"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  CircleAlert,
  Clock,
  ExternalLink,
  Loader2,
  RefreshCw,
  Trash2,
  X,
  XIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PlatformIcon } from "@/components/ui/platform-icon";
import { RelativeTime } from "@/components/ui/relative-time";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  cancelPostingsAction,
  deletePostingsAction,
  retryPostingsAction,
  type PostingActionResult,
} from "@/app/(dashboard)/postings/actions";

type PublishStatus =
  | "PENDING"
  | "PROCESSING"
  | "SUCCESS"
  | "FAILED"
  | "RETRYING"
  | "CANCELLED";

type Platform = "YOUTUBE" | "INSTAGRAM" | "TIKTOK";

// 기획서의 6가지 사용자 보기 상태 — 백엔드 enum + scheduled_for로 파생.
type DisplayStatus =
  | "scheduled"
  | "uploading"
  | "completed"
  | "failed"
  | "pending"
  | "cancelled";

export interface PostingItem {
  id: string;
  contentId: string;
  socialAccountId: string;
  postType: string;
  status: PublishStatus;
  scheduledFor: string | null;
  attempts: number;
  lastError: string | null;
  platformPostId: string | null;
  platformPostUrl: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  thumbnailUrl: string | null;
  mediaType: "IMAGE" | "VIDEO";
  mediaCount: number;
  captions: unknown;
  internalTitle: string | null;
  account: {
    id: string;
    platform: Platform;
    displayName: string | null;
    avatarUrl: string | null;
  };
}

interface PostingsPageProps {
  initialPostings: PostingItem[];
  canManage: boolean;
}


const STATUS_LABEL: Record<DisplayStatus, string> = {
  scheduled: "예약중",
  uploading: "업로드중",
  completed: "완료",
  failed: "실패",
  pending: "대기",
  cancelled: "취소됨",
};

const STATUS_BADGE_CLASS: Record<DisplayStatus, string> = {
  scheduled: "bg-amber-100 text-amber-800 border-amber-300",
  uploading: "bg-blue-100 text-blue-800 border-blue-300",
  completed: "bg-green-100 text-green-800 border-green-300",
  failed: "bg-red-100 text-red-800 border-red-300",
  pending: "bg-zinc-100 text-zinc-700 border-zinc-300",
  cancelled: "bg-zinc-100 text-zinc-500 border-zinc-300",
};

const ALL_STATUSES: DisplayStatus[] = [
  "scheduled",
  "uploading",
  "completed",
  "failed",
  "pending",
  "cancelled",
];

const ALL_PLATFORMS: Platform[] = ["YOUTUBE", "INSTAGRAM", "TIKTOK"];

type PeriodPreset = "today" | "7d" | "30d" | "all";

const PERIOD_LABEL: Record<PeriodPreset, string> = {
  today: "오늘",
  "7d": "최근 7일",
  "30d": "최근 30일",
  all: "전체",
};

type SortKey = "scheduled" | "created" | "status";

const SORT_LABEL: Record<SortKey, string> = {
  scheduled: "예약 시간순",
  created: "생성 시간순",
  status: "상태순",
};

const SORT_PRIORITY: Record<DisplayStatus, number> = {
  failed: 0,
  uploading: 1,
  scheduled: 2,
  pending: 3,
  completed: 4,
  cancelled: 5,
};

function getDisplayStatus(
  status: PublishStatus,
  scheduledFor: string | null,
): DisplayStatus {
  if (status === "SUCCESS") return "completed";
  if (status === "FAILED") return "failed";
  if (status === "PROCESSING" || status === "RETRYING") return "uploading";
  if (status === "CANCELLED") return "cancelled";
  // PENDING
  if (scheduledFor && new Date(scheduledFor).getTime() > Date.now()) {
    return "scheduled";
  }
  return "pending";
}

function periodToSinceMs(p: PeriodPreset): number | null {
  const day = 24 * 60 * 60 * 1000;
  if (p === "today") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return start.getTime();
  }
  if (p === "7d") return Date.now() - 7 * day;
  if (p === "30d") return Date.now() - 30 * day;
  return null;
}

function captionPreview(captions: unknown, maxLen = 30): string {
  if (!captions || typeof captions !== "object") return "(캡션 없음)";
  const c = captions as Record<string, { caption?: string; title?: string }>;
  const text =
    c.youtube?.title ??
    c.instagram?.caption ??
    c.tiktok?.caption ??
    "(캡션 없음)";
  return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
}

function displayLabel(item: { internalTitle: string | null; captions: unknown }): string {
  if (item.internalTitle && item.internalTitle.trim()) return item.internalTitle;
  return captionPreview(item.captions);
}

export function PostingsPage({
  initialPostings,
  canManage,
}: PostingsPageProps) {
  const router = useRouter();

  const [statusFilter, setStatusFilter] = useState<Set<DisplayStatus>>(
    () => new Set(ALL_STATUSES),
  );
  const [platformFilter, setPlatformFilter] = useState<Set<Platform>>(
    () => new Set(ALL_PLATFORMS),
  );
  const [period, setPeriod] = useState<PeriodPreset>("7d");
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("scheduled");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detailItem, setDetailItem] = useState<PostingItem | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // 검색 디바운스 300ms
  useEffect(() => {
    const t = setTimeout(() => setSearchQuery(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // 모든 데이터에 display status를 미리 계산 (정렬·필터·요약 모두 사용)
  const enriched = useMemo(
    () =>
      initialPostings.map((p) => ({
        ...p,
        displayStatus: getDisplayStatus(p.status, p.scheduledFor),
      })),
    [initialPostings],
  );

  // 자동 새로고침: PROCESSING/PENDING(scheduled 포함) 1건이라도 있으면 10초마다.
  const hasActive = useMemo(
    () =>
      enriched.some(
        (p) =>
          p.displayStatus === "uploading" ||
          p.displayStatus === "scheduled" ||
          p.displayStatus === "pending",
      ),
    [enriched],
  );
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (refreshTimer.current) clearInterval(refreshTimer.current);
    if (!hasActive) return;
    refreshTimer.current = setInterval(() => {
      router.refresh();
    }, 10000);
    return () => {
      if (refreshTimer.current) clearInterval(refreshTimer.current);
    };
  }, [hasActive, router]);

  // 기간 + 플랫폼 + 상태 + 검색 적용
  const filtered = useMemo(() => {
    const since = periodToSinceMs(period);
    const q = searchQuery.toLowerCase();
    let list = enriched.filter((p) => {
      if (!statusFilter.has(p.displayStatus)) return false;
      if (!platformFilter.has(p.account.platform)) return false;
      if (since !== null && new Date(p.createdAt).getTime() < since)
        return false;
      if (q) {
        const accountName = (p.account.displayName ?? "").toLowerCase();
        const cap = captionPreview(p.captions, 200).toLowerCase();
        const internal = (p.internalTitle ?? "").toLowerCase();
        if (
          !accountName.includes(q) &&
          !cap.includes(q) &&
          !internal.includes(q)
        )
          return false;
      }
      return true;
    });

    if (sortKey === "scheduled") {
      list = [...list].sort((a, b) => {
        const av = a.scheduledFor ? new Date(a.scheduledFor).getTime() : 0;
        const bv = b.scheduledFor ? new Date(b.scheduledFor).getTime() : 0;
        return bv - av;
      });
    } else if (sortKey === "created") {
      list = [...list].sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    } else {
      list = [...list].sort(
        (a, b) => SORT_PRIORITY[a.displayStatus] - SORT_PRIORITY[b.displayStatus],
      );
    }
    return list;
  }, [enriched, statusFilter, platformFilter, period, searchQuery, sortKey]);

  // 상태 요약: 필터(검색·기간·플랫폼)는 적용하되 상태 필터는 제외 (요약은 전체 상태를 보여주는 게 자연스러움)
  const summaryBase = useMemo(() => {
    const since = periodToSinceMs(period);
    const q = searchQuery.toLowerCase();
    return enriched.filter((p) => {
      if (!platformFilter.has(p.account.platform)) return false;
      if (since !== null && new Date(p.createdAt).getTime() < since)
        return false;
      if (q) {
        const accountName = (p.account.displayName ?? "").toLowerCase();
        const cap = captionPreview(p.captions, 200).toLowerCase();
        const internal = (p.internalTitle ?? "").toLowerCase();
        if (
          !accountName.includes(q) &&
          !cap.includes(q) &&
          !internal.includes(q)
        )
          return false;
      }
      return true;
    });
  }, [enriched, platformFilter, period, searchQuery]);

  const summary = useMemo(() => {
    const counts: Record<DisplayStatus | "total", number> = {
      total: summaryBase.length,
      scheduled: 0,
      uploading: 0,
      completed: 0,
      failed: 0,
      pending: 0,
      cancelled: 0,
    };
    for (const p of summaryBase) counts[p.displayStatus] += 1;
    return counts;
  }, [summaryBase]);

  // 일괄 선택 토글
  function toggleSelectAll(checked: boolean) {
    if (!checked) {
      setSelected(new Set());
      return;
    }
    setSelected(new Set(filtered.map((p) => p.id)));
  }
  function toggleOne(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleStatus(s: DisplayStatus) {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }
  function togglePlatform(p: Platform) {
    setPlatformFilter((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  function jumpToStatus(s: DisplayStatus) {
    setStatusFilter(new Set([s]));
  }

  // 액션: 일괄 + 단건 모두 같은 액션 사용 (배열로 전달)
  function runAction(
    action: (input: { ids: string[] }) => Promise<PostingActionResult>,
    ids: string[],
    successLabel: string,
    confirmMessage?: string,
  ) {
    if (ids.length === 0) return;
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    startTransition(async () => {
      setActionMessage(null);
      const result = await action({ ids });
      if (result.ok) {
        setActionMessage(`${successLabel} ${result.affected}건 처리됨`);
        setSelected(new Set());
        router.refresh();
      } else {
        setActionMessage(result.error);
      }
    });
  }

  const selectedItems = filtered.filter((p) => selected.has(p.id));
  const selectedFailedCount = selectedItems.filter(
    (p) => p.displayStatus === "failed",
  ).length;
  const selectedScheduledCount = selectedItems.filter(
    (p) =>
      p.displayStatus === "scheduled" || p.displayStatus === "pending",
  ).length;

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">포스팅 관리</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            예약·업로드·실패 상태를 한눈에 확인하고 일괄 작업할 수 있어요.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => router.refresh()}
          disabled={isPending}
        >
          <RefreshCw
            className={cn("size-4", isPending && "animate-spin")}
          />
          새로고침
        </Button>
      </header>

      {actionMessage && (
        <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
          {actionMessage}
        </div>
      )}

      <SummaryCards
        summary={summary}
        statusFilter={statusFilter}
        onJump={jumpToStatus}
      />

      <FiltersBar
        statusFilter={statusFilter}
        platformFilter={platformFilter}
        period={period}
        sortKey={sortKey}
        searchInput={searchInput}
        onToggleStatus={toggleStatus}
        onTogglePlatform={togglePlatform}
        onChangePeriod={setPeriod}
        onChangeSort={setSortKey}
        onChangeSearch={setSearchInput}
      />

      {selected.size > 0 && canManage && (
        <BulkActionBar
          selectedCount={selected.size}
          failedCount={selectedFailedCount}
          scheduledCount={selectedScheduledCount}
          isPending={isPending}
          onRetry={() =>
            runAction(
              retryPostingsAction,
              selectedItems
                .filter((p) => p.displayStatus === "failed")
                .map((p) => p.id),
              "재시도",
            )
          }
          onCancel={() =>
            runAction(
              cancelPostingsAction,
              selectedItems
                .filter(
                  (p) =>
                    p.displayStatus === "scheduled" ||
                    p.displayStatus === "pending",
                )
                .map((p) => p.id),
              "예약 취소",
              "선택한 예약을 취소할까요? Phase 4b 워커가 활성화되면 자동 게시도 중단됩니다.",
            )
          }
          onDelete={() =>
            runAction(
              deletePostingsAction,
              selectedItems.map((p) => p.id),
              "삭제(soft)",
              `${selected.size}건을 보관함에서 숨길까요? (실제 삭제 아님)`,
            )
          }
          onClear={() => setSelected(new Set())}
        />
      )}

      <PostingsTable
        items={filtered}
        selected={selected}
        canManage={canManage}
        isPending={isPending}
        onToggleAll={toggleSelectAll}
        onToggleOne={toggleOne}
        onSelectDetail={setDetailItem}
        onRetry={(id) =>
          runAction(retryPostingsAction, [id], "재시도")
        }
        onCancel={(id) =>
          runAction(
            cancelPostingsAction,
            [id],
            "예약 취소",
            "이 예약을 취소할까요?",
          )
        }
        onDelete={(id) =>
          runAction(
            deletePostingsAction,
            [id],
            "삭제(soft)",
            "이 포스팅을 보관함에서 숨길까요? (실제 삭제 아님)",
          )
        }
      />

      {detailItem && (
        <DetailDialog
          item={detailItem}
          canManage={canManage}
          isPending={isPending}
          onClose={() => setDetailItem(null)}
          onRetry={(id) =>
            runAction(retryPostingsAction, [id], "재시도")
          }
          onCancel={(id) =>
            runAction(
              cancelPostingsAction,
              [id],
              "예약 취소",
              "이 예약을 취소할까요?",
            )
          }
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary cards
// ─────────────────────────────────────────────────────────────────────────────

function SummaryCards({
  summary,
  statusFilter,
  onJump,
}: {
  summary: Record<DisplayStatus | "total", number>;
  statusFilter: Set<DisplayStatus>;
  onJump: (s: DisplayStatus) => void;
}) {
  const cards: Array<{
    key: DisplayStatus | "total";
    label: string;
    accent?: string;
  }> = [
    { key: "total", label: "전체" },
    { key: "scheduled", label: "예약중", accent: "text-amber-600" },
    { key: "uploading", label: "업로드중", accent: "text-blue-600" },
    { key: "completed", label: "완료", accent: "text-green-600" },
    { key: "failed", label: "실패", accent: "text-destructive" },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {cards.map((c) => {
        const count = summary[c.key];
        const isClickable = c.key !== "total";
        const isActive =
          c.key !== "total" &&
          statusFilter.size === 1 &&
          statusFilter.has(c.key as DisplayStatus);
        return (
          <button
            key={c.key}
            type="button"
            onClick={
              isClickable ? () => onJump(c.key as DisplayStatus) : undefined
            }
            disabled={!isClickable}
            className={cn(
              "rounded-md border p-3 text-left transition",
              isClickable && "hover:bg-accent/40 cursor-pointer",
              isActive && "ring-2 ring-primary",
              c.key === "failed" && count > 0 && "border-destructive/40 bg-destructive/5",
            )}
          >
            <p className="text-xs text-muted-foreground">{c.label}</p>
            <p className={cn("mt-1 text-2xl font-bold", c.accent)}>{count}</p>
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Filters bar
// ─────────────────────────────────────────────────────────────────────────────

function FiltersBar({
  statusFilter,
  platformFilter,
  period,
  sortKey,
  searchInput,
  onToggleStatus,
  onTogglePlatform,
  onChangePeriod,
  onChangeSort,
  onChangeSearch,
}: {
  statusFilter: Set<DisplayStatus>;
  platformFilter: Set<Platform>;
  period: PeriodPreset;
  sortKey: SortKey;
  searchInput: string;
  onToggleStatus: (s: DisplayStatus) => void;
  onTogglePlatform: (p: Platform) => void;
  onChangePeriod: (p: PeriodPreset) => void;
  onChangeSort: (k: SortKey) => void;
  onChangeSearch: (v: string) => void;
}) {
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            상태
          </span>
          {ALL_STATUSES.map((s) => {
            const on = statusFilter.has(s);
            return (
              <button
                key={s}
                type="button"
                onClick={() => onToggleStatus(s)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs transition",
                  on
                    ? STATUS_BADGE_CLASS[s]
                    : "border-border bg-background text-muted-foreground hover:bg-accent/40",
                )}
              >
                {STATUS_LABEL[s]}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            플랫폼
          </span>
          {ALL_PLATFORMS.map((p) => {
            const on = platformFilter.has(p);
            return (
              <button
                key={p}
                type="button"
                onClick={() => onTogglePlatform(p)}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition",
                  on
                    ? "border-foreground bg-foreground/5"
                    : "border-border bg-background text-muted-foreground hover:bg-accent/40",
                )}
              >
                <PlatformIcon platform={p} size={14} />
                {p}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Label htmlFor="period" className="text-xs">
              기간
            </Label>
            <select
              id="period"
              value={period}
              onChange={(e) => onChangePeriod(e.target.value as PeriodPreset)}
              className="rounded-md border bg-background px-2 py-1 text-sm"
            >
              {(Object.keys(PERIOD_LABEL) as PeriodPreset[]).map((p) => (
                <option key={p} value={p}>
                  {PERIOD_LABEL[p]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="sort" className="text-xs">
              정렬
            </Label>
            <select
              id="sort"
              value={sortKey}
              onChange={(e) => onChangeSort(e.target.value as SortKey)}
              className="rounded-md border bg-background px-2 py-1 text-sm"
            >
              {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
                <option key={k} value={k}>
                  {SORT_LABEL[k]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-1 min-w-[200px] items-center gap-2">
            <Input
              type="search"
              placeholder="콘텐츠·계정·캡션 검색..."
              value={searchInput}
              onChange={(e) => onChangeSearch(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Bulk action bar
// ─────────────────────────────────────────────────────────────────────────────

function BulkActionBar({
  selectedCount,
  failedCount,
  scheduledCount,
  isPending,
  onRetry,
  onCancel,
  onDelete,
  onClear,
}: {
  selectedCount: number;
  failedCount: number;
  scheduledCount: number;
  isPending: boolean;
  onRetry: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 p-3">
      <div className="flex items-center gap-2 text-sm">
        <Badge variant="secondary">{selectedCount}건 선택</Badge>
        <Button variant="ghost" size="sm" onClick={onClear}>
          <XIcon className="size-3" /> 해제
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          disabled={failedCount === 0 || isPending}
          title={failedCount === 0 ? "실패 항목이 없습니다" : undefined}
        >
          <RefreshCw className="size-3.5" /> 재시도 {failedCount}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onCancel}
          disabled={scheduledCount === 0 || isPending}
          title={scheduledCount === 0 ? "예약 항목이 없습니다" : undefined}
        >
          <X className="size-3.5" /> 예약 취소 {scheduledCount}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onDelete}
          disabled={isPending}
          className="text-destructive hover:text-destructive"
        >
          <Trash2 className="size-3.5" /> 삭제
        </Button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Table
// ─────────────────────────────────────────────────────────────────────────────

interface TableItem extends PostingItem {
  displayStatus: DisplayStatus;
}

function PostingsTable({
  items,
  selected,
  canManage,
  isPending,
  onToggleAll,
  onToggleOne,
  onSelectDetail,
  onRetry,
  onCancel,
  onDelete,
}: {
  items: TableItem[];
  selected: Set<string>;
  canManage: boolean;
  isPending: boolean;
  onToggleAll: (checked: boolean) => void;
  onToggleOne: (id: string, checked: boolean) => void;
  onSelectDetail: (item: PostingItem) => void;
  onRetry: (id: string) => void;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-sm text-muted-foreground">
          조건에 맞는 포스팅이 없어요.
          <br />
          필터를 조정하거나 새 콘텐츠를 등록해보세요.
        </CardContent>
      </Card>
    );
  }

  const allSelected = items.every((i) => selected.has(i.id));
  const someSelected = !allSelected && items.some((i) => selected.has(i.id));

  return (
    <Card>
      <CardContent className="p-0">
        <ScrollArea className="w-full">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/30 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                {canManage && (
                  <th className="w-10 px-3 py-2">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someSelected;
                      }}
                      onChange={(e) => onToggleAll(e.target.checked)}
                      className="size-4"
                    />
                  </th>
                )}
                <th className="px-3 py-2 text-left">콘텐츠</th>
                <th className="px-3 py-2 text-left">플랫폼</th>
                <th className="px-3 py-2 text-left">계정</th>
                <th className="px-3 py-2 text-left">상태</th>
                <th className="px-3 py-2 text-left">예약</th>
                <th className="px-3 py-2 text-left">게시</th>
                <th className="px-3 py-2 text-right">액션</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <Row
                  key={item.id}
                  item={item}
                  selected={selected.has(item.id)}
                  canManage={canManage}
                  isPending={isPending}
                  onToggle={onToggleOne}
                  onSelectDetail={onSelectDetail}
                  onRetry={onRetry}
                  onCancel={onCancel}
                  onDelete={onDelete}
                />
              ))}
            </tbody>
          </table>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

function Row({
  item,
  selected,
  canManage,
  isPending,
  onToggle,
  onSelectDetail,
  onRetry,
  onCancel,
  onDelete,
}: {
  item: TableItem;
  selected: boolean;
  canManage: boolean;
  isPending: boolean;
  onToggle: (id: string, checked: boolean) => void;
  onSelectDetail: (item: PostingItem) => void;
  onRetry: (id: string) => void;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const isFailed = item.displayStatus === "failed";
  const canRetry = isFailed;
  const canCancel =
    item.displayStatus === "pending" || item.displayStatus === "scheduled";

  return (
    <tr
      className={cn(
        "border-b transition hover:bg-accent/30",
        isFailed && "bg-destructive/5",
      )}
    >
      {canManage && (
        <td className="px-3 py-2">
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => onToggle(item.id, e.target.checked)}
            className="size-4"
          />
        </td>
      )}
      <td className="px-3 py-2">
        <button
          type="button"
          onClick={() => onSelectDetail(item)}
          className="flex items-center gap-2 text-left"
        >
          <div className="relative size-10 shrink-0 overflow-hidden rounded border bg-muted">
            {item.thumbnailUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={item.thumbnailUrl}
                alt=""
                className="size-full object-cover"
              />
            ) : null}
          </div>
          <div className="min-w-0">
            <p className="truncate text-xs font-medium">
              {displayLabel(item)}
            </p>
            <p className="line-clamp-1 text-[10px] text-muted-foreground">
              {item.internalTitle
                ? captionPreview(item.captions)
                : item.mediaType === "VIDEO"
                  ? "영상"
                  : `이미지 ${item.mediaCount}장`}
            </p>
          </div>
        </button>
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-1.5">
          <PlatformIcon platform={item.account.platform} size={16} />
          <span className="text-xs">{item.account.platform}</span>
        </div>
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-1.5">
          {item.account.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.account.avatarUrl}
              alt=""
              className="size-5 rounded-full object-cover"
            />
          ) : (
            <div className="size-5 rounded-full bg-muted" />
          )}
          <span className="truncate text-xs">
            {item.account.displayName ?? "(이름 없음)"}
          </span>
        </div>
      </td>
      <td className="px-3 py-2">
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium",
            STATUS_BADGE_CLASS[item.displayStatus],
          )}
        >
          {STATUS_LABEL[item.displayStatus]}
        </span>
        {isFailed && item.lastError && (
          <p
            className="mt-1 line-clamp-1 text-[10px] text-destructive"
            title={item.lastError}
          >
            {item.lastError}
          </p>
        )}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        {item.scheduledFor ? <RelativeTime iso={item.scheduledFor} /> : "즉시"}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        {item.completedAt ? <RelativeTime iso={item.completedAt} /> : "-"}
      </td>
      <td className="px-3 py-2 text-right">
        <div className="flex justify-end gap-1">
          {item.platformPostUrl && (
            <a
              href={item.platformPostUrl}
              target="_blank"
              rel="noreferrer"
              className={cn(
                buttonVariants({ variant: "ghost", size: "sm" }),
                "h-7 px-2",
              )}
              title="게시 글 열기"
            >
              <ExternalLink className="size-3.5" />
            </a>
          )}
          {canManage && canRetry && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={() => onRetry(item.id)}
              disabled={isPending}
              title="재시도"
            >
              <RefreshCw className="size-3.5" />
            </Button>
          )}
          {canManage && canCancel && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={() => onCancel(item.id)}
              disabled={isPending}
              title="예약 취소"
            >
              <X className="size-3.5" />
            </Button>
          )}
          {canManage && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-destructive hover:text-destructive"
              onClick={() => onDelete(item.id)}
              disabled={isPending}
              title="삭제(soft)"
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Detail dialog
// ─────────────────────────────────────────────────────────────────────────────

function DetailDialog({
  item,
  canManage,
  isPending,
  onClose,
  onRetry,
  onCancel,
}: {
  item: PostingItem;
  canManage: boolean;
  isPending: boolean;
  onClose: () => void;
  onRetry: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  const displayStatus = getDisplayStatus(item.status, item.scheduledFor);

  // ESC 닫기
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const captions = item.captions as
    | Record<
        "youtube" | "instagram" | "tiktok",
        | {
            title?: string;
            description?: string;
            caption?: string;
            hashtags?: string[];
            cover_text?: string;
          }
        | undefined
      >
    | null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg border bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2 border-b p-4">
          <div>
            <h2 className="text-lg font-semibold">
              {item.internalTitle?.trim() || "포스팅 상세"}
            </h2>
            <p className="text-xs text-muted-foreground">
              {item.account.platform} · {item.account.displayName}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <XIcon className="size-4" />
          </Button>
        </div>
        <div className="space-y-4 p-4">
          {item.thumbnailUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.thumbnailUrl}
              alt=""
              className="mx-auto max-h-72 rounded border object-contain"
            />
          )}

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 font-medium",
                STATUS_BADGE_CLASS[displayStatus],
              )}
            >
              {STATUS_LABEL[displayStatus]}
            </span>
            <span className="text-muted-foreground">
              생성: <RelativeTime iso={item.createdAt} />
            </span>
            {item.scheduledFor && (
              <span className="text-muted-foreground">
                예약: <RelativeTime iso={item.scheduledFor} />
              </span>
            )}
            {item.completedAt && (
              <span className="text-muted-foreground">
                완료: <RelativeTime iso={item.completedAt} />
              </span>
            )}
            {item.attempts > 0 && (
              <span className="text-muted-foreground">
                시도 {item.attempts}회
              </span>
            )}
          </div>

          {item.platformPostUrl && (
            <a
              href={item.platformPostUrl}
              target="_blank"
              rel="noreferrer"
              className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
            >
              <ExternalLink className="size-3.5" /> 게시 글 열기
            </a>
          )}

          {item.lastError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <div className="mb-1 flex items-center gap-1 text-xs font-medium text-destructive">
                <AlertTriangle className="size-3.5" /> 마지막 에러
              </div>
              <pre className="whitespace-pre-wrap break-all text-[11px] text-destructive">
                {item.lastError}
              </pre>
            </div>
          )}

          {captions && (
            <div className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground">
                캡션
              </p>
              {captions.youtube && (
                <CaptionBlock
                  title="YouTube"
                  primary={captions.youtube.title ?? ""}
                  body={captions.youtube.description ?? ""}
                  tags={captions.youtube.hashtags ?? []}
                />
              )}
              {captions.instagram && (
                <CaptionBlock
                  title="Instagram"
                  primary={captions.instagram.cover_text ?? ""}
                  body={captions.instagram.caption ?? ""}
                  tags={captions.instagram.hashtags ?? []}
                />
              )}
              {captions.tiktok && (
                <CaptionBlock
                  title="TikTok"
                  primary=""
                  body={captions.tiktok.caption ?? ""}
                  tags={captions.tiktok.hashtags ?? []}
                />
              )}
            </div>
          )}

          {canManage && (
            <div className="flex justify-end gap-2 border-t pt-4">
              {displayStatus === "failed" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    onRetry(item.id);
                    onClose();
                  }}
                  disabled={isPending}
                >
                  <RefreshCw className="size-3.5" /> 재시도
                </Button>
              )}
              {(displayStatus === "scheduled" ||
                displayStatus === "pending") && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    onCancel(item.id);
                    onClose();
                  }}
                  disabled={isPending}
                >
                  <X className="size-3.5" /> 예약 취소
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CaptionBlock({
  title,
  primary,
  body,
  tags,
}: {
  title: string;
  primary: string;
  body: string;
  tags: string[];
}) {
  return (
    <div className="rounded-md border bg-muted/20 p-3 text-xs">
      <p className="mb-1 font-medium">{title}</p>
      {primary && <p className="mb-1 font-semibold">{primary}</p>}
      <p className="whitespace-pre-wrap">{body}</p>
      {tags.length > 0 && (
        <p className="mt-2 text-sky-700">{tags.join(" ")}</p>
      )}
    </div>
  );
}
