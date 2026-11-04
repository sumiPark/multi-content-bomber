"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
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
import { toast } from "@/components/ui/toast";
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
  // 서버에서 계산 — 렌더 중 시계를 읽지 않으려고
  pastSlot: boolean;
  pastDue: boolean;
}

const STATUS: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive" | "ok" }> = {
  OPEN: { label: "촬영 중", variant: "default" },
  UPLOADED: { label: "다 올림 · 편집 대기", variant: "secondary" },
  EDITING: { label: "자동 편집 중", variant: "secondary" },
  EDITED: { label: "편집 완료", variant: "ok" },
  FAILED: { label: "편집 실패", variant: "destructive" },
};

// media 버킷이 받는 영상 형식(0005)
const VIDEO_TYPES: Record<string, string> = { "video/mp4": "mp4", "video/quicktime": "mov" };
// Supabase tus는 조각 크기가 정확히 6MB여야 한다
const CHUNK = 6 * 1024 * 1024;
// media 버킷 한도(0014) — 올리기 전에 알려 준다
const MAX_CLIP_BYTES = 1024 * 1024 * 1024;

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
  const run = (fn: () => Promise<ShootResult>, done?: string) =>
    startTransition(async () => {
      setError(null);
      const r = await fn();
      if (r.ok) {
        if (done) toast(done);
        router.refresh();
      } else setError(r.error);
    });
  return { isPending, error, run };
}

