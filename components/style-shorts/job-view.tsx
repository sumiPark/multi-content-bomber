"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { AlertCircle, AlertTriangle, Download, FileArchive, Loader2, MessageSquarePlus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { deleteJobAction, remakeJobAction, retryVersionAction, type StyleResult } from "@/app/(dashboard)/style-shorts/actions";
import { formatTime, NoteEditor, type NoteView } from "@/components/style-shorts/note-editor";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { RelativeTime } from "@/components/ui/relative-time";
import { toast } from "@/components/ui/toast";
import { VERSION_STATUS, VOICE_MODE_LABEL } from "@/lib/style-shorts/jobs";

// 만든 쇼츠 화면 — 입력 요약, 완성본 버전(최신이 위), 주석 수정 · 다시 만들기 · 지우기.

export interface VersionView {
  id: string;
  version: number;
  status: string;
  requestLabel: string | null;
  videoUrl: string | null;
  coverUrl: string | null;
  downloadUrl: string | null;
  // 편집용 파일 묶음(zip). 이 기능 전에 만든 버전은 null
  partsUrl: string | null;
  seconds: number | null;
  warnings: string[];
  music: { title: string; creator: string; license: string; url: string } | null;
  sfxCount: number;
  error: string | null;
  finishedAt: string | null;
  // 아직 보내지 않은 주석(편집 화면에서 이어 단다)
  draftNotes: NoteView[];
  // 이 버전을 만든 주석(수정 버전만)
  sentNotes: Omit<NoteView, "id">[];
}

export interface JobSummary {
  id: string;
  title: string;
  folderId: string | null;
  folderName: string;
  voiceMode: "AI" | "LIVE";
  script: string | null;
  concept: string | null;
  clips: string[];
  clipsDeleted: boolean;
  keepDays: number;
  createdAt: string;
}

