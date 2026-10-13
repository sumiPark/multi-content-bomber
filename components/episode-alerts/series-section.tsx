"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Pencil, Plus, Trash2, XIcon } from "lucide-react";
import {
  addEpisodeAction,
  createSeriesAction,
  deleteSeriesAction,
  removeLastEpisodeAction,
  renameSeriesAction,
  retryAlertTaskAction,
  setEpisodeReplyAction,
  updateSeriesTemplatesAction,
} from "@/app/(dashboard)/episode-alerts/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RelativeTime } from "@/components/ui/relative-time";
import { DEFAULT_TEMPLATES } from "@/lib/episode-alerts/templates";
import { cn } from "@/lib/utils";
import type { TaskView } from "./alert-history";
import { mediaTypeLabel } from "./labels";
import { MediaPicker } from "./media-picker";
import { hasTemplateErrors, TemplateEditor, TemplateList } from "./template-editor";

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
    <section className="space-y-3" aria-labelledby="series-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="series-title" className="text-lg font-semibold">
          시리즈
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
        <ul className="space-y-4">
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
  return (
    <Card>
      <CardContent className="space-y-4 py-6">
        <p className="font-medium">아직 시리즈가 없어요</p>
        <ol className="space-y-2 text-sm text-muted-foreground">
          <li>
            <span className="mr-1.5 font-semibold text-foreground">1.</span>
            새 시리즈를 만들고, 이미 올린 회차가 있으면 1화부터 순서대로 골라요.
          </li>
          <li>
            <span className="mr-1.5 font-semibold text-foreground">2.</span>
            다음 화는 콘텐츠 생성 마지막 단계의 “다음 화로 올리기”에서 이 시리즈를 고르거나, 여기서
            직접 추가해요.
          </li>
          <li>
            <span className="mr-1.5 font-semibold text-foreground">3.</span>
            회차의 답글을 켜면 이전 화에 댓글 단 사람들에게 바로 답글이 달려요.
          </li>
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
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(series.name);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const lastNo = series.episodes.at(-1)?.episodeNo ?? 0;

  function act(fn: () => Promise<Result>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      after?.();
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
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
              <CardTitle className="truncate">{series.name}</CardTitle>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {lastNo > 0 ? `${lastNo}화까지` : "아직 회차 없음"}
              </p>
            </div>
          )}
          {canEdit && !renaming && (
            <div className="flex shrink-0 items-center gap-1">
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
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          {series.episodes.length === 0 ? (
            <p className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
              이미 올린 1화가 있으면 추가하고, 아직이면 업로드할 때 이 시리즈를 고르세요.
            </p>
          ) : (
            <ol className="divide-y rounded-md border">
              {series.episodes.map((e, i) => (
                <EpisodeRow key={e.id} episode={e} isFirst={i === 0} canEdit={canEdit} />
              ))}
            </ol>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {canEdit && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={onAddEpisode} disabled={isPending}>
                <Plus /> {lastNo + 1}화 추가
              </Button>
              {lastNo > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  disabled={isPending}
                  onClick={() => {
                    const last = series.episodes.at(-1);
                    if (!last) return;
                    if (!window.confirm(`${last.episodeNo}화를 시리즈에서 뺄까요? 인스타 게시물은 그대로예요.`)) return;
                    act(() => removeLastEpisodeAction({ episodeId: last.id }));
                  }}
                >
                  {lastNo}화 빼기
                </Button>
              )}
            </div>
          )}
        </div>

        <SeriesTemplates
          series={series}
          previewEpisodeNo={Math.max(2, lastNo)}
          canEdit={canEdit}
        />
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 회차 한 줄 — 답글 켜기/끄기 스위치와 진행 상황
// ─────────────────────────────────────────────────────────────────────────────

function replyStatus(episode: EpisodeView): { text: string; tone: "muted" | "active" | "done" | "error" } {
  const task = episode.task;
  const sent = task?.stats.sent ?? 0;
  if (!episode.replyEnabled) {
    return { text: sent > 0 ? `꺼짐 · ${sent.toLocaleString()}명 보냄` : "꺼짐", tone: "muted" };
  }
  if (!task) return { text: "준비 중", tone: "active" };
  const toSend = task.stats.sent + task.stats.pending;
  switch (task.status) {
    case "COLLECTING":
      return { text: "대상 모으는 중", tone: "active" };
    case "SENDING":
      return task.deferred
        ? { text: `내일 이어서 · ${sent}/${toSend}`, tone: "active" }
        : { text: `보내는 중 · ${sent}/${toSend}`, tone: "active" };
    case "DONE":
      return { text: `${sent.toLocaleString()}명에게 보냄`, tone: "done" };
    case "FAILED":
      return { text: "실패", tone: "error" };
    default:
      return { text: "꺼짐", tone: "muted" };
  }
}

function EpisodeRow({
  episode,
  isFirst,
  canEdit,
}: {
  episode: EpisodeView;
  isFirst: boolean;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const status = replyStatus(episode);
  const task = episode.task;
  const sending = task?.status === "COLLECTING" || task?.status === "SENDING";

  function run(fn: () => Promise<Result>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function toggle() {
    const next = !episode.replyEnabled;
    if (
      next &&
      !window.confirm(
        `${episode.episodeNo}화 답글을 켜면 ${episode.episodeNo - 1}화에 댓글 단 사람들에게 바로 답글이 달려요. 켤까요?`,
      )
    ) {
      return;
    }
    if (!next && sending && !window.confirm("남은 답글을 보내지 않을까요? 이미 보낸 답글은 그대로예요.")) {
      return;
    }
    run(() => setEpisodeReplyAction({ episodeId: episode.id, enabled: next }));
  }

  return (
    <li className="space-y-1 px-3 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="w-10 shrink-0 text-sm font-semibold tabular-nums">{episode.episodeNo}화</span>
        <div className="min-w-0 flex-1 basis-40">
          <p className="truncate text-sm">{episode.caption?.trim() || mediaTypeLabel(episode.mediaType)}</p>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {episode.postedAt && <RelativeTime iso={episode.postedAt} format="date" />}
            {episode.permalink && (
              <a
                href={episode.permalink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 hover:text-foreground"
              >
                인스타에서 보기 <ExternalLink className="size-3" />
              </a>
            )}
          </p>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2.5">
          {isFirst ? (
            <span className="text-xs text-muted-foreground">첫 회차 · 답글 없음</span>
          ) : (
            <>
              <span
                className={cn(
                  "text-xs tabular-nums",
                  status.tone === "muted" && "text-muted-foreground",
                  status.tone === "active" && "text-blue-700 dark:text-blue-300",
                  status.tone === "done" && "text-emerald-700 dark:text-emerald-300",
                  status.tone === "error" && "text-destructive",
                )}
                title={task?.lastError ?? undefined}
              >
                {status.text}
              </span>
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
              <ReplySwitch
                checked={episode.replyEnabled}
                disabled={!canEdit || isPending}
                label={`${episode.episodeNo}화 답글`}
                onToggle={toggle}
              />
            </>
          )}
        </div>
      </div>
      {task?.status === "FAILED" && task.lastError && episode.replyEnabled && (
        <p className="pl-[3.25rem] text-xs text-destructive">{task.lastError}</p>
      )}
      {error && <p className="pl-[3.25rem] text-xs text-destructive">{error}</p>}
    </li>
  );
}

function ReplySwitch({
  checked,
  disabled,
  label,
  onToggle,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">답글</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={onToggle}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          "disabled:cursor-not-allowed disabled:opacity-50",
          checked ? "bg-primary" : "bg-muted-foreground/30",
        )}
      >
        <span
          className={cn(
            "inline-block size-4 rounded-full bg-background shadow transition",
            checked ? "translate-x-[18px]" : "translate-x-0.5",
          )}
        />
      </button>
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 시리즈 답글 문구
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
  const router = useRouter();
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
      router.refresh();
    });
  }

  return (
    <div className="space-y-2.5 border-t pt-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">답글 문구</p>
          <p className="text-xs text-muted-foreground">
            {editing
              ? "칩 버튼으로 댓글 단 사람·시리즈 이름·회차 번호를 넣을 수 있어요."
              : `${series.templates.length}개를 번갈아 하나씩 달아요.`}
          </p>
        </div>
        {canEdit && !editing && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              setDraft(series.templates);
              setEditing(true);
            }}
          >
            <Pencil /> 수정
          </Button>
        )}
      </div>

      {editing ? (
        <>
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
        <TemplateList templates={series.templates} seriesName={series.name} episodeNo={previewEpisodeNo} />
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
  const router = useRouter();
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
      router.refresh();
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
  const router = useRouter();
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
      router.refresh();
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
