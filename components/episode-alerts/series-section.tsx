"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import { ChevronDown, ExternalLink, Pencil, Plus, Trash2, XIcon } from "lucide-react";
import {
  addEpisodeAction,
  createSeriesAction,
  deleteSeriesAction,
  includeOlderEpisodesAction,
  removeLastEpisodeAction,
  renameSeriesAction,
  retryAlertTaskAction,
  setEpisodeReplyAction,
  updateSeriesTemplatesAction,
} from "@/app/(dashboard)/episode-alerts/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RelativeTime } from "@/components/ui/relative-time";
import { DEFAULT_TEMPLATES } from "@/lib/episode-alerts/templates";
import { cn } from "@/lib/utils";
import type { TaskView } from "./alert-history";
import { mediaTypeLabel } from "./labels";
import { MediaPicker } from "./media-picker";
import {
  hasTemplateErrors,
  TemplateEditor,
  TemplateList,
  TemplateText,
} from "./template-editor";

export interface EpisodeView {
  id: string;
  episodeNo: number;
  permalink: string | null;
  caption: string | null;
  mediaType: string | null;
  postedAt: string | null;
  fromMcb: boolean;
  // 이 회차 답글 켜짐/꺼짐 (0019, 추가할 땐 꺼짐).
  replyEnabled: boolean;
  // 이 회차가 올라왔을 때 직전 화 댓글에 보낸(보내는) 답글 작업.
  task: TaskView | null;
}

export interface SeriesView {
  id: string;
  name: string;
  // 이 시리즈의 답글 문구 (저장된 게 없으면 기본 문구).
  templates: string[];
  episodes: EpisodeView[];
}

type Result = { ok: true } | { ok: false; error: string };

export function SeriesSection({
  accountId,
  accountName,
  accountActive,
  series,
  canManage,
}: {
  accountId: string;
  accountName: string | null;
  accountActive: boolean;
  series: SeriesView[];
  canManage: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [addingTo, setAddingTo] = useState<SeriesView | null>(null);
  const canEdit = canManage && accountActive;

  return (
    <section className="space-y-4" aria-labelledby="series-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="series-title" className="text-base font-semibold">
          시리즈 <span className="font-normal text-muted-foreground">{series.length}</span>
        </h2>
        {canEdit && series.length > 0 && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus /> 새 시리즈
          </Button>
        )}
      </div>

      {series.length === 0 ? (
        <EmptySeries canEdit={canEdit} onCreate={() => setCreating(true)} />
      ) : (
        <ul className="space-y-5">
          {series.map((s) => (
            <li key={s.id}>
              <SeriesCard series={s} canEdit={canEdit} onAddEpisode={() => setAddingTo(s)} />
            </li>
          ))}
        </ul>
      )}

      {creating && (
        <CreateSeriesDialog
          accountId={accountId}
          accountName={accountName}
          onClose={() => setCreating(false)}
        />
      )}
      {addingTo && (
        <AddEpisodeDialog accountId={accountId} series={addingTo} onClose={() => setAddingTo(null)} />
      )}
    </section>
  );
}