function VersionCard({
  v,
  latest,
  onRetry,
  pending,
  canRevise,
  editing,
  onEdit,
  onCloseEdit,
}: {
  v: VersionView;
  latest: boolean;
  onRetry: () => void;
  pending: boolean;
  canRevise: boolean;
  editing: boolean;
  onEdit: () => void;
  onCloseEdit: () => void;
}) {
  const s = VERSION_STATUS[v.status] ?? { label: v.status, variant: "secondary" as const };
  const working = v.status === "PENDING" || v.status === "EDITING";
  if (editing && v.videoUrl) {
    return (
      <Card>
        <CardContent className="space-y-4 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold tabular-nums">v{v.version}</span>
            <Badge variant="default">수정하는 중</Badge>
          </div>
          <NoteEditor versionId={v.id} version={v.version} videoUrl={v.videoUrl} coverUrl={v.coverUrl} initialNotes={v.draftNotes} onClose={onCloseEdit} />
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="space-y-4 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-base font-semibold tabular-nums">v{v.version}</span>
          <Badge variant={s.variant}>
            {working && <Loader2 className="animate-spin" aria-hidden />}
            {s.label}
          </Badge>
          {v.requestLabel && <Badge variant="outline">{v.requestLabel}</Badge>}
          {v.seconds != null && <span className="text-xs text-muted-foreground tabular-nums">{v.seconds}초</span>}
          {v.finishedAt && (
            <span className="text-xs text-muted-foreground">
              <RelativeTime iso={v.finishedAt} />
            </span>
          )}
        </div>

        {working && <p className="text-sm text-muted-foreground">편집하고 있어요. 보통 5~15분 걸려요. 이 화면은 자동으로 새로 고쳐져요.</p>}

        {v.status === "FAILED" && (
          <div className="flex items-start gap-2 rounded-md bg-risk-soft p-3 text-sm text-risk">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div className="space-y-2">
              <p>{v.error ?? "편집하지 못했어요."}</p>
              <Button size="sm" variant="outline" disabled={pending} onClick={onRetry}>
                <RotateCcw className="size-4" aria-hidden />
                다시 편집
              </Button>
            </div>
          </div>
        )}

        {v.videoUrl && (
          <div className="flex flex-col gap-4 sm:flex-row">
            <video
              src={v.videoUrl}
              poster={v.coverUrl ?? undefined}
              controls
              playsInline
              preload={latest ? "metadata" : "none"}
              className="aspect-[9/16] max-h-[70vh] w-full max-w-[360px] shrink-0 rounded-lg bg-black"
            />
            <div className="min-w-0 flex-1 space-y-3">
              <div className="flex flex-wrap gap-2">
                {v.downloadUrl && (
                  <a href={v.downloadUrl} className={buttonVariants({ variant: latest ? "default" : "outline" })}>
                    <Download className="size-4" aria-hidden />
                    완성본 받기
                  </a>
                )}
                {v.partsUrl && (
                  <a href={v.partsUrl} className={buttonVariants({ variant: "outline" })}>
                    <FileArchive className="size-4" aria-hidden />
                    편집용 파일 받기
                  </a>
                )}
                {v.status === "DONE" && (
                  <Button variant="outline" disabled={!canRevise || pending} onClick={onEdit}>
                    <MessageSquarePlus className="size-4" aria-hidden />
                    수정하기{v.draftNotes.length > 0 && ` (주석 ${v.draftNotes.length}개)`}
                  </Button>
                )}
              </div>
              {v.sentNotes.length > 0 && (
                <details className="rounded-md border p-3">
                  <summary className="cursor-pointer text-sm font-semibold">반영한 주석 {v.sentNotes.length}개</summary>
                  <ul className="mt-2 space-y-1.5">
                    {v.sentNotes.map((n) => (
                      <li key={n.no} className="flex items-start gap-2 text-sm text-ink-2">
                        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground tabular-nums">{n.no}</span>
                        <span className="min-w-0">
                          <span className="text-xs text-muted-foreground tabular-nums">{n.at == null ? "영상 전체" : formatTime(n.at)}</span> {n.body}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {v.music && (
                <p className="text-xs text-muted-foreground">
                  음악: {v.music.url ? (
                    <a href={v.music.url} target="_blank" rel="noreferrer" className="underline">
                      {v.music.title}
                    </a>
                  ) : (
                    v.music.title
                  )}
                  {v.music.creator && ` · ${v.music.creator}`}
                  {v.music.license && ` · ${v.music.license}`} · 효과음 {v.sfxCount}종
                </p>
              )}
              {v.warnings.length > 0 && (
                <div className="space-y-1 rounded-md border border-warn/40 bg-warn-soft p-3">
                  <p className="flex items-center gap-1.5 text-sm font-semibold text-warn">
                    <AlertTriangle className="size-4" aria-hidden />
                    확인할 것 {v.warnings.length}개
                  </p>
                  <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">
                    {v.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function JobView({ job, versions, busy }: { job: JobSummary; versions: VersionView[]; busy: boolean }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState<"remake" | "delete" | null>(null);
  // 주석을 다는 중인 버전(한 번에 하나)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = (fn: () => Promise<StyleResult>, done: string, after?: () => void) =>
    start(async () => {
      const res = await fn();
      setConfirm(null);
      if (!res.ok) return toast(res.error, "risk");
      toast(res.warning ?? done, res.warning ? "risk" : "ok");
      if (after) after();
      else router.refresh();
    });

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="text-xl font-bold tracking-[-0.01em]">{job.title}</h1>
          <p className="text-sm text-muted-foreground">
            {job.folderId ? (
              <Link href={`/style-shorts/folders/${job.folderId}`} className="underline">
                {job.folderName}
              </Link>
            ) : (
              job.folderName
            )}{" "}
            스타일 · {VOICE_MODE_LABEL[job.voiceMode]} · 촬영본 {job.clips.length}개 · <RelativeTime iso={job.createdAt} />
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={busy || pending || job.clipsDeleted} onClick={() => setConfirm("remake")}>
            <RefreshCw className="size-4" aria-hidden />
            다시 만들기
          </Button>
          <Button variant="destructive" size="sm" disabled={busy || pending} onClick={() => setConfirm("delete")}>
            <Trash2 className="size-4" aria-hidden />
            지우기
          </Button>
        </div>
      </header>

      {job.clipsDeleted && (
        <div className="rounded-md bg-brand-soft p-3 text-sm text-ink-2">촬영본은 보관 기간({job.keepDays}일)이 지나 지웠어요. 완성본은 그대로 받을 수 있지만 다시 만들기 · 수정은 할 수 없어요.</div>
      )}

      {(job.script || job.concept) && (
        <details className="rounded-lg border bg-card p-4">
          <summary className="cursor-pointer text-sm font-semibold">넣은 대본 · 컨셉</summary>
          <div className="mt-3 space-y-3 text-sm text-ink-2">
            {job.script && (
              <div>
                <p className="text-xs font-semibold text-muted-foreground">대본</p>
                <p className="whitespace-pre-line">{job.script}</p>
              </div>
            )}
            {job.concept && (
              <div>
                <p className="text-xs font-semibold text-muted-foreground">컨셉</p>
                <p className="whitespace-pre-line">{job.concept}</p>
              </div>
            )}
          </div>
        </details>
      )}

      <div className="space-y-4">
        {versions.map((v, i) => (
          <VersionCard
            key={v.id}
            v={v}
            latest={i === 0}
            pending={pending}
            onRetry={() => run(() => retryVersionAction({ id: v.id }), "다시 편집해요")}
            canRevise={!busy && !job.clipsDeleted && (editingId === null || editingId === v.id)}
            editing={editingId === v.id}
            onEdit={() => setEditingId(v.id)}
            onCloseEdit={() => {
              setEditingId(null);
              // 저장한 주석 수를 버튼에 맞춘다
              router.refresh();
            }}
          />
        ))}
      </div>

      <ConfirmDialog
        open={confirm === "remake"}
        title="처음부터 다시 만들까요?"
        confirmLabel="다시 만들기"
        pending={pending}
        onConfirm={() => run(() => remakeJobAction({ id: job.id }), "다시 만들기를 시작했어요")}
        onClose={() => setConfirm(null)}
      >
        같은 촬영본 · 스타일 카드 · 대본으로 새로 편집해 v{(versions[0]?.version ?? 0) + 1}로 만들어요. 지금 완성본은 그대로 남아요.
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === "delete"}
        title="이 쇼츠를 지울까요?"
        confirmLabel="지우기"
        danger
        pending={pending}
        onConfirm={() => run(() => deleteJobAction({ id: job.id }), "지웠어요", () => router.push("/style-shorts"))}
        onClose={() => setConfirm(null)}
      >
        촬영본과 모든 버전의 완성본이 지워져요. 되돌릴 수 없어요.
      </ConfirmDialog>
    </div>
  );
}
