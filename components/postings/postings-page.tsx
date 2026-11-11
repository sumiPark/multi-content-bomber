"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Ban,
  CircleCheck,
  Clock,
  ExternalLink,
  EyeOff,
  Hourglass,
  Loader2,
  OctagonAlert,
  RefreshCw,
  Search,
  Trash2,
  Wand2,
  X,
  XIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PlatformIcon } from "@/components/ui/platform-icon";
import { RelativeTime } from "@/components/ui/relative-time";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";
import {
  cancelPostingsAction,
  deletePostingsAction,
  retryPostingsAction,
  type PostingActionResult,
} from "@/app/(dashboard)/postings/actions";
import { deleteContentsAction } from "@/app/(dashboard)/actions";

type PublishStatus =
  | "PENDING"
  | "PROCESSING"
  | "SUCCESS"
  | "FAILED"
  | "RETRYING"
  | "CANCELLED";

type Platform = "YOUTUBE" | "INSTAGRAM" | "TIKTOK" | "THREADS";

// 기획서의 6가지 사용자 보기 상태 — 백엔드 enum + scheduled_for로 파생.
export type DisplayStatus =
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
  // 파일과 캡션을 지운 콘텐츠 — 발행 기록만 남아 있다
  contentErased: boolean;
  mediaType: "IMAGE" | "VIDEO";
  mediaCount: number;
  captions: unknown;
  internalTitle: string | null;
  account: {
    id: string;
    platform: Platform;
    displayName: string | null;
    avatarUrl: string | null;
    disconnected: boolean;
  };
}

interface PostingsPageProps {
  initialPostings: PostingItem[];
  canManage: boolean;
  initialStatus?: DisplayStatus;
}


const STATUS_LABEL: Record<DisplayStatus, string> = {
  scheduled: "예약중",
  uploading: "올리는 중",
  completed: "완료",
  failed: "실패",
  pending: "대기",
  cancelled: "취소됨",
};

// DESIGN.md 2장 의미 색 — 예약중 warn · 올리는 중 파랑 · 완료 ok · 실패 risk · 대기 · 취소 회색.
const STATUS_BADGE_VARIANT: Record<
  DisplayStatus,
  "default" | "secondary" | "ok" | "warn" | "destructive"