export function ShootRequestCard({ request, orgId, userId }: { request: ShootRequestCardData; orgId: string; userId: string }) {
  const { isPending, error, run } = useRun();
  const s = STATUS[request.status] ?? { label: request.status, variant: "outline" as const };
  // 올릴 시각이 지난 칸은 더 찍어도 예약되지 않는다 — 다음 정리 때 건너뜀이 된다
  const open = request.status === "OPEN" && !request.pastSlot;
  const clipOf = new Map(request.clips.map((c) => [c.cut, c]));
  const uploaded = request.cuts.filter((c) => clipOf.has(c.no)).length;
  const totalSeconds = request.cuts.reduce((sum, c) => sum + c.seconds, 0);

  return (
    <article className="space-y-3 rounded-lg border bg-card p-4">
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
        {request.status === "OPEN" && request.pastSlot && <Badge variant="destructive">올릴 시각 지남</Badge>}
        {open && request.dueIso && (
          <span className={cn("text-xs", request.pastDue ? "font-semibold text-warn" : "text-muted-foreground")}>
            {request.pastDue ? "촬영 마감 지남" : "촬영 마감"} <RelativeTime iso={request.dueIso} />
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
          {request.hook.onScreen && <span className="ml-1 rounded bg-card px-1 text-xs">{request.hook.onScreen}</span>}
        </p>
      )}
      {request.issues.length > 0 && open && (
        <details className="rounded-md border border-warn/40 px-3 py-2 text-xs text-warn">
          <summary className="cursor-pointer font-semibold">찍을 때 참고할 것 {request.issues.length}개</summary>
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

      {request.error && (
        <details className="rounded-md border border-risk/30 bg-risk-soft px-3 py-2 text-xs text-risk">
          <summary className="cursor-pointer font-semibold">자동 편집이 실패했어요. 완성본 확인에서 다시 편집하거나 촬영본을 다시 올릴 수 있어요.</summary>
          <p className="mt-1 break-all">{request.error}</p>
        </details>
      )}
      {open && (
        <div className="flex flex-col items-start gap-1">
          <Button disabled={isPending || uploaded < request.cuts.length} onClick={() => run(() => finishUploadAction({ requestId: request.id }), "다 올렸어요. 자동 편집을 시작해요.")}>
            <CheckCircle2 className="size-4" /> 다 올렸어요 · 편집 시작
          </Button>
          {uploaded < request.cuts.length && <p className="text-xs text-muted-foreground">컷마다 촬영본을 하나씩 올리면 눌러져요.</p>}
        </div>
      )}
      {error && <p className="text-xs text-risk">{error}</p>}
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
  const [progress, setProgress] = useState<{ percent: number; sent: number; total: number } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // 올리는 중에 화면을 떠나면 업로드가 멈춘다 — 떠나기 전에 묻는다
  const isUploading = progress != null;
  useEffect(() => {
    if (!isUploading) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [isUploading]);

  const startUpload = async (file: File) => {
    setUploadError(null);
    const type = videoType(file);
    if (!type) {
      setUploadError("MP4 · MOV 영상만 올릴 수 있어요.");
      return;
    }
    if (file.size > MAX_CLIP_BYTES) {
      setUploadError(`파일이 너무 커요 (${mb(file.size)}). 컷 하나에 1GB까지 올릴 수 있어요. 휴대폰 카메라 화질을 1080p로 낮춰 다시 찍어 주세요.`);
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
      // 큰 파일은 오래 걸려 로그인 토큰이 도중에 만료될 수 있다 — 요청마다 새 토큰으로
      onBeforeRequest: async (req) => {
        const { data: fresh } = await supabase.auth.getSession();
        if (fresh.session?.access_token) req.setHeader("authorization", `Bearer ${fresh.session.access_token}`);
      },
      metadata: { bucketName: "media", objectName, contentType: type, cacheControl: "3600" },
      onProgress: (sent, total) => setProgress({ percent: total ? Math.round((sent / total) * 100) : 0, sent, total }),
      onError: (err) => {
        console.error("[shoot] 업로드 오류:", err);
        setProgress(null);
        setUploadError("올리다 멈췄어요. 같은 파일을 다시 고르면 이어서 올라가요.");
      },
      onSuccess: () => {
        setProgress(null);
        uploadRef.current = null;
        run(() => addClipAction({ requestId, cut: cut.no, path: objectName, name: file.name, size: file.size, type }), `${cut.no}번 컷을 올렸어요.`);
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
    setProgress({ percent: 0, sent: 0, total: file.size });
    upload.start();
  };

  const uploading = isUploading;

  return (
    <li className={cn("rounded-md border p-2.5", clip && "border-ok/40 bg-ok-soft")}>
      <div className="flex items-start">
        {/* 휴대폰에서 누르기 쉽게 누르는 영역은 44px */}
        <button
          type="button"
          disabled={!open || isPending}
          onClick={() => run(() => toggleCutAction({ requestId, no: cut.no, done: !cut.done }))}
          className="-mt-2 -ml-2 grid size-11 shrink-0 place-items-center text-muted-foreground disabled:opacity-50"
          aria-label={cut.done ? "찍음 표시 풀기" : "찍음으로 표시"}
        >
          {cut.done || clip ? <CheckCircle2 className="size-5 text-ok" /> : <Circle className="size-5" />}
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

      <div className="mt-2 flex flex-wrap items-center gap-2 pl-9">
        {clip && !uploading && (
          <span className="min-w-0 truncate text-xs text-ok">
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
              <Button size="sm" variant="ghost" disabled={isPending} onClick={() => run(() => removeClipAction({ requestId, cut: cut.no }), `${cut.no}번 컷 촬영본을 지웠어요.`)} aria-label="올린 촬영본 지우기">
                <Trash2 className="size-4" />
              </Button>
            )}
          </>
        )}
        {uploading && (
          <div className="flex w-full items-center gap-2">
            <div className="h-2 flex-1 overflow-hidden rounded bg-muted">
              <div className="h-full bg-primary transition-[width]" style={{ width: `${progress.percent}%` }} />
            </div>
            <span className="text-right text-xs tabular-nums whitespace-nowrap">
              {progress.percent}% · {mb(progress.sent)}/{mb(progress.total)}
            </span>
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
      {(uploadError || error) && <p className="mt-1 pl-9 text-xs text-risk">{uploadError ?? error}</p>}
    </li>
  );
}