function EmptySeries({ canEdit, onCreate }: { canEdit: boolean; onCreate: () => void }) {
  const steps = [
    "새 시리즈를 만들고, 이미 올린 회차가 있으면 1화부터 순서대로 골라요.",
    "다음 화는 콘텐츠 생성 마지막 단계의 “다음 화로 올리기”로 올리거나, 여기서 직접 추가해요.",
    "회차의 답글을 켜면 이전 화에 댓글 단 사람들에게 답글이 달려요.",
  ];
  return (
    <Card>
      <CardContent className="space-y-4 py-8">
        <div>
          <p className="text-base font-semibold">아직 시리즈가 없어요</p>
          <p className="mt-1 text-sm text-muted-foreground">세 단계면 시작할 수 있어요.</p>
        </div>
        <ol className="space-y-3">
          {steps.map((text, i) => (
            <li key={i} className="flex gap-3 text-sm">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                {i + 1}
              </span>
              <span className="pt-0.5">{text}</span>
            </li>
          ))}
        </ol>
        {canEdit && (
          <Button onClick={onCreate}>
            <Plus /> 새 시리즈 만들기
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function SeriesCard({
  series,
  canEdit,
  onAddEpisode,
}: {
  series: SeriesView;
  canEdit: boolean;
  onAddEpisode: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(series.name);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const lastNo = series.episodes.at(-1)?.episodeNo ?? 0;
  const onCount = series.episodes.filter((e) => e.replyEnabled).length;

  function act(fn: () => Promise<Result>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      after?.();
    });
  }

  return (
    <Card className="gap-0 overflow-hidden py-0">
      {/* 머리 — 시리즈 이름과 한 줄 요약 */}
      <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-4">
        {renaming ? (
          <form
            className="flex min-w-0 flex-1 items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              act(() => renameSeriesAction({ seriesId: series.id, name }), () => setRenaming(false));
            }}
          >
            <Input
              id={`series-name-${series.id}`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              autoFocus
              aria-label="시리즈 이름"
            />
            <Button type="submit" size="sm" disabled={isPending}>
              저장
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setRenaming(false);
                setName(series.name);
              }}
            >
              취소
            </Button>
          </form>
        ) : (
          <div className="min-w-0">
            <h3 className="truncate text-lg font-semibold leading-tight">{series.name}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {lastNo > 0 ? `${lastNo}화까지` : "아직 회차 없음"}
              {onCount > 0 && (
                <span className="text-emerald-700 dark:text-emerald-300"> · 답글 켜진 회차 {onCount}개</span>
              )}
            </p>
          </div>
        )}
        {canEdit && !renaming && (
          <div className="flex shrink-0 items-center gap-0.5">
            <Button variant="ghost" size="icon-sm" title="이름 바꾸기" aria-label="이름 바꾸기" onClick={() => setRenaming(true)}>
              <Pencil />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              title="시리즈 삭제"
              aria-label="시리즈 삭제"
              disabled={isPending}
              onClick={() => {
                if (
                  !window.confirm(
                    `“${series.name}” 시리즈를 삭제할까요? 보내는 중인 답글은 멈추고, 이미 보낸 기록은 남아요.`,
                  )
                )
                  return;
                act(() => deleteSeriesAction({ seriesId: series.id }));
              }}
            >
              <Trash2 />
            </Button>
          </div>
        )}
      </div>

      {/* 회차 목록 */}
      <div className="border-t">
        {series.episodes.length === 0 ? (
          <p className="px-5 py-5 text-sm text-muted-foreground">
            이미 올린 1화가 있으면 추가하고, 아직이면 업로드할 때 이 시리즈를 고르세요.
          </p>
        ) : (
          <ol className="divide-y">
            {series.episodes.map((e, i) => (
              <EpisodeRow
                key={e.id}
                episode={e}
                isFirst={i === 0}
                isLast={i === series.episodes.length - 1}
                latestEpisodeNo={lastNo}
                canEdit={canEdit}
                onRemove={() => {
                  if (!window.confirm(`${e.episodeNo}화를 시리즈에서 뺄까요? 인스타 게시물은 그대로예요.`)) return;
                  act(() => removeLastEpisodeAction({ episodeId: e.id }));
                }}
                busy={isPending}
              />
            ))}
          </ol>
        )}
        {canEdit && (
          <button
            type="button"
            onClick={onAddEpisode}
            disabled={isPending}
            className="flex w-full items-center gap-2 border-t px-5 py-3 text-sm font-medium text-primary transition hover:bg-primary/5 disabled:opacity-50"
          >
            <Plus className="size-4" /> {lastNo + 1}화 추가
          </button>
        )}
        {error && <p className="border-t px-5 py-2 text-sm text-destructive">{error}</p>}
      </div>

      {/* 답글 문구 — 평소엔 접어둔다 */}
      <SeriesTemplates series={series} previewEpisodeNo={Math.max(2, lastNo)} canEdit={canEdit} />
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 회차 한 줄 — 왼쪽은 게시물, 오른쪽은 "N-1화 댓글에 답글" 스위치와 상태 배지.
// 최신화 줄엔 "이전 화 댓글에도 보내기"(0023) — 누르면 스위치 이름이 "1~N-1화 댓글에 답글"로 바뀐다.
// ─────────────────────────────────────────────────────────────────────────────

type Tone = "off" | "active" | "waiting" | "done" | "error";

const TONE_CLASS: Record<Tone, string> = {
  off: "bg-muted text-muted-foreground",
  active: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  waiting: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  done: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  error: "bg-destructive/10 text-destructive",
};

function replyStatus(episode: EpisodeView): { text: string; tone: Tone } {
  const task = episode.task;
  const sent = task?.stats.sent ?? 0;
  const sentOlder = task?.stats.sentOlder ?? 0;
  const sentText =
    `${sent.toLocaleString()}명에게 보냄` +
    (sentOlder > 0 ? ` (이전 화 ${sentOlder.toLocaleString()}명 포함)` : "");
  if (!episode.replyEnabled) {
    if (task?.watchExpired) return { text: `7일 지나 꺼짐 · ${sentText}`, tone: "off" };
    return { text: sent > 0 ? `꺼짐 · ${sentText}` : "꺼짐", tone: "off" };
  }
  if (!task) return { text: "준비 중", tone: "active" };
  const toSend = task.stats.sent + task.stats.pending;
  switch (task.status) {
    case "COLLECTING":
      return { text: "보낼 사람 모으는 중", tone: "active" };
    case "SENDING":
      return task.deferred
        ? { text: `하루 한도 · 내일 이어서 ${sent}/${toSend}`, tone: "waiting" }
        : {
            // 이전 화까지 넓히면 분모가 갑자기 커진다 — 왜 늘었는지 같이 보여준다.
            text: `${task.includeOlder ? "이전 화까지 " : ""}보내는 중 ${sent}/${toSend}`,
            tone: "active",
          };
    case "DONE":
      return task.watching
        ? { text: `${sentText} · 새 댓글 확인 중`, tone: "done" }
        : { text: sentText, tone: "done" };
    case "FAILED":
      return { text: "보내기 실패", tone: "error" };
    default:
      return { text: "꺼짐", tone: "off" };
  }
}

function EpisodeRow({
  episode,
  isFirst,
  isLast,
  latestEpisodeNo,
  canEdit,
  busy,
  onRemove,
}: {
  episode: EpisodeView;
  isFirst: boolean;
  isLast: boolean;
  latestEpisodeNo: number;
  canEdit: boolean;
  busy: boolean;
  onRemove: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const status = replyStatus(episode);
  const task = episode.task;
  const sending = task?.status === "COLLECTING" || task?.status === "SENDING";
  const prevNo = episode.episodeNo - 1;
  const no = episode.episodeNo;
  // 이전 화까지 넓힌 상태는 최신화인 동안만 유효하다(다음 화가 올라오면 직전 화만 남음).
  const olderActive = !!task?.includeOlder && isLast;
  const scopeText = olderActive ? `1~${prevNo}화` : `${prevNo}화`;
  const canIncludeOlder =
    canEdit &&
    isLast &&
    no >= 3 &&
    episode.replyEnabled &&
    !!task &&
    !task.includeOlder &&
    task.status !== "FAILED" &&
    task.status !== "CANCELLED";

  function run(fn: () => Promise<Result>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) setError(result.error);
    });
  }

  function enableMessage(): string {
    const body = `${no}화 답글을 켜면 ${scopeText}에 댓글 단 사람들에게 바로 답글이 달려요. 7일 동안은 새로 단 댓글에도 이어서 달고, 그 뒤엔 자동으로 꺼져요.`;
    if (isLast) return `${body} 켤까요?`;
    // 최신화가 아닌 회차 — 사용자는 "2화 댓글 단 사람에게 보내려면 3화를 켠다"로 생각하기 쉬운데,
    // 그러면 최신화가 따로 있는데도 "3화 올라왔어요"가 나간다.
    return [
      `지금 최신화는 ${latestEpisodeNo}화예요.`,
      `${no}화 답글을 켜면 ${prevNo}화에 댓글 단 사람들에게 “${no}화 올라왔어요”로 나가요.`,
      `최신화 소식을 알리려면 ${latestEpisodeNo}화 답글을 켜고 “이전 화 댓글에도 보내기”를 누르세요.`,
      ``,
      `그래도 ${no}화 답글을 켤까요?`,
    ].join("\n");
  }

  function includeOlder() {
    const olderText = prevNo - 1 > 1 ? `1~${prevNo - 1}화` : "1화";
    const message = [
      `${no}화 소식을 ${olderText}에 댓글 단 사람들에게도 보낼까요?`,
      ``,
      `· 한 사람에게 답글 하나 — 가장 최근 화에 단 댓글에 달아요`,
      `· 이미 ${no}화 답글을 받았거나 ${no}화에 댓글 단 사람은 빼요`,
      `· 다른 화 답글이 이미 달린 댓글에도 ${no}화 답글을 달아요`,
      `· 지금부터 7일 동안 1~${prevNo}화 새 댓글도 확인해요`,
      `· ${no}화 답글을 끄면 같이 멈추고, 다시 켜면 이어서 보내요`,
      `· ${no + 1}화가 올라오면 이전 화 쪽은 멈춰요 (${no}화에만 적용)`,
    ].join("\n");
    if (!window.confirm(message)) return;
    run(() => includeOlderEpisodesAction({ episodeId: episode.id }));
  }

  function toggle() {
    const next = !episode.replyEnabled;
    if (next && !window.confirm(enableMessage())) return;
    if (!next && sending && !window.confirm("남은 답글을 보내지 않을까요? 이미 보낸 답글은 그대로예요.")) {
      return;
    }
    run(() => setEpisodeReplyAction({ episodeId: episode.id, enabled: next }));
  }

  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        {/* 회차 번호 */}
        <div
          className={cn(
            "grid size-11 shrink-0 place-items-center rounded-lg text-sm font-bold tabular-nums",
            episode.replyEnabled ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
          )}
          aria-hidden
        >
          {episode.episodeNo}화
        </div>

        {/* 게시물 */}
        <div className="min-w-0 flex-1 basis-48">
          <p className="truncate text-sm font-medium">
            {episode.caption?.trim() || mediaTypeLabel(episode.mediaType)}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            {episode.postedAt && <RelativeTime iso={episode.postedAt} format="date" />}
            {episode.permalink && (
              <a
                href={episode.permalink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 underline-offset-2 hover:text-foreground hover:underline"
              >
                인스타에서 보기 <ExternalLink className="size-3" />
              </a>
            )}
            {isLast && canEdit && (
              <button
                type="button"
                onClick={onRemove}
                disabled={busy}
                className="underline-offset-2 hover:text-destructive hover:underline disabled:opacity-50"
              >
                시리즈에서 빼기
              </button>
            )}
          </p>
        </div>

        {/* 답글 */}
        <div className="flex w-full shrink-0 flex-col items-start gap-1.5 sm:w-auto sm:items-end">
          {isFirst ? (
            <span className="text-xs text-muted-foreground">첫 회차라 답글을 달 이전 화가 없어요</span>
          ) : (
            <>
              <div className="flex items-center gap-2.5">
                <span id={`reply-label-${episode.id}`} className="text-sm">
                  {scopeText} 댓글에 답글
                </span>
                <ReplySwitch
                  checked={episode.replyEnabled}
                  disabled={!canEdit || isPending}
                  labelledBy={`reply-label-${episode.id}`}
                  onToggle={toggle}
                />
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span
                  className={cn(
                    "rounded-full px-2.5 py-0.5 text-xs font-medium tabular-nums",
                    TONE_CLASS[status.tone],
                  )}
                  title={task?.lastError ?? undefined}
                >
                  {status.text}
                </span>
                {canIncludeOlder && (
                  <Button variant="outline" size="xs" disabled={isPending} onClick={includeOlder}>
                    이전 화 댓글에도 보내기
                  </Button>
                )}
                {task?.status === "FAILED" && episode.replyEnabled && canEdit && (
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={isPending}
                    onClick={() => run(() => retryAlertTaskAction({ taskId: task.id }))}
                  >
                    다시 시도
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      {task?.status === "FAILED" && task.lastError && episode.replyEnabled && (
        <p className="mt-2 text-xs text-destructive sm:pl-[3.75rem]">{task.lastError}</p>
      )}
      {error && <p className="mt-2 text-xs text-destructive sm:pl-[3.75rem]">{error}</p>}
    </li>
  );
}

function ReplySwitch({
  checked,
  disabled,
  labelledBy,
  onToggle,
}: {
  checked: boolean;
  disabled: boolean;
  labelledBy: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-muted-foreground/30",
      )}
    >
      <span
        className={cn(
          "inline-block size-5 rounded-full bg-background shadow transition",
          checked ? "translate-x-[22px]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 시리즈 답글 문구 — 평소엔 접고 첫 문구만 미리보기
// ─────────────────────────────────────────────────────────────────────────────

function SeriesTemplates({
  series,
  previewEpisodeNo,
  canEdit,
}: {
  series: SeriesView;
  previewEpisodeNo: number;
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(series.templates);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await updateSeriesTemplatesAction({ seriesId: series.id, templates: draft });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEditing(false);
    });
  }

  return (
    <div className="border-t bg-muted/20">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-5 py-3 text-left transition hover:bg-muted/40"
      >
        <span className="shrink-0 text-sm font-medium">
          답글 문구 <span className="font-normal text-muted-foreground">{series.templates.length}개</span>
        </span>
        {!open && (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            <TemplateText
              template={series.templates[0] ?? DEFAULT_TEMPLATES[0]}
              seriesName={series.name}
              episodeNo={previewEpisodeNo}
            />
          </span>
        )}
        <ChevronDown
          className={cn("ml-auto size-4 shrink-0 text-muted-foreground transition", open && "rotate-180")}
        />
      </button>

      {open && (
        <div className="space-y-3 px-5 pb-4">
          {editing ? (
            <>
              <p className="text-xs text-muted-foreground">
                칩 버튼으로 댓글 단 사람·시리즈 이름·회차 번호를 넣을 수 있어요.
              </p>
              <TemplateEditor
                idPrefix={`series-${series.id}`}
                value={draft}
                onChange={setDraft}
                disabled={isPending}
                seriesName={series.name}
                episodeNo={previewEpisodeNo}
              />
              {error && <p className="text-sm text-destructive">{error}</p>}
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={isPending}
                  onClick={() => {
                    setEditing(false);
                    setError(null);
                  }}
                >
                  취소
                </Button>
                <Button size="sm" disabled={isPending || hasTemplateErrors(draft)} onClick={save}>
                  {isPending ? "저장 중…" : "저장"}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">아래 문구 중 하나가 번갈아 달려요.</p>
              <TemplateList
                templates={series.templates}
                seriesName={series.name}
                episodeNo={previewEpisodeNo}
              />
              {canEdit && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setDraft(series.templates);
                    setEditing(true);
                  }}
                >
                  <Pencil /> 문구 수정
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 다이얼로그
// ─────────────────────────────────────────────────────────────────────────────

function Modal({
  title,
  description,
  onClose,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2 border-b p-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="닫기">
            <XIcon />
          </Button>
        </div>
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">{children}</div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t p-4">{footer}</div>
      </div>
    </div>
  );
}

function CreateSeriesDialog({
  accountId,
  accountName,
  onClose,
}: {
  accountId: string;
  accountName: string | null;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [templates, setTemplates] = useState<string[]>(DEFAULT_TEMPLATES);
  const [editingTemplates, setEditingTemplates] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await createSeriesAction({ accountId, name, templates, mediaIds: picked });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
    });
  }

  return (
    <Modal
      title="새 시리즈"
      description={accountName ? `@${accountName}` : undefined}
      onClose={onClose}
      footer={
        <>
          {error && <p className="mr-auto text-sm text-destructive">{error}</p>}
          <Button variant="ghost" onClick={onClose} disabled={isPending}>
            취소
          </Button>
          <Button onClick={submit} disabled={isPending || !name.trim() || hasTemplateErrors(templates)}>
            {isPending ? "만드는 중…" : picked.length > 0 ? `만들기 (${picked.length}화까지)` : "만들기"}
          </Button>
        </>
      }
    >
      <div className="space-y-1.5">
        <Label htmlFor="new-series-name">시리즈 이름</Label>
        <Input
          id="new-series-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          placeholder="예) 노을 아래서"
          autoFocus
        />
      </div>

      <div className="space-y-2.5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium">답글 문구</p>
            <p className="text-xs text-muted-foreground">
              {editingTemplates
                ? "칩 버튼으로 댓글 단 사람·시리즈 이름·회차 번호를 넣을 수 있어요."
                : "기본 문구로 시작해요. 나중에 시리즈에서 바꿀 수도 있어요."}
            </p>
          </div>
          {!editingTemplates && (
            <Button variant="ghost" size="xs" onClick={() => setEditingTemplates(true)}>
              <Pencil /> 수정
            </Button>
          )}
        </div>
        {editingTemplates ? (
          <TemplateEditor
            idPrefix="new-series"
            value={templates}
            onChange={setTemplates}
            disabled={isPending}
            seriesName={name}
            episodeNo={2}
          />
        ) : (
          <TemplateList templates={templates} seriesName={name} episodeNo={2} />
        )}
      </div>

      <div className="space-y-1.5">
        <p className="text-sm font-medium">이미 올린 회차 (선택)</p>
        <p className="text-xs text-muted-foreground">
          1화부터 순서대로 눌러주세요. 누른 순서가 회차 번호가 돼요. 답글은 모두 꺼진 상태로 추가돼요.
        </p>
        <MediaPicker accountId={accountId} multiple selected={picked} onChange={setPicked} />
      </div>
    </Modal>
  );
}

function AddEpisodeDialog({
  accountId,
  series,
  onClose,
}: {
  accountId: string;
  series: SeriesView;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const nextNo = (series.episodes.at(-1)?.episodeNo ?? 0) + 1;
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit() {
    if (picked.length === 0) return;
    setError(null);
    startTransition(async () => {
      const result = await addEpisodeAction({ seriesId: series.id, mediaId: picked[0] });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
    });
  }

  return (
    <Modal
      title={`${series.name} ${nextNo}화 추가`}
      description="이번 화로 쓸 인스타 게시물을 골라주세요. 답글은 꺼진 상태로 추가돼요."
      onClose={onClose}
      footer={
        <>
          {error && <p className="mr-auto text-sm text-destructive">{error}</p>}
          <Button variant="ghost" onClick={onClose} disabled={isPending}>
            취소
          </Button>
          <Button onClick={submit} disabled={isPending || picked.length === 0}>
            {isPending ? "추가하는 중…" : `${nextNo}화로 추가`}
          </Button>
        </>
      }
    >
      <MediaPicker
        accountId={accountId}
        multiple={false}
        selected={picked}
        onChange={setPicked}
        lockedLabel={(m) => {
          const used = m.usedIn.find((u) => u.seriesId === series.id);
          return used ? `이미 ${used.episodeNo}화` : null;
        }}
      />
    </Modal>
  );
}