> = {
  scheduled: "warn",
  uploading: "default",
  completed: "ok",
  failed: "destructive",
  pending: "secondary",
  cancelled: "secondary",
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

type SortKey = "published" | "created" | "status";

const SORT_LABEL: Record<SortKey, string> = {
  published: "올린 시각순",
  created: "만든 시각순",
  status: "상태순",
};

// 게시 시간순 정렬의 1차 키. 아직 게시되지 않은 건(예약·대기·업로드중·실패)을
// 위로 올리고, 끝난 건(게시 완료·취소)은 그 아래 한 타임라인에 섞는다. 실패는
// 재시도 대상이라 미게시와 같은 그룹에 둔다. 취소를 따로 맨 아래로 빼면 언제
// 게시하려던 건인지 알 수 없어서, 게시하려던 시각 기준으로 완료분 사이에 끼운다.
const PUBLISH_GROUP_RANK: Record<DisplayStatus, number> = {
  failed: 0,
  uploading: 0,
  scheduled: 0,
  pending: 0,
  completed: 1,
  cancelled: 1,
};

// 그룹 안에서 비교할 "발행 시각". 게시 완료는 실제 게시된 시각, 나머지(취소 포함)는
// 게시될/게시하려던 예정 시각을 쓴다. 즉시 발행은 scheduled_for가 null이므로 등록 시각을 예정 시각으로
// 본다 — 이게 없으면 즉시 발행분이 전부 0(1970년)이 되어 목록 맨 아래로 가라앉는다.
function publishTimeMs(p: {
  displayStatus: DisplayStatus;
  scheduledFor: string | null;
  completedAt: string | null;
  createdAt: string;
}): number {
  const iso =
    p.displayStatus === "completed"
      ? (p.completedAt ?? p.createdAt)
      : (p.scheduledFor ?? p.createdAt);
  return new Date(iso).getTime();
}

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

// 취소 가능: 아직 워커가 잡지 않은 건 — 예약/대기(PENDING)와 재시도 대기(RETRYING).
// PROCESSING은 워커가 처리 중이라 취소해도 워커의 결과 기록에 덮여 막을 수 없다.
function canCancelPosting(p: {
  status: PublishStatus;
  displayStatus: DisplayStatus;
}): boolean {
  return (
    p.displayStatus === "scheduled" ||
    p.displayStatus === "pending" ||
    p.status === "RETRYING"
  );
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
  // 글자 단위(코드 포인트)로 자른다 — 이모지 가운데가 잘리면 깨진 글자가 생기고 서버 · 브라우저 렌더가 달라진다
  const chars = Array.from(text);
  return chars.length > maxLen ? chars.slice(0, maxLen).join("") + "…" : text;
}

function displayLabel(item: { internalTitle: string | null; captions: unknown }): string {
  if (item.internalTitle && item.internalTitle.trim()) return item.internalTitle;
  return captionPreview(item.captions);
}

export function PostingsPage({
  initialPostings,
  canManage,
  initialStatus,
}: PostingsPageProps) {
  const router = useRouter();

  // 대시보드 · 편성표 링크(/postings?status=failed 등)로 들어오면 그 상태만 보이게(2026-11-04, 전엔 무시했다)
  const [statusFilter, setStatusFilter] = useState<Set<DisplayStatus>>(
    () => new Set(initialStatus ? [initialStatus] : ALL_STATUSES),
  );
  const [platformFilter, setPlatformFilter] = useState<Set<Platform>>(
    () => new Set(ALL_PLATFORMS),
  );
  // 실패 · 예약은 7일보다 오래된 것도 봐야 해서 상태로 들어오면 기간은 전체
  const [period, setPeriod] = useState<PeriodPreset>(initialStatus ? "all" : "7d");
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("published");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detailItem, setDetailItem] = useState<PostingItem | null>(null);
  // 결과 알림. ok면 오른쪽 아래 토스트(4초), 실패면 위쪽 빨간 상자(닫을 때까지).
  const [actionMessage, setActionMessage] = useState<{
    text: string;
    ok: boolean;
  } | null>(null);
  const [isPending, startTransition] = useTransition();

  // 콘텐츠 삭제 — 목록에서 숨기는 deletePostingsAction과 다르다. 파일과 캡션이 지워지고,
  // 이미 올라간 건은 발행 기록만 남는다(deleteContentsAction).
  function runDeleteContent(contentId: string, label: string) {
    const message = `'${label}'을(를) 삭제할까요? 되돌릴 수 없어요.\n\n올린 파일과 캡션이 지워져요. 이미 올라간 건은 발행 기록(언제 · 어느 계정 · 게시물 링크)만 남고, 아직 안 올라간 건은 기록까지 지워져요.\n(SNS에 올라간 게시물은 지워지지 않아요. 각 플랫폼에서 따로 지워 주세요.)`;
    if (!window.confirm(message)) return;
    startTransition(async () => {
      setActionMessage(null);
      const result = await deleteContentsAction({ contentIds: [contentId] });
      if (result.ok) {
        setDetailItem(null);
        setActionMessage({ text: result.notice ?? "콘텐츠를 삭제했어요", ok: true });
        router.refresh();
      } else {
        setActionMessage({ text: result.error, ok: false });
      }
    });
  }

  // 성공 토스트는 4초 뒤 닫는다.
  useEffect(() => {
    if (!actionMessage?.ok) return;
    const t = setTimeout(() => setActionMessage(null), 4000);
    return () => clearTimeout(t);
  }, [actionMessage]);

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

  // 자동 새로고침: 올리는 중 · 대기 중이면 10초마다, 예약만 있으면 1분마다, 다른 탭을 보는 동안은 쉰다.
  // 예약이 늘 있어 사실상 10초마다 전체를 다시 불러오던 것을 줄였다(2026-11-04).
  const refreshMs = useMemo(() => {
    if (enriched.some((p) => p.displayStatus === "uploading" || p.displayStatus === "pending")) return 10_000;
    if (enriched.some((p) => p.displayStatus === "scheduled")) return 60_000;
    return null;
  }, [enriched]);
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (refreshTimer.current) clearInterval(refreshTimer.current);
    if (refreshMs == null) return;
    refreshTimer.current = setInterval(() => {
      if (!document.hidden) router.refresh();
    }, refreshMs);
    return () => {
      if (refreshTimer.current) clearInterval(refreshTimer.current);
    };
  }, [refreshMs, router]);

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

    if (sortKey === "published") {
      // 미래 → 현재 → 과거로 이어지는 한 줄 타임라인.
      // 미게시(가장 나중에 게시될 예정이 위) → 게시 완료·취소(최신순).
      list = [...list].sort((a, b) => {
        const group =
          PUBLISH_GROUP_RANK[a.displayStatus] -
          PUBLISH_GROUP_RANK[b.displayStatus];
        if (group !== 0) return group;
        return publishTimeMs(b) - publishTimeMs(a);
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
    doneMessage: string,
    confirmMessage?: string,
  ) {
    if (ids.length === 0) return;
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    startTransition(async () => {
      setActionMessage(null);
      const result = await action({ ids });
      if (result.ok) {
        setActionMessage({
          text: `${doneMessage} · ${result.affected}건`,
          ok: true,
        });
        setSelected(new Set());
        router.refresh();
      } else {
        setActionMessage({ text: result.error, ok: false });
      }
    });
  }

  const selectedItems = filtered.filter((p) => selected.has(p.id));
  const selectedFailedCount = selectedItems.filter(
    (p) => p.displayStatus === "failed",
  ).length;
  const selectedScheduledCount = selectedItems.filter(canCancelPosting).length;

  const allTab = statusFilter.size === ALL_STATUSES.length;
  const activeTab: DisplayStatus | "all" | null = allTab
    ? "all"
    : statusFilter.size === 1
      ? Array.from(statusFilter)[0]
      : null;

  // 가장 먼저 올라갈 예약 — 숫자 카드 아래 "다음 ..."에 쓴다.
  const nextScheduled = useMemo(() => {
    const list = summaryBase
      .filter((p) => p.displayStatus === "scheduled" && p.scheduledFor)
      .map((p) => p.scheduledFor as string)
      .sort();
    return list[0] ?? null;
  }, [summaryBase]);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-[-0.01em]">배포 관리</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            예약 · 올리는 중 · 실패를 한곳에서 보고, 다시 시도하거나 취소해요 · 최근 90일
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => router.refresh()}
            disabled={isPending}
          >
            <RefreshCw className={cn(isPending && "animate-spin")} />
            새로고침
          </Button>
          <Link href="/upload" className={buttonVariants()}>
            <Wand2 />
            콘텐츠 생성
          </Link>
        </div>
      </header>

      {actionMessage && !actionMessage.ok && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-lg bg-risk-soft px-3.5 py-3 text-sm text-ink-2"
        >
          <OctagonAlert className="mt-0.5 size-4 shrink-0 text-risk" />
          <p className="min-w-0 flex-1">{actionMessage.text}</p>
          <button
            type="button"
            onClick={() => setActionMessage(null)}
            aria-label="닫기"
            className="text-muted-foreground hover:text-foreground"
          >
            <XIcon className="size-4" />
          </button>
        </div>
      )}

      {summary.failed > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-risk-soft px-3.5 py-3 text-sm text-ink-2">
          <OctagonAlert className="size-4 shrink-0 text-risk" />
          <p className="min-w-0 flex-1">
            <b className="text-foreground">
              발행 {summary.failed}건이 실패했어요.
            </b>{" "}
            줄을 누르면 원인이 나와요. 계정 연결 문제면 계정 연동에서 다시 연결한 뒤
            재시도하세요.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => jumpToStatus("failed")}
          >
            실패만 보기
          </Button>
        </div>
      )}

      <SummaryCards
        summary={summary}
        activeTab={activeTab}
        nextScheduled={nextScheduled}
        periodLabel={PERIOD_LABEL[period]}
        onJump={jumpToStatus}
      />

      <section className="min-w-0 overflow-hidden rounded-lg border bg-card">
        <StatusTabs
          summary={summary}
          activeTab={activeTab}
          onSelectAll={() => setStatusFilter(new Set(ALL_STATUSES))}
          onSelect={jumpToStatus}
        />

        <FiltersBar
          platformFilter={platformFilter}
          period={period}
          sortKey={sortKey}
          searchInput={searchInput}
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
                "다시 시도했어요",
              )
            }
            onCancel={() =>
              runAction(
                cancelPostingsAction,
                selectedItems.filter(canCancelPosting).map((p) => p.id),
                "발행을 취소했어요",
                "고른 항목의 발행을 취소할까요? 이미 올리는 중인 건은 취소되지 않아요.",
              )
            }
            onDelete={() =>
              runAction(
                deletePostingsAction,
                selectedItems.map((p) => p.id),
                "목록에서 숨겼어요",
                `${selected.size}건을 배포 관리 목록에서 숨길까요? 콘텐츠와 SNS 게시물은 지워지지 않아요.`,
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
            runAction(retryPostingsAction, [id], "다시 시도했어요")
          }
          onCancel={(id) =>
            runAction(
              cancelPostingsAction,
              [id],
              "발행을 취소했어요",
              "이 발행을 취소할까요?",
            )
          }
        />

        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2.5 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {filtered.length}건 · {SORT_LABEL[sortKey]}
          </span>
          <span>목록에서 숨겨도 콘텐츠와 SNS 게시물은 지워지지 않아요</span>
        </div>
      </section>

      {detailItem && (
        <DetailDrawer
          onDeleteContent={runDeleteContent}
          item={detailItem}
          canManage={canManage}
          isPending={isPending}
          onClose={() => setDetailItem(null)}
          onRetry={(id) =>
            runAction(retryPostingsAction, [id], "다시 시도했어요")
          }
          onCancel={(id) =>
            runAction(
              cancelPostingsAction,
              [id],
              "발행을 취소했어요",
              "이 발행을 취소할까요?",
            )
          }
          onHide={(id) =>
            runAction(
              deletePostingsAction,
              [id],
              "목록에서 숨겼어요",
              "이 발행을 배포 관리 목록에서 숨길까요? 콘텐츠와 SNS 게시물은 지워지지 않아요.",
            )
          }
        />
      )}

      {/* 결과 토스트 — 오른쪽 아래, 4초 (DESIGN.md 6장) */}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed right-4 bottom-4 z-[70] flex flex-col gap-2"
      >
        {actionMessage?.ok && (
          <div className="flex max-w-[400px] items-center gap-2.5 rounded-[10px] bg-foreground px-3.5 py-2.5 text-sm text-background shadow-[0_8px_24px_rgb(16_24_40/0.12),0_2px_6px_rgb(16_24_40/0.08)]">
            <CircleCheck className="size-4 shrink-0" />
            {actionMessage.text}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 상태 배지
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_ICON: Record<DisplayStatus, typeof Clock> = {
  scheduled: Clock,
  uploading: Loader2,
  completed: CircleCheck,
  failed: OctagonAlert,
  pending: Hourglass,
  cancelled: Ban,
};

function StatusBadge({ status }: { status: DisplayStatus }) {
  const Icon = STATUS_ICON[status];
  return (
    <Badge variant={STATUS_BADGE_VARIANT[status]}>
      <Icon className={cn(status === "uploading" && "animate-spin")} />
      {STATUS_LABEL[status]}
    </Badge>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary cards
// ─────────────────────────────────────────────────────────────────────────────

function SummaryCards({
  summary,
  activeTab,
  nextScheduled,
  periodLabel,
  onJump,
}: {
  summary: Record<DisplayStatus | "total", number>;
  activeTab: DisplayStatus | "all" | null;
  nextScheduled: string | null;
  periodLabel: string;
  onJump: (s: DisplayStatus) => void;
}) {
  const cards: Array<{ key: DisplayStatus; label: string; foot: React.ReactNode }> = [
    {
      key: "failed",
      label: "실패",
      foot: summary.failed > 0 ? "지금 확인" : "없어요",
    },
    {
      key: "scheduled",
      label: "예약중",
      foot: nextScheduled ? (
        <>
          다음 <RelativeTime iso={nextScheduled} />
        </>
      ) : (
        "예약 없음"
      ),
    },
    { key: "uploading", label: "올리는 중", foot: "10초마다 새로 불러와요" },
    { key: "completed", label: "완료", foot: periodLabel },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      {cards.map((c) => {
        const count = summary[c.key];
        const hot = c.key === "failed" && count > 0;
        const active = activeTab === c.key;
        return (
          <button
            key={c.key}
            type="button"
            onClick={() => onJump(c.key)}
            aria-pressed={active}
            className={cn(
              "min-w-0 rounded-lg border bg-card px-[18px] py-4 text-left transition-colors hover:border-line-strong",
              hot && "border-risk hover:border-risk",
              active && "border-primary ring-1 ring-inset ring-primary hover:border-primary",
            )}
          >
            <p className="text-xs font-medium text-muted-foreground">{c.label}</p>
            <p
              className={cn(
                "mt-1.5 mb-1 text-2xl leading-tight font-bold tracking-[-0.02em] tabular-nums",
                hot && "text-risk",
              )}
            >
              {count}
              <small className="ml-0.5 text-sm font-semibold text-muted-foreground">
                건
              </small>
            </p>
            <p
              className={cn(
                "truncate text-xs",
                hot ? "font-medium text-risk" : "text-muted-foreground",
              )}
            >
              {c.foot}
            </p>
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 상태 탭 — 상태 하나만 보거나 전체
// ─────────────────────────────────────────────────────────────────────────────

const TAB_ORDER: DisplayStatus[] = [
  "failed",
  "scheduled",
  "uploading",
  "pending",
  "completed",
  "cancelled",
];

function StatusTabs({
  summary,
  activeTab,
  onSelectAll,
  onSelect,
}: {
  summary: Record<DisplayStatus | "total", number>;
  activeTab: DisplayStatus | "all" | null;
  onSelectAll: () => void;
  onSelect: (s: DisplayStatus) => void;
}) {
  const tabs: Array<{ key: DisplayStatus | "all"; label: string; count: number }> = [
    { key: "all", label: "전체", count: summary.total },
    ...TAB_ORDER.map((s) => ({ key: s, label: STATUS_LABEL[s], count: summary[s] })),
  ];
  return (
    <div
      role="tablist"
      aria-label="상태"
      className="flex items-end gap-1.5 overflow-x-auto border-b px-4 pt-3"
    >
      {tabs.map((t) => {
        const on = activeTab === t.key;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => (t.key === "all" ? onSelectAll() : onSelect(t.key))}
            className={cn(
              "relative -mb-px inline-flex h-11 shrink-0 items-center gap-2 rounded-t-[10px] border border-b-0 px-4 text-sm font-semibold whitespace-nowrap transition-colors sm:px-5",
              on
                ? "bg-card text-foreground"
                : "bg-surface-2 text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
            <span
              className={cn(
                "rounded-full px-[7px] text-xs leading-5 font-semibold tabular-nums",
                on
                  ? "bg-primary text-primary-foreground"
                  : "bg-surface-2 text-muted-foreground",
              )}
            >
              {t.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Filters bar
// ─────────────────────────────────────────────────────────────────────────────

const PLATFORM_LABEL: Record<Platform, string> = {
  INSTAGRAM: "인스타그램",
  YOUTUBE: "유튜브",
  TIKTOK: "틱톡",
  THREADS: "스레드",
};

const PERIOD_SHORT: Record<PeriodPreset, string> = {
  today: "오늘",
  "7d": "7일",
  "30d": "30일",
  all: "전체",
};

function FiltersBar({
  platformFilter,
  period,
  sortKey,
  searchInput,
  onTogglePlatform,
  onChangePeriod,
  onChangeSort,
  onChangeSearch,
}: {
  platformFilter: Set<Platform>;
  period: PeriodPreset;
  sortKey: SortKey;
  searchInput: string;
  onTogglePlatform: (p: Platform) => void;
  onChangePeriod: (p: PeriodPreset) => void;
  onChangeSort: (k: SortKey) => void;
  onChangeSearch: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
      <div
        role="group"
        aria-label="플랫폼"
        className="inline-flex items-center gap-0.5 rounded-md border bg-card p-[2px]"
      >
        {ALL_PLATFORMS.map((p) => {
          const on = platformFilter.has(p);
          return (
            <button
              key={p}
              type="button"
              onClick={() => onTogglePlatform(p)}
              aria-pressed={on}
              aria-label={PLATFORM_LABEL[p]}
              title={PLATFORM_LABEL[p]}
              className={cn(
                "rounded-[6px] p-[5px] leading-none transition-opacity hover:opacity-100",
                on ? "bg-surface-2 opacity-100" : "opacity-35",
              )}
            >
              <PlatformIcon platform={p} size={20} />
            </button>
          );
        })}
      </div>
      <Segmented<PeriodPreset>
        ariaLabel="기간"
        value={period}
        onChange={onChangePeriod}
        options={(Object.keys(PERIOD_SHORT) as PeriodPreset[]).map((p) => ({
          value: p,
          label: PERIOD_SHORT[p],
        }))}
      />
      <label className="relative flex min-w-[200px] flex-1 items-center sm:max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 size-4 text-faint" />
        <span className="sr-only">검색</span>
        <Input
          type="search"
          placeholder="콘텐츠 · 계정 · 캡션 검색"
          value={searchInput}
          onChange={(e) => onChangeSearch(e.target.value)}
          className="pl-8"
        />
      </label>
      <span className="hidden flex-1 sm:block" />
      <select
        aria-label="정렬"
        value={sortKey}
        onChange={(e) => onChangeSort(e.target.value as SortKey)}
        className="h-9 rounded-md border border-input bg-card px-2.5 text-base sm:text-sm"
      >
        {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
          <option key={k} value={k}>
            {SORT_LABEL[k]}
          </option>
        ))}
      </select>
    </div>
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
    <div className="flex flex-wrap items-center gap-2 border-b bg-brand-soft px-4 py-2 text-sm">
      <b className="mr-2 text-primary tabular-nums">{selectedCount}건 선택</b>
      <Button
        variant="outline"
        size="sm"
        onClick={onRetry}
        disabled={failedCount === 0 || isPending}
        title={failedCount === 0 ? "고른 것 중 실패한 건이 없어요" : undefined}
      >
        <RefreshCw /> 재시도 {failedCount}
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={onCancel}
        disabled={scheduledCount === 0 || isPending}
        title={scheduledCount === 0 ? "고른 것 중 취소할 수 있는 건이 없어요" : undefined}
      >
        <X /> 발행 취소 {scheduledCount}
      </Button>
      <Button variant="ghost" size="sm" onClick={onDelete} disabled={isPending}>
        <EyeOff /> 목록에서 숨기기
      </Button>
      <span className="flex-1" />
      <Button variant="ghost" size="sm" onClick={onClear}>
        선택 해제
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Table
// ─────────────────────────────────────────────────────────────────────────────

interface TableItem extends PostingItem {
  displayStatus: DisplayStatus;
}

const TH = "h-11 px-3.5 text-left text-xs font-semibold whitespace-nowrap text-ink-2";

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
}) {
  if (items.length === 0) {
    return (
      <div className="px-4 py-16 text-center text-sm text-muted-foreground">
        조건에 맞는 발행이 없어요.
        <br />
        탭 · 플랫폼 · 기간을 바꾸거나 새 콘텐츠를 만들어 보세요.
      </div>
    );
  }

  const allSelected = items.every((i) => selected.has(i.id));
  const someSelected = !allSelected && items.some((i) => selected.has(i.id));

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[880px] border-collapse text-sm">
        <thead className="bg-surface-2">
          <tr>
            {canManage && (
              <th className="h-11 w-12 pr-0 pl-3.5">
                <input
                  type="checkbox"
                  aria-label="보이는 줄 모두 선택"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={(e) => onToggleAll(e.target.checked)}
                  className="size-4 accent-primary"
                />
              </th>
            )}
            <th className={TH}>콘텐츠</th>
            <th className={TH}>계정</th>
            <th className={TH}>상태</th>
            <th className={TH}>예약</th>
            <th className={TH}>올라감</th>
            <th className={cn(TH, "text-right")}>
              <span className="sr-only">할 일</span>
            </th>
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
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function mediaSummary(item: { mediaType: "IMAGE" | "VIDEO"; mediaCount: number }) {
  return item.mediaType === "VIDEO" ? "영상" : `사진 ${item.mediaCount}장`;
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
}: {
  item: TableItem;
  selected: boolean;
  canManage: boolean;
  isPending: boolean;
  onToggle: (id: string, checked: boolean) => void;
  onSelectDetail: (item: PostingItem) => void;
  onRetry: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  const isFailed = item.displayStatus === "failed";
  const canCancel = canCancelPosting(item);
  const label = displayLabel(item);

  // 줄마다 할 일 버튼은 하나만: 실패 → 재시도, 예약 · 대기 → 취소, 올라감 → 게시 글.
  let action: React.ReactNode = <span className="text-faint">—</span>;
  if (canManage && isFailed) {
    action = (
      <Button
        variant="outline"
        size="sm"
        onClick={() => onRetry(item.id)}
        disabled={isPending}
      >
        <RefreshCw /> 재시도
      </Button>
    );
  } else if (canManage && canCancel) {
    action = (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onCancel(item.id)}
        disabled={isPending}
      >
        취소
      </Button>
    );
  } else if (item.platformPostUrl) {
    action = (
      <a
        href={item.platformPostUrl}
        target="_blank"
        rel="noreferrer"
        className={buttonVariants({ variant: "ghost", size: "sm" })}
      >
        <ExternalLink /> 게시 글
      </a>
    );
  }

  return (
    <tr
      className={cn(
        "border-t transition-colors hover:bg-surface-2",
        isFailed && "bg-risk-soft hover:bg-risk-soft",
        selected && "bg-brand-soft hover:bg-brand-soft",
      )}
    >
      {canManage && (
        <td className="h-[52px] w-12 pr-0 pl-3.5">
          <input
            type="checkbox"
            aria-label={`${label} 선택`}
            checked={selected}
            onChange={(e) => onToggle(item.id, e.target.checked)}
            className="size-4 accent-primary"
          />
        </td>
      )}
      <td className="px-3.5 py-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="size-9 shrink-0 overflow-hidden rounded-md border bg-surface-2">
            {item.thumbnailUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={item.thumbnailUrl}
                alt=""
                className="size-full object-cover"
              />
            ) : null}
          </div>
          <div className="flex min-w-0 flex-col leading-snug">
            <button
              type="button"
              onClick={() => onSelectDetail(item)}
              className="max-w-[260px] truncate text-left font-medium hover:text-primary hover:underline hover:underline-offset-[3px]"
            >
              {label}
            </button>
            <span className="max-w-[260px] truncate text-xs text-muted-foreground">
              {item.internalTitle
                ? `${mediaSummary(item)} · ${captionPreview(item.captions)}`
                : mediaSummary(item)}
            </span>
          </div>
        </div>
      </td>
      <td className="px-3.5 py-2">
        <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
          <PlatformIcon platform={item.account.platform} size={20} />
          <span className="max-w-[160px] truncate">
            {item.account.displayName ?? "(이름 없음)"}
          </span>
          {item.account.disconnected && (
            <Badge variant="secondary">연결 해제됨</Badge>
          )}
        </div>
      </td>
      <td className="px-3.5 py-2">
        <div className="flex flex-col items-start gap-0.5">
          <StatusBadge status={item.displayStatus} />
          {isFailed && item.lastError && (
            <span
              className="line-clamp-1 max-w-[220px] text-xs font-medium text-risk"
              title={item.lastError}
            >
              {item.lastError}
            </span>
          )}
        </div>
      </td>
      <td className="px-3.5 py-2 whitespace-nowrap tabular-nums">
        {item.scheduledFor ? (
          <RelativeTime iso={item.scheduledFor} />
        ) : (
          // 즉시 발행은 요청(등록) 시각이 곧 게시하려던 시각 — 취소·실패 건도 언제
          // 올리려던 건지 알 수 있게 함께 보여준다.
          <>
            <span className="text-muted-foreground">바로</span>
            <span className="block text-xs text-muted-foreground">
              <RelativeTime iso={item.createdAt} />
            </span>
          </>
        )}
      </td>
      <td className="px-3.5 py-2 whitespace-nowrap tabular-nums">
        {item.completedAt ? (
          <RelativeTime iso={item.completedAt} />
        ) : (
          <span className="text-faint">—</span>
        )}
      </td>
      <td className="px-3.5 py-2 text-right whitespace-nowrap">{action}</td>
    </tr>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Detail drawer — 오른쪽 서랍 (DESIGN.md 1장: 상세는 오른쪽 서랍)
// ─────────────────────────────────────────────────────────────────────────────

function DetailDrawer({
  item,
  canManage,
  isPending,
  onClose,
  onRetry,
  onCancel,
  onHide,
  onDeleteContent,
}: {
  item: PostingItem;
  canManage: boolean;
  isPending: boolean;
  onClose: () => void;
  onRetry: (id: string) => void;
  onCancel: (id: string) => void;
  onHide: (id: string) => void;
  onDeleteContent: (contentId: string, label: string) => void;
}) {
  const displayStatus = getDisplayStatus(item.status, item.scheduledFor);
  const canCancel = canCancelPosting({ status: item.status, displayStatus });

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
          }
        | undefined
      >
    | null;

  const info: Array<{ label: string; value: React.ReactNode }> = [
    {
      label: "계정",
      value: `${PLATFORM_LABEL[item.account.platform]} · ${item.account.displayName ?? "(이름 없음)"}${item.account.disconnected ? " (연결 해제됨)" : ""}`,
    },
    {
      label: "예약",
      value: item.scheduledFor ? <RelativeTime iso={item.scheduledFor} /> : "바로 올리기",
    },
    {
      label: "올라감",
      value: item.completedAt ? <RelativeTime iso={item.completedAt} /> : "—",
    },
    { label: "시도", value: `${item.attempts}회` },
    { label: "만든 시각", value: <RelativeTime iso={item.createdAt} /> },
  ];

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/40"
        onClick={onClose}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="발행 자세히"
        className="fixed inset-y-0 right-0 z-50 flex w-[440px] max-w-full flex-col border-l bg-card shadow-[0_8px_24px_rgb(16_24_40/0.12),0_2px_6px_rgb(16_24_40/0.08)]"
      >
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3.5">
          <h2 className="min-w-0 truncate text-base font-semibold">
            {item.internalTitle?.trim() || "발행 자세히"}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="닫기"
            autoFocus
          >
            <XIcon />
          </Button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="flex min-w-0 items-center gap-1.5">
              <PlatformIcon platform={item.account.platform} size={20} />
              <span className="truncate">
                {item.account.displayName ?? "(이름 없음)"}
              </span>
            </span>
            <StatusBadge status={displayStatus} />
            {item.account.disconnected && (
              <Badge variant="secondary">연결 해제됨</Badge>
            )}
          </div>

          {item.lastError && (
            <div className="space-y-2 rounded-lg bg-risk-soft px-3.5 py-3 text-sm text-ink-2">
              <p className="flex items-center gap-2 font-semibold text-foreground">
                <OctagonAlert className="size-4 shrink-0 text-risk" />
                마지막 오류
              </p>
              <pre className="font-sans text-xs break-all whitespace-pre-wrap text-risk">
                {item.lastError}
              </pre>
              <p className="text-xs">
                계정 연결 문제면{" "}
                <Link href="/accounts" className="font-medium text-primary underline-offset-2 hover:underline">
                  계정 연동
                </Link>
                에서 다시 연결한 뒤 재시도하세요.
              </p>
            </div>
          )}

          <div className="grid grid-cols-[72px_minmax(0,1fr)] items-start gap-3">
            <div className="h-24 w-[72px] overflow-hidden rounded-md border bg-surface-2">
              {item.thumbnailUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={item.thumbnailUrl}
                  alt=""
                  className="size-full object-cover"
                />
              )}
            </div>
            <div className="min-w-0 text-sm">
              <b>{mediaSummary(item)}</b>
              <p className="mt-1 line-clamp-4 text-xs whitespace-pre-wrap text-ink-2">
                {captionPreview(item.captions, 200)}
              </p>
            </div>
          </div>

          <section>
            <h3 className="mb-2 text-xs font-semibold text-muted-foreground">
              발행 정보
            </h3>
            <dl className="grid grid-cols-[96px_minmax(0,1fr)] overflow-hidden rounded-lg border text-sm">
              {info.map((r, i) => (
                <div key={r.label} className="contents">
                  <dt
                    className={cn(
                      "bg-surface-2 px-3 py-2.5 text-muted-foreground",
                      i < info.length - 1 && "border-b",
                    )}
                  >
                    {r.label}
                  </dt>
                  <dd
                    className={cn(
                      "min-w-0 px-3 py-2.5 tabular-nums",
                      i < info.length - 1 && "border-b",
                    )}
                  >
                    {r.value}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          {captions && (
            <section className="space-y-2">
              <h3 className="text-xs font-semibold text-muted-foreground">캡션</h3>
              {captions.youtube && (
                <CaptionBlock
                  title="유튜브"
                  primary={captions.youtube.title ?? ""}
                  body={captions.youtube.description ?? ""}
                  tags={captions.youtube.hashtags ?? []}
                />
              )}
              {captions.instagram && (
                <CaptionBlock
                  title="인스타그램"
                  primary=""
                  body={captions.instagram.caption ?? ""}
                  tags={captions.instagram.hashtags ?? []}
                />
              )}
              {captions.tiktok && (
                <CaptionBlock
                  title="틱톡"
                  primary=""
                  body={captions.tiktok.caption ?? ""}
                  tags={captions.tiktok.hashtags ?? []}
                />
              )}
            </section>
          )}

          {canManage && (
            <section>
              <h3 className="mb-2 text-xs font-semibold text-muted-foreground">
                그 밖의 작업
              </h3>
              {/* 콘텐츠 완전 삭제 — 이 콘텐츠의 모든 발행에 영향을 주므로
                  발행 단위 작업(재시도/취소)과 떨어뜨려 설명과 함께 둔다. */}
              {item.contentErased && (
                <p className="mb-2 rounded-md bg-surface-2 px-3 py-2 text-xs text-muted-foreground">
                  파일과 캡션을 지운 콘텐츠예요. 발행 기록만 남아 있어요.
                </p>
              )}
              <div className="divide-y rounded-lg border text-sm">
                <div className="flex items-center justify-between gap-3 px-3.5 py-3">
                  <span className="min-w-0">
                    목록에서 숨기기
                    <span className="block text-xs text-muted-foreground">
                      배포 관리에서만 안 보여요. 게시물과 이력은 그대로예요.
                    </span>
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      onHide(item.id);
                      onClose();
                    }}
                    disabled={isPending}
                  >
                    <EyeOff /> 숨기기
                  </Button>
                </div>
                {!item.contentErased && (
                <div className="flex items-center justify-between gap-3 px-3.5 py-3">
                  <span className="min-w-0">
                    콘텐츠 삭제
                    <span className="block text-xs text-muted-foreground">
                      파일과 캡션이 지워지고 되돌릴 수 없어요. 이미 올라간 건은 발행 기록이 남아요.
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      onDeleteContent(
                        item.contentId,
                        item.internalTitle?.trim() || "이 콘텐츠",
                      )
                    }
                    disabled={isPending}
                    className="text-risk hover:bg-risk-soft hover:text-risk"
                  >
                    <Trash2 /> 삭제
                  </Button>
                </div>
                )}
              </div>
            </section>
          )}
        </div>

        {(item.platformPostUrl ||
          (canManage && (displayStatus === "failed" || canCancel))) && (
          <div className="flex justify-end gap-2 border-t px-4 py-3">
            {item.platformPostUrl && (
              <a
                href={item.platformPostUrl}
                target="_blank"
                rel="noreferrer"
                className={buttonVariants({
                  variant: displayStatus === "failed" ? "outline" : "default",
                })}
              >
                <ExternalLink /> 게시 글 열기
              </a>
            )}
            {canManage && canCancel && (
              <Button
                variant="outline"
                onClick={() => {
                  onCancel(item.id);
                  onClose();
                }}
                disabled={isPending}
              >
                <X /> 발행 취소
              </Button>
            )}
            {canManage && displayStatus === "failed" && (
              <Button
                onClick={() => {
                  onRetry(item.id);
                  onClose();
                }}
                disabled={isPending}
              >
                <RefreshCw /> 재시도
              </Button>
            )}
          </div>
        )}
      </aside>
    </>
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
    <div className="rounded-lg border bg-surface-2 px-3.5 py-3 text-xs">
      <p className="mb-1 font-semibold text-muted-foreground">{title}</p>
      {primary && <p className="mb-1 text-sm font-semibold">{primary}</p>}
      <p className="whitespace-pre-wrap text-ink-2">{body}</p>
      {tags.length > 0 && (
        <p className="mt-2 text-primary">{tags.join(" ")}</p>
      )}
    </div>
  );
}
