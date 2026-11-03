"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { CheckCircle2, Circle, ExternalLink, Trash2, Upload } from "lucide-react";
import { Upload as TusUpload } from "tus-js-client";
import {
  addClipAction,
  finishUploadAction,
  removeClipAction,
  toggleCutAction,
  type ShootResult,
} from "@/app/(dashboard)/shoot/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RelativeTime } from "@/components/ui/relative-time";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

// 촬영 요청 하나 — 컷 목록(찍을 것 · 찍는 법 · 화면 문구 · 대사), 컷마다 촬영본 올리기, 다 올렸어요.
// 업로드는 Supabase Storage의 tus(이어 올리기) 엔드포인트로 — 휴대폰에서 끊겨도 같은 파일을 다시 고르면 이어서 올라간다.

export interface ShootRequestCardData {
  id: string;
  status: string;
  account: string;
  slotDate: string;
  slotTime: string;
  dueIso: string | null;
  product: { name: string; url: string; image: string | null } | null;
  brief: string | null;
  hook: { spoken: string; onScreen: string; score: number | null } | null;
  caption: string;
  cuts: { no: number; seconds: number; shot: string; how: string; onScreen: string; voice: string; done: boolean }[];
  clips: { cut: number; name: string; size: number }[];
  issues: string[];
  error: string | null;
}

const STATUS: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  OPEN: { label: "촬영 중", variant: "default" },
  UPLOADED: { label: "다 올림 · 편집 대기", variant: "secondary" },
  EDITING: { label: "자동 편집 중", variant: "secondary" },
  EDITED: { label: "편집 완료", variant: "secondary" },
  FAILED: { label: "편집 실패", variant: "destructive" },
};

