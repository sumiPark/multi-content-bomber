"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Pencil, Plus, Trash2, XIcon } from "lucide-react";
import {
  addEpisodeAction,
  createSeriesAction,
  deleteSeriesAction,
  notifyEpisodeAction,
  removeLastEpisodeAction,
  renameSeriesAction,
  updateSeriesTemplatesAction,
} from "@/app/(dashboard)/episode-alerts/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RelativeTime } from "@/components/ui/relative-time";
import { DEFAULT_TEMPLATES, renderTemplate } from "@/lib/episode-alerts/templates";
import { StatusPill, type TaskView } from "./alert-history";
import { mediaTypeLabel } from "./labels";
import { MediaPicker } from "./media-picker";
import { hasTemplateErrors, TemplateEditor } from "./template-editor";

export interface EpisodeView {
  id: string;
  episodeNo: number;
  permalink: string | null;
  caption: string | null;
  mediaType: string | null;
  postedAt: string | null;
  fromMcb: boolean;
  alertTaskId: string | null;
}

export interface SeriesView {
  id: string;
  name: string;
  // 이 시리즈의 답글 문구 (저장된 게 없으면 기본 문구).
  templates: string[];
  episodes: EpisodeView[];
}

export function SeriesSection({
  accountId,
  accountName,
  accountActive,
  series,
  tasksById,
  mode,
  canManage,
}: {
  accountId: string;
  accountName: string | null;
  accountActive: boolean;
  series: SeriesView[];
  tasksById: Map<string, TaskView>;
  mode: "APPROVAL" | "AUTO";
  canManage: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [addingTo, setAddingTo] = useState<SeriesView | null>(null);
  const canEdit = canManage && accountActive;

  return (
    <section className="space-y-3" aria-labelledby="series-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="series-title" className="text-lg font-semibold">
            시리즈
          </h2>
          <p className="text-xs text-muted-foreground">
            회차를 순서대로 묶어두면, 다음 화가 올라갈 때 이전 화에 댓글 단 사람들에게 답글을 달아요.
          </p>
        </div>
        {canEdit && series.length > 0 && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus /> 새 시리즈
          </Button>
        )}
      </div>

      {series.length === 0 ? (
        <EmptySeries canEdit={canEdit} onCreate={() => setCreating(true)} />
      ) : (
        <ul className="space-y-3">
          {series.map((s) => (
            <li key={s.id}>
              <SeriesCard
                series={s}
                tasksById={tasksById}
                canEdit={canEdit}
                onAddEpisode={() => setAddingTo(s)}
              />
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
        <AddEpisodeDialog
          accountId={accountId}
          series={addingTo}
          mode={mode}
          onClose={() => setAddingTo(null)}
        />
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
            새 시리즈를 만들고 답글 문구를 정해요. 이미 올린 회차가 있으면 1화부터 순서대로 골라주세요.
          </li>
          <li>
            <span className="mr-1.5 font-semibold text-foreground">2.</span>
            다음 화는 콘텐츠 생성 마지막 단계에서 “다음 화로 올리기”에 이 시리즈를 고르세요.
          </li>
          <li>
            <span className="mr-1.5 font-semibold text-foreground">3.</span>
            다음 화가 올라가면 이전 화에 댓글 단 사람들이 확인 대기에 올라와요. 확인하고 보내면 끝이에요.
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
  tasksById,
  canEdit,
  onAddEpisode,
}: {
  series: SeriesView;
  tasksById: Map<string, TaskView>;
  canEdit: boolean;
  onAddEpisode: () => void;
}) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(series.name);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const lastNo = series.episodes.at(-1)?.episodeNo ?? 0;

  function act(fn: () => Promise<{ ok: true } | { ok: false; error: string }>, after?: () => void) {
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
              <CardDescription>
                {lastNo > 0 ? `${lastNo}화까지 · 다음은 ${lastNo + 1}화` : "아직 회차 없음 · 다음은 1화"}
              </CardDescription>
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
      <CardContent className="space-y-3">
        <SeriesTemplates series={series} nextEpisodeNo={lastNo + 1} canEdit={canEdit} />
        {series.episodes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            이미 올린 1화가 있으면 아래에서 추가하고, 아직이면 업로드할 때 이 시리즈를 고르세요.
          </p>
        ) : (
          <ol className="divide-y rounded-md border">
            {series.episodes.map((e, i) => (
              <EpisodeRow
                key={e.id}
                episode={e}
                task={e.alertTaskId ? (tasksById.get(e.alertTaskId) ?? null) : null}
                hasAlert={e.alertTaskId !== null}
                isFirst={i === 0}
                isLast={i === series.episodes.length - 1}
                canEdit={canEdit}
                busy={isPending}
                onNotify={() => act(() => notifyEpisodeAction({ episodeId: e.id }))}
                onRemove={() => {
                  if (!window.confirm(`${e.episodeNo}화를 시리즈에서 뺄까요? 인스타 게시물은 그대로예요.`)) return;
                  act(() => removeLastEpisodeAction({ episodeId: e.id }));
                }}
              />
            ))}
          </ol>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {canEdit && (
          <Button variant="outline" size="sm" onClick={onAddEpisode} disabled={isPending}>
            <Plus /> {lastNo + 1}화 추가
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

// 시리즈 답글 문구 — 평소엔 첫 문구 미리보기만, "수정"을 누르면 편집기.
function SeriesTemplates({
  series,
  nextEpisodeNo,
  canEdit,
}: {
  series: SeriesView;
  nextEpisodeNo: number;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(series.templates);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (editing) {
    return (
      <div className="space-y-3 rounded-md border p-3">
        <p className="text-sm font-medium">답글 문구</p>
        <TemplateEditor
          idPrefix={`series-${series.id}`}
          value={draft}
          onChange={setDraft}
          disabled={isPending}
          seriesName={series.name}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={isPending}
            onClick={() => {
              setEditing(false);
              setDraft(series.templates);
              setError(null);
            }}
          >
            취소
          </Button>
          <Button
            size="sm"
            disabled={isPending || hasTemplateErrors(draft)}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const result = await updateSeriesTemplatesAction({
                  seriesId: series.id,
                  templates: draft,
                });
                if (!result.ok) {
                  setError(result.error);
                  return;
                }
                setEditing(false);
                router.refresh();
              });
            }}
          >
            {isPending ? "저장 중…" : "문구 저장"}
          </Button>
        </div>
      </div>
    );
  }

  const preview = renderTemplate(series.templates[0] ?? DEFAULT_TEMPLATES[0], {
    username: "minji_daily",
    series: series.name,
    episode: nextEpisodeNo,
  });

  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-1 rounded-md bg-muted/40 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">
          답글 문구 {series.templates.length}개 · 돌려가며 써요
        </p>
        <p className="truncate text-sm">{preview}</p>
      </div>
      {canEdit && (
        <Button
          variant="outline"
          size="xs"
          onClick={() => {
            setDraft(series.templates);
            setEditing(true);
          }}
        >
          <Pencil /> 문구 수정
        </Button>
      )}
    </div>
  );
}

function EpisodeRow({
  episode,
  task,
  hasAlert,
  isFirst,
  isLast,
  canEdit,
  busy,
  onNotify,
  onRemove,
}: {
  episode: EpisodeView;
  task: TaskView | null;
  hasAlert: boolean;
  isFirst: boolean;
  isLast: boolean;
  canEdit: boolean;
  busy: boolean;
  onNotify: () => void;
  onRemove: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
      <span className="w-10 shrink-0 text-sm font-semibold tabular-nums">{episode.episodeNo}화</span>
      <div className="min-w-0 flex-1 basis-40">
        <p className="truncate text-sm">{episode.caption?.trim() || mediaTypeLabel(episode.mediaType)}</p>
        <p className="text-xs text-muted-foreground">
          {episode.postedAt && (
            <>
              <RelativeTime iso={episode.postedAt} format="date" /> ·{" "}
            </>
          )}
          {episode.fromMcb ? "MCB로 업로드" : "인스타에서 불러옴"}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {task ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <StatusPill status={task.status} />
            {task.stats.sent > 0 && <span className="tabular-nums">{task.stats.sent.toLocaleString()}명 보냄</span>}
          </span>
        ) : hasAlert ? (
          <span className="text-xs text-muted-foreground">답글 기록 있음</span>
        ) : (
          !isFirst &&
          canEdit && (
            <Button variant="outline" size="xs" onClick={onNotify} disabled={busy}>
              {episode.episodeNo - 1}화 댓글에 답글 달기
            </Button>
          )
        )}
        {episode.permalink && (
          <a
            href={episode.permalink}
            target="_blank"
            rel="noopener noreferrer"
            title="인스타에서 보기"
            aria-label={`${episode.episodeNo}화 인스타에서 보기`}
            className="grid size-7 place-items-center rounded-md text-muted-foreground transition hover:bg-accent/40 hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
          </a>
        )}
        {isLast && canEdit && (
          <Button
            variant="ghost"
            size="icon-xs"
            title="이 회차 빼기"
            aria-label={`${episode.episodeNo}화 빼기`}
            onClick={onRemove}
            disabled={busy}
          >
            <XIcon />
          </Button>
        )}
      </div>
    </li>
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
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
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">{children}</div>
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
            {isPending
              ? "만드는 중…"
              : picked.length > 0
                ? `만들기 (${picked.length}화까지)`
                : "만들기"}
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
        <p className="text-xs text-muted-foreground">답글 문구의 “시리즈 이름” 자리에 들어가요.</p>
      </div>
      <div className="space-y-1.5">
        <p className="text-sm font-medium">답글 문구</p>
        <p className="text-xs text-muted-foreground">
          다음 화가 올라가면 이전 화에 댓글 단 사람들에게 이 문구로 답글을 달아요. 기본 문구로
          시작해도 되고, 나중에 시리즈 카드에서 바꿀 수 있어요.
        </p>
        <TemplateEditor
          idPrefix="new-series"
          value={templates}
          onChange={setTemplates}
          disabled={isPending}
          seriesName={name}
        />
      </div>
      <div className="space-y-1.5">
        <p className="text-sm font-medium">이미 올린 회차 (선택)</p>
        <p className="text-xs text-muted-foreground">
          1화부터 순서대로 눌러주세요. 누른 순서가 회차 번호가 돼요. 아직 안 올렸으면 건너뛰어도 돼요.
        </p>
        <MediaPicker accountId={accountId} multiple selected={picked} onChange={setPicked} />
      </div>
    </Modal>
  );
}

function AddEpisodeDialog({
  accountId,
  series,
  mode,
  onClose,
}: {
  accountId: string;
  series: SeriesView;
  mode: "APPROVAL" | "AUTO";
  onClose: () => void;
}) {
  const router = useRouter();
  const [picked, setPicked] = useState<string[]>([]);
  const lastNo = series.episodes.at(-1)?.episodeNo ?? 0;
  const nextNo = lastNo + 1;
  const [notify, setNotify] = useState(lastNo > 0);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit() {
    if (picked.length === 0) return;
    setError(null);
    startTransition(async () => {
      const result = await addEpisodeAction({
        seriesId: series.id,
        mediaId: picked[0],
        notify,
      });
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
      description="이번 화로 쓸 인스타 게시물을 골라주세요."
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
      {lastNo > 0 && (
        <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3">
          <input
            type="checkbox"
            checked={notify}
            onChange={(e) => setNotify(e.target.checked)}
            className="mt-0.5 size-4"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium">{lastNo}화에 댓글 단 사람들에게 답글 달기</span>
            <span className="block text-xs text-muted-foreground">
              {mode === "APPROVAL"
                ? "대상 목록이 확인 대기에 올라와요. 확인한 뒤에 보내져요."
                : "바로 보내기 설정이라 대상을 모으는 대로 보내져요."}
            </span>
          </span>
        </label>
      )}
    </Modal>
  );
}