// media 버킷이 받는 영상 형식(0005)
const VIDEO_TYPES: Record<string, string> = { "video/mp4": "mp4", "video/quicktime": "mov" };
// Supabase tus는 조각 크기가 정확히 6MB여야 한다
const CHUNK = 6 * 1024 * 1024;

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)}MB`;
}

function videoType(file: File): string | null {
  if (VIDEO_TYPES[file.type]) return file.type;
  // 일부 휴대폰은 type이 비어 온다 — 확장자로
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (ext === "mp4" || ext === "m4v") return "video/mp4";
  if (ext === "mov") return "video/quicktime";
  return null;
}

function useRun() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<ShootResult>) =>
    startTransition(async () => {
      setError(null);
      const r = await fn();
      if (r.ok) router.refresh();
      else setError(r.error);
    });
  return { isPending, error, run };
}

export function ShootRequestCard({ request, orgId, userId }: { request: ShootRequestCardData; orgId: string; userId: string }) {
  const { isPending, error, run } = useRun();
  const s = STATUS[request.status] ?? { label: request.status, variant: "outline" as const };
  const open = request.status === "OPEN";
  const clipOf = new Map(request.clips.map((c) => [c.cut, c]));
  const uploaded = request.cuts.filter((c) => clipOf.has(c.no)).length;
  const totalSeconds = request.cuts.reduce((sum, c) => sum + c.seconds, 0);

  return (
    <article className="space-y-3 rounded-lg border p-4">
      <header className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">@{request.account}</span>
        <span className="text-sm tabular-nums">
          {request.slotDate.slice(5)} {request.slotTime}
        </span>
        <Badge variant={s.variant}>{s.label}</Badge>
        {(request.status === "EDITED" || request.status === "FAILED") && (
          <Link href="/shoot/review" className="text-xs font-medium underline">
            완성본 확인으로 →
          </Link>
        )}
        {open && request.dueIso && (
          <span className="text-xs text-muted-foreground">
            촬영 마감 <RelativeTime iso={request.dueIso} />
          </span>
        )}
      </header>

      {request.product && (
        <div className="flex items-center gap-3">
          {request.product.image ? (
            // 몰 CDN 이미지
            // eslint-disable-next-line @next/next/no-img-element
            <img src={request.product.image} alt="" className="size-12 shrink-0 rounded object-cover" />
          ) : (
            <div className="size-12 shrink-0 rounded bg-muted" />
          )}
          <p className="min-w-0 truncate text-sm font-medium">{request.product.name}</p>
          <a href={request.product.url} target="_blank" rel="noreferrer" className="ml-auto shrink-0 text-muted-foreground hover:text-foreground" aria-label="몰에서 보기">
            <ExternalLink className="size-4" />
          </a>
        </div>
      )}
      {request.brief && <p className="text-xs">메모: {request.brief}</p>}
      {request.hook && (
        <p className="rounded-md bg-muted/40 px-3 py-2 text-sm">
          첫 장면: <b>{request.hook.spoken}</b>
          {request.hook.onScreen && <span className="ml-1 rounded bg-background px-1 text-xs">{request.hook.onScreen}</span>}
        </p>
      )}
      {request.issues.length > 0 && open && (
        <details className="rounded-md border border-amber-400/50 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          <summary className="cursor-pointer font-semibold">찍을 때 고칠 것 {request.issues.length}개 (점검 결과)</summary>
          <ul className="mt-1 space-y-0.5">
            {request.issues.map((i) => (
              <li key={i}>· {i}</li>
            ))}
          </ul>
        </details>
      )}

      <p className="text-xs text-muted-foreground">
        컷 {request.cuts.length}개 · 약 {Math.round(totalSeconds)}초 · 올린 컷 {uploaded}/{request.cuts.length}
      </p>
      <ol className="space-y-2">
        {request.cuts.map((c) => (
          <CutRow key={c.no} requestId={request.id} cut={c} clip={clipOf.get(c.no) ?? null} open={open} orgId={orgId} userId={userId} />
        ))}
      </ol>

      {request.caption && (
        <details className="rounded-md border px-3 py-2 text-xs">
          <summary className="cursor-pointer font-semibold">AI가 쓴 캡션</summary>
          <p className="mt-2 whitespace-pre-wrap">{request.caption}</p>
        </details>
      )}

      {request.error && <p className="text-xs text-destructive">편집 오류: {request.error}</p>}
      {open && (
        <div className="flex flex-col items-start gap-1">
          <Button disabled={isPending || uploaded < request.cuts.length} onClick={() => run(() => finishUploadAction({ requestId: request.id }))}>
            <CheckCircle2 className="size-4" /> 다 올렸어요 · 편집 시작
          </Button>
          {uploaded < request.cuts.length && <p className="text-[11px] text-muted-foreground">컷마다 촬영본을 하나씩 올리면 눌러져요.</p>}
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </article>
  );
}

function CutRow({
  requestId,
  cut,
  clip,
  open,
  orgId,
  userId,
}: {
  requestId: string;
  cut: ShootRequestCardData["cuts"][number];
  clip: { name: string; size: number } | null;
  open: boolean;
  orgId: string;
  userId: string;
}) {
  const { isPending, error, run } = useRun();
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<TusUpload | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const startUpload = async (file: File) => {
    setUploadError(null);
    const type = videoType(file);
    if (!type) {
      setUploadError("MP4 · MOV 영상만 올릴 수 있어요.");
      return;
    }
    const supabase = createClient();
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      setUploadError("로그인이 풀렸어요. 새로고침해 주세요.");
      return;
    }

    let objectName = `${orgId}/${userId}/shoot/${requestId}/${crypto.randomUUID()}.${VIDEO_TYPES[type]}`;
    const upload = new TusUpload(file, {
      endpoint: `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/upload/resumable`,
      retryDelays: [0, 3000, 5000, 10000, 20000, 30000],
      headers: { authorization: `Bearer ${token}`, apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, "x-upsert": "false" },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      chunkSize: CHUNK,
      metadata: { bucketName: "media", objectName, contentType: type, cacheControl: "3600" },
      onProgress: (sent, total) => setProgress(total ? Math.round((sent / total) * 100) : 0),
      onError: (err) => {
        setProgress(null);
        setUploadError(`올리다 멈췄어요. 같은 파일을 다시 고르면 이어서 올라가요. (${err.message.slice(0, 120)})`);
      },
      onSuccess: () => {
        setProgress(null);
        uploadRef.current = null;
        run(() => addClipAction({ requestId, cut: cut.no, path: objectName, name: file.name, size: file.size, type }));
      },
    });
    uploadRef.current = upload;
    // 같은 파일을 전에 올리다 끊겼으면 그 자리부터 — 이전 업로드의 파일 경로를 그대로 쓴다
    const previous = await upload.findPreviousUploads();
    const prev = previous.find((p) => p.metadata.objectName?.startsWith(`${orgId}/${userId}/shoot/${requestId}/`));
    if (prev) {
      objectName = prev.metadata.objectName;
      upload.options.metadata = { ...upload.options.metadata, objectName };
      upload.resumeFromPreviousUpload(prev);
    }
    setProgress(0);
    upload.start();
  };

  const uploading = progress != null;

  return (
    <li className={cn("rounded-md border p-2.5", clip && "border-emerald-500/40 bg-emerald-500/5")}>
      <div className="flex items-start gap-2">
        <button
          type="button"
          disabled={!open || isPending}
          onClick={() => run(() => toggleCutAction({ requestId, no: cut.no, done: !cut.done }))}
          className="mt-0.5 shrink-0 text-muted-foreground disabled:opacity-50"
          aria-label={cut.done ? "찍음 표시 풀기" : "찍음으로 표시"}
        >
          {cut.done || clip ? <CheckCircle2 className="size-5 text-emerald-600" /> : <Circle className="size-5" />}
        </button>
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-sm">
            <b>{cut.no}.</b> {cut.shot} <span className="text-xs text-muted-foreground">· {cut.seconds}초</span>
          </p>
          <p className="text-xs text-muted-foreground">찍는 법: {cut.how}</p>
          {cut.onScreen && <p className="text-xs">화면 문구: <span className="rounded bg-muted px-1">{cut.onScreen}</span></p>}
          {cut.voice && <p className="text-xs">말하기: “{cut.voice}”</p>}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 pl-7">
        {clip && !uploading && (
          <span className="min-w-0 truncate text-xs text-emerald-700 dark:text-emerald-400">
            올림 · {clip.name} ({mb(clip.size)})
          </span>
        )}
        {open && !uploading && (
          <>
            <input
              ref={inputRef}
              type="file"
              accept="video/mp4,video/quicktime,.mp4,.mov,.m4v"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void startUpload(f);
              }}
            />
            <Button size="sm" variant={clip ? "ghost" : "outline"} disabled={isPending} onClick={() => inputRef.current?.click()}>
              <Upload className="size-4" /> {clip ? "다시 올리기" : "촬영본 올리기"}
            </Button>
            {clip && (
              <Button size="sm" variant="ghost" disabled={isPending} onClick={() => run(() => removeClipAction({ requestId, cut: cut.no }))} aria-label="올린 촬영본 지우기">
                <Trash2 className="size-4" />
              </Button>
            )}
          </>
        )}
        {uploading && (
          <div className="flex w-full items-center gap-2">
            <div className="h-2 flex-1 overflow-hidden rounded bg-muted">
              <div className="h-full bg-primary transition-[width]" style={{ width: `${progress}%` }} />
            </div>
            <span className="w-10 text-right text-xs tabular-nums">{progress}%</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void uploadRef.current?.abort();
                setProgress(null);
              }}
            >
              멈추기
            </Button>
          </div>
        )}
      </div>
      {(uploadError || error) && <p className="mt-1 pl-7 text-xs text-destructive">{uploadError ?? error}</p>}
    </li>
  );
}
