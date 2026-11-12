"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { ArrowDown, ArrowUp, CheckCircle2, ExternalLink, RotateCcw, Save, Trash2, Upload } from "lucide-react";
import { DetailedError, Upload as TusUpload } from "tus-js-client";
import { addClipAction, finishUploadAction, moveClipAction, remakeShotlistAction, removeClipAction, saveBriefAction, type ShootResult } from "@/app/(dashboard)/shoot/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { EDIT_RESTART_REASON, type EditRestart } from "@/lib/shoot/edit-sig";
import { REQUEST_STATUS } from "@/lib/shoot/request-data";
import { createClient } from "@/lib/supabase/client";
import { HookFields } from "@/components/shoot/hook-fields";

// 촬영 요청 하나(상세 화면) — 하고 싶은 말, 추천 대본(참고), 촬영본 올리기(개수 · 순서 자유), 다 올렸어요.
// 컷 리스트대로 못 찍어도 편집할 수 있게 촬영본을 컷과 떼어 냈다(2026-11-10). 편집 에이전트는
// 하고 싶은 말 → 추천 대본 → 상품 정보 차례로 따르고, 촬영본 순서를 기본 흐름으로 본다.
// 업로드는 Supabase Storage의 tus(이어 올리기) 엔드포인트로 — 휴대폰에서 끊겨도 같은 파일을 다시 고르면 이어서 올라간다.
// tus가 실패하면 실제 오류(응답 코드 · 서버 메시지)를 화면에 남기고 한 번에 올리기로 다시 올린다(2026-11-11).

export interface ShootRequestCardData {
  id: string;
  status: string;
  account: string;
  ideaTitle: string | null;
  product: { name: string; url: string; image: string | null } | null;
  // 이 상품으로 하고 싶은 말(human_brief)
  brief: string | null;
  // 추천 대본을 쓴 뒤에 하고 싶은 말이 바뀌었는지
  briefChanged: boolean;
  // 편집 계획이 있는 완성본을 되돌려 다시 올리는 중이면 — 지난 편집에 쓴 하고 싶은 말(예전 완성본은 null)과,
  // 지금 편집을 시작하면 처음부터 새로 편집하게 되는 이유(지난 계획을 그대로 쓰면 null). 그런 완성본이 없으면 null
  lastEdit: { brief: string | null; restart: EditRestart | null } | null;
  // 촬영 가이드를 다시 쓰는 중인지
  remaking: boolean;
  hook: { spoken: string; onScreen: string; score: number | null } | null;
  // 사람이 넣은 첫 화면 후킹 · 표지 글자 — 비면 편집 에이전트가 만든다
  planId: string;
  humanHook: string;
  humanThumbnail: string;
  thumbnailIdea: string | null;
  caption: string;
  // 저장한 후킹 문구를 썼는지 · 못 썼으면 왜 (계정 컨셉, 0039)
  fixedHook: boolean;
  fixedNotes: string[];
  // 추천 대본 — 참고용
  cuts: { no: number; seconds: number; shot: string; how: string; onScreen: string; voice: string; narration: string }[];
  // 올린 촬영본, 편집 순서대로
  clips: { path: string; name: string; size: number }[];
  issues: string[];
  error: string | null;
}

// media 버킷이 받는 영상 형식(0005)
const VIDEO_TYPES: Record<string, string> = { "video/mp4": "mp4", "video/quicktime": "mov" };
// Supabase tus는 조각 크기가 정확히 6MB여야 한다
const CHUNK = 6 * 1024 * 1024;
// media 버킷 한도(0014) — 올리기 전에 알려 준다
const MAX_CLIP_BYTES = 1024 * 1024 * 1024;
// actions.ts MAX_CLIPS와 같게
const MAX_CLIPS = 20;

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)}MB`;
}

/** 올리기 오류에서 응답 코드와 서버 메시지를 꺼낸다 — 화면에 그대로 보여 원인을 바로 알 수 있게 */
function describeUploadError(err: unknown): string {
  if (err instanceof DetailedError) {
    const res = err.originalResponse;
    if (res) {
      const body = (res.getBody() ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      return `응답 ${res.getStatus()}${body ? ` · ${body}` : ""}`;
    }
    const cause = err.causingError?.message;
    return `서버 응답 없음(연결이 끊기거나 막힘)${cause ? ` · ${cause.slice(0, 160)}` : ""}`;
  }
  return err instanceof Error ? err.message.slice(0, 200) : String(err);
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
  const s = REQUEST_STATUS[request.status] ?? { label: request.status, variant: "outline" as const };
  const open = request.status === "OPEN";
  const totalSeconds = request.cuts.reduce((sum, c) => sum + c.seconds, 0);

  return (
    <article className="space-y-3 rounded-lg border bg-card p-4">
      <header className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">@{request.account}</span>
        <Badge variant={s.variant}>{s.label}</Badge>
        {(request.status === "EDITED" || request.status === "FAILED") && (
          <Link href="/shoot/review" className="text-xs font-medium underline">
            완성본 받기로 →
          </Link>
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
      {open ? <BriefField planId={request.planId} brief={request.brief ?? ""} lastEditBrief={request.lastEdit?.brief ?? null} /> : request.brief && <p className="text-xs">하고 싶은 말: {request.brief}</p>}
      {open && <GuideRemake request={request} />}
      {request.hook && (
        <p className="rounded-md bg-muted/40 px-3 py-2 text-sm">
          첫 장면: <b>{request.hook.spoken}</b>
          {request.hook.onScreen && request.hook.onScreen !== request.hook.spoken && <span className="ml-1 rounded bg-card px-1 text-xs">{request.hook.onScreen}</span>}
          {request.fixedHook && <span className="ml-1 text-xs text-muted-foreground">저장한 후킹 문구</span>}
        </p>
      )}
      {open && <HookFields planId={request.planId} hook={request.humanHook} thumbnail={request.humanThumbnail} aiHook={request.hook?.onScreen ?? null} aiThumbnail={request.thumbnailIdea} />}
      {request.fixedNotes.length > 0 && open && (
        <ul className="space-y-0.5 rounded-md border border-warn/40 px-3 py-2 text-xs text-warn">
          {request.fixedNotes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
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

      {request.cuts.length > 0 && (
        <details className="rounded-md border px-3 py-2">
          <summary className="cursor-pointer text-sm font-semibold">
            추천 대본 <span className="text-xs font-normal text-muted-foreground">· 장면 {request.cuts.length}개 · 약 {Math.round(totalSeconds)}초 · 참고용</span>
          </summary>
          <p className="mt-1 text-xs text-muted-foreground">이대로 찍지 않아도 돼요. 찍은 장면에 맞는 말만 AI가 골라 써요.</p>
          <ol className="mt-2 space-y-2">
            {request.cuts.map((c) => (
              <li key={c.no} className="space-y-0.5">
                <p className="text-sm">
                  <b>{c.no}.</b> {c.shot} <span className="text-xs text-muted-foreground">· {c.seconds}초</span>
                </p>
                {c.how && <p className="text-xs text-muted-foreground">찍는 법: {c.how}</p>}
                {c.onScreen && (
                  <p className="text-xs">
                    화면 문구: <span className="rounded bg-muted px-1">{c.onScreen}</span>
                  </p>
                )}
                {c.voice && <p className="text-xs">말하기: “{c.voice}”</p>}
                {c.narration && <p className="text-xs text-muted-foreground">AI 음성이 읽어요: “{c.narration}”</p>}
              </li>
            ))}
          </ol>
        </details>
      )}

      <ClipList requestId={request.id} clips={request.clips} open={open} orgId={orgId} userId={userId} />

      {request.caption && (
        <details className="rounded-md border px-3 py-2 text-xs">
          <summary className="cursor-pointer font-semibold">AI가 쓴 캡션</summary>
          <p className="mt-2 whitespace-pre-wrap">{request.caption}</p>
        </details>
      )}

      {request.error && (
        <details className="rounded-md border border-risk/30 bg-risk-soft px-3 py-2 text-xs text-risk">
          <summary className="cursor-pointer font-semibold">자동 편집이 실패했어요. 완성본 받기에서 다시 편집하거나 촬영본을 다시 올릴 수 있어요.</summary>
          <p className="mt-1 break-all">{request.error}</p>
        </details>
      )}
      {open && (
        <div className="flex flex-col items-start gap-1">
          {/* 완성본을 되돌려 다시 올리는 중 — 편집 서버는 촬영본 · 하고 싶은 말이 지난 편집과 같을 때만 지난 계획을 다시 쓴다 */}
          {request.lastEdit?.restart && request.clips.length > 0 && (
            <p className="mb-1 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-xs font-medium text-warn">
              {EDIT_RESTART_REASON[request.lastEdit.restart]} 편집을 시작하면 지난 편집을 이어 쓰지 않고 처음부터 새로 편집해요. 완성본 고치기로 고친 내용도 남지 않아요.
            </p>
          )}
          <Button disabled={isPending || !request.clips.length} onClick={() => run(() => finishUploadAction({ requestId: request.id }), "다 올렸어요. 자동 편집을 시작해요.")}>
            <CheckCircle2 className="size-4" /> 다 올렸어요 · 편집 시작
          </Button>
          {!request.clips.length && <p className="text-xs text-muted-foreground">촬영본을 하나 이상 올리면 눌러져요.</p>}
        </div>
      )}
      {error && <p className="text-xs text-risk">{error}</p>}
    </article>
  );
}

/**
 * 하고 싶은 말을 고쳐도 추천 대본은 자동으로 바뀌지 않는다(편집에는 바뀐 말이 반영된다).
 * 추천 대본까지 바꾸고 싶으면 "촬영 가이드 다시 만들기" — 촬영본을 올리기 전에만 된다.
 */
function GuideRemake({ request }: { request: ShootRequestCardData }) {
  const { isPending, error, run } = useRun();
  const [ask, setAsk] = useState(false);
  if (request.remaking) {
    return <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">촬영 가이드를 다시 쓰는 중이에요. 보통 몇 분 안에 끝나고 화면이 저절로 새로 고쳐져요.</p>;
  }
  const canRemake = request.clips.length === 0;
  return (
    <div className="space-y-1.5">
      {request.briefChanged && (
        <p className="rounded-md border border-warn/40 px-3 py-2 text-xs text-warn">
          하고 싶은 말이 추천 대본을 쓴 뒤에 바뀌었어요. 다음 편집에 반영돼요. 추천 대본은 그대로예요.
        </p>
      )}
      {canRemake ? (
        <Button size="sm" variant="outline" disabled={isPending} onClick={() => setAsk(true)}>
          <RotateCcw className="size-4" /> 촬영 가이드 다시 만들기
        </Button>
      ) : (
        request.briefChanged && <p className="text-xs text-muted-foreground">촬영본을 올린 뒤라 촬영 가이드는 다시 만들 수 없어요.</p>
      )}
      {error && <p className="text-xs text-risk">{error}</p>}
      <ConfirmDialog
        open={ask}
        title="촬영 가이드를 다시 만들까요?"
        confirmLabel="다시 만들기"
        pending={isPending}
        onClose={() => setAsk(false)}
        onConfirm={() => {
          setAsk(false);
          run(() => remakeShotlistAction({ requestId: request.id }), "촬영 가이드를 다시 쓰기 시작했어요.");
        }}
      >
        <p>지금 하고 싶은 말로 추천 대본 · 캡션을 새로 써요. 직접 적은 첫 장면 · 표지 문구는 그대로 둬요.</p>
      </ConfirmDialog>
    </div>
  );
}

/**
 * 이 상품으로 하고 싶은 말 — 기획 고를 때 넣은 것을 촬영 중에 고친다.
 * lastEditBrief = 지난 편집에 쓴 말(편집 계획이 있는 완성본을 되돌려 다시 올리는 중일 때만). 이 말과 달라지면
 * 편집 서버가 지난 계획을 쓰지 않으므로, 저장하기 전에 미리 알린다.
 */
function BriefField({ planId, brief, lastEditBrief }: { planId: string; brief: string; lastEditBrief: string | null }) {
  const { isPending, error, run } = useRun();
  const [text, setText] = useState(brief);
  const changed = text.trim() !== brief.trim();
  const differsFromLastEdit = lastEditBrief !== null && text.trim() !== lastEditBrief;
  return (
    <div className="space-y-1.5 rounded-md border px-3 py-2.5">
      <label className="block space-y-1 text-xs font-semibold">
        하고 싶은 말
        <Textarea
          value={text}
          maxLength={300}
          rows={2}
          placeholder="예: 껍질째 먹는 법을 보여 주고 싶어요. 비우면 추천 대본과 상품 정보로 만들어요."
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <p className="text-xs text-muted-foreground">뜻은 그대로 두고 AI가 영상 길이 · 계정 말투에 맞게 다듬어요. 광고 문구 규칙에 어긋나거나 상품 정보에 없는 효능은 고쳐 쓰고 경고로 알려요.</p>
      {lastEditBrief !== null &&
        (differsFromLastEdit ? (
          <p className="rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-xs font-medium text-warn">
            지난 편집에 쓴 말과 달라요. 이 말로 편집을 시작하면 처음부터 새로 편집하고, 완성본 고치기로 고친 내용도 남지 않아요.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">이미 편집한 완성본이 있어요. 하고 싶은 말을 바꾸면 처음부터 새로 편집하고, 완성본 고치기로 고친 내용도 남지 않아요.</p>
        ))}
      {changed && (
        <Button size="sm" variant="outline" disabled={isPending} onClick={() => run(() => saveBriefAction({ planId, brief: text.trim() }), "저장했어요. 편집할 때 이 말을 먼저 따라요.")}>
          <Save className="size-4" /> 저장
        </Button>
      )}
      {error && <p className="text-xs text-risk">{error}</p>}
    </div>
  );
}

// direct: 한 번에 올리기 — 진행률을 알 수 없어 막대 대신 크기만 보인다
type Progress = { index: number; count: number; name: string; percent: number; sent: number; total: number; direct?: boolean };

/** 올린 촬영본 목록 + 여러 개 올리기. 고른 파일을 하나씩 차례로 올리고, 다 끝나면 화면을 새로 고친다. */
function ClipList({ requestId, clips, open, orgId, userId }: { requestId: string; clips: ShootRequestCardData["clips"]; open: boolean; orgId: string; userId: string }) {
  const router = useRouter();
  const { isPending, error, run } = useRun();
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<TusUpload | null>(null);
  const stopRef = useRef(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);

  // 올리는 중에 화면을 떠나면 업로드가 멈춘다 — 떠나기 전에 묻는다
  const uploading = progress != null;
  useEffect(() => {
    if (!uploading) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploading]);

  /** 파일 하나를 tus로 올리고 저장된 경로를 돌려준다. 멈추면 null. */
  const uploadOne = async (file: File, type: string, onProgress: (sent: number, total: number) => void): Promise<string | null> => {
    const supabase = createClient();
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("로그인이 풀렸어요. 새로고침해 주세요.");

    let objectName = `${orgId}/${userId}/shoot/${requestId}/${crypto.randomUUID()}.${VIDEO_TYPES[type]}`;
    return new Promise((resolve, reject) => {
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
        onProgress,
        onError: (err) => {
          console.error("[shoot] 업로드 오류:", err);
          reject(new Error(describeUploadError(err)));
        },
        onSuccess: () => resolve(objectName),
      });
      uploadRef.current = upload;
      // 같은 파일을 전에 올리다 끊겼으면 그 자리부터 — 이전 업로드의 파일 경로를 그대로 쓴다
      void upload.findPreviousUploads().then((previous) => {
        if (stopRef.current) return resolve(null);
        const prev = previous.find((p) => p.metadata.objectName?.startsWith(`${orgId}/${userId}/shoot/${requestId}/`));
        if (prev) {
          objectName = prev.metadata.objectName;
          upload.options.metadata = { ...upload.options.metadata, objectName };
          upload.resumeFromPreviousUpload(prev);
        }
        upload.start();
      });
    });
  };

  /** 이어 올리기(tus)가 안 될 때 쓰는 한 번에 올리기 — 보관함 업로드와 같은 방식 */
  const uploadDirect = async (file: File, type: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
    const path = `${orgId}/${userId}/shoot/${requestId}/${crypto.randomUUID()}.${VIDEO_TYPES[type]}`;
    const { error } = await createClient().storage.from("media").upload(path, file, { contentType: type, upsert: false, cacheControl: "3600" });
    return error ? { ok: false, error: error.message.slice(0, 200) } : { ok: true, path };
  };

  const startUploads = async (files: File[]) => {
    const errors: string[] = [];
    const room = MAX_CLIPS - clips.length;
    if (files.length > room) errors.push(`촬영본은 ${MAX_CLIPS}개까지예요. 앞의 ${Math.max(room, 0)}개만 올려요.`);
    const queue = files.slice(0, Math.max(room, 0));
    stopRef.current = false;
    let added = 0;
    // 이어 올리기가 한 번 실패하면 이번 묶음은 한 번에 올리기로 — 파일마다 재시도를 기다리지 않게
    let tusError: string | null = null;
    for (let i = 0; i < queue.length && !stopRef.current; i++) {
      const file = queue[i];
      const type = videoType(file);
      if (!type) {
        errors.push(`${file.name}: MP4 · MOV 영상만 올릴 수 있어요.`);
        continue;
      }
      if (file.size > MAX_CLIP_BYTES) {
        errors.push(`${file.name}: 파일이 너무 커요 (${mb(file.size)}). 하나에 1GB까지예요. 휴대폰 카메라 화질을 1080p로 낮춰 다시 찍어 주세요.`);
        continue;
      }
      setProgress({ index: i + 1, count: queue.length, name: file.name, percent: 0, sent: 0, total: file.size });
      try {
        let path: string | null = null;
        if (tusError == null) {
          try {
            path = await uploadOne(file, type, (sent, total) =>
              setProgress({ index: i + 1, count: queue.length, name: file.name, percent: total ? Math.round((sent / total) * 100) : 0, sent, total }),
            );
            if (!path) break;
          } catch (e) {
            tusError = describeUploadError(e);
            errors.push(`참고: 이어 올리기가 안 돼서 한 번에 올리기로 바꿨어요 (${tusError}).`);
          }
        }
        if (!path) {
          if (stopRef.current) break;
          setProgress({ index: i + 1, count: queue.length, name: file.name, percent: 0, sent: 0, total: file.size, direct: true });
          const d = await uploadDirect(file, type);
          if (!d.ok) {
            errors.push(`${file.name}: 올리지 못했어요 (${d.error}).`);
            continue;
          }
          path = d.path;
        }
        const r = await addClipAction({ requestId, path, name: file.name, size: file.size, type });
        if (r.ok) added++;
        else errors.push(`${file.name}: ${r.error}`);
      } catch (e) {
        errors.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    uploadRef.current = null;
    setProgress(null);
    setUploadErrors(errors);
    if (added) {
      toast(`촬영본 ${added}개를 올렸어요.`);
      router.refresh();
    }
  };

  const stop = () => {
    stopRef.current = true;
    void uploadRef.current?.abort();
    uploadRef.current = null;
    setProgress(null);
  };

  return (
    <section className="space-y-2">
      <p className="text-sm font-semibold">
        촬영본 <span className="text-xs font-normal text-muted-foreground">· {clips.length}개 · 위에서부터 이 순서로 이어 붙여요</span>
      </p>
      {clips.length > 0 && (
        <ol className="divide-y rounded-md border">
          {clips.map((c, i) => (
            <li key={c.path} className="flex items-center gap-2 px-2.5 py-1.5">
              <span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{mb(c.size)}</span>
              {open && !uploading && (
                <span className="flex shrink-0 items-center">
                  {/* 휴대폰에서 누르기 쉽게 누르는 영역은 44px */}
                  <Button size="icon-lg" variant="ghost" disabled={isPending || i === 0} onClick={() => run(() => moveClipAction({ requestId, path: c.path, dir: "up" }))} aria-label="위로">
                    <ArrowUp className="size-4" />
                  </Button>
                  <Button size="icon-lg" variant="ghost" disabled={isPending || i === clips.length - 1} onClick={() => run(() => moveClipAction({ requestId, path: c.path, dir: "down" }))} aria-label="아래로">
                    <ArrowDown className="size-4" />
                  </Button>
                  <Button size="icon-lg" variant="ghost" disabled={isPending} onClick={() => run(() => removeClipAction({ requestId, path: c.path }), `${i + 1}번 촬영본을 지웠어요.`)} aria-label="촬영본 지우기">
                    <Trash2 className="size-4" />
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ol>
      )}

      {open && !uploading && (
        <>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept="video/mp4,video/quicktime,.mp4,.mov,.m4v"
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (files.length) void startUploads(files);
            }}
          />
          <Button variant="outline" disabled={isPending || clips.length >= MAX_CLIPS} onClick={() => inputRef.current?.click()}>
            <Upload className="size-4" /> 촬영본 올리기
          </Button>
          <p className="text-xs text-muted-foreground">여러 개를 한 번에 골라도 돼요. 고른 순서대로 뒤에 붙어요.</p>
        </>
      )}
      {progress && (
        <div className="space-y-1 rounded-md border px-2.5 py-2">
          <p className="truncate text-xs">
            {progress.count > 1 && `${progress.index}/${progress.count} · `}
            {progress.name}
          </p>
          <div className="flex items-center gap-2">
            <div className="h-2 flex-1 overflow-hidden rounded bg-muted">
              {progress.direct ? (
                <div className="h-full w-full animate-pulse bg-primary/40" />
              ) : (
                <div className="h-full bg-primary transition-[width]" style={{ width: `${progress.percent}%` }} />
              )}
            </div>
            <span className="text-right text-xs tabular-nums whitespace-nowrap">
              {progress.direct ? `한 번에 올리는 중 · ${mb(progress.total)}` : `${progress.percent}% · ${mb(progress.sent)}/${mb(progress.total)}`}
            </span>
            <Button size="sm" variant="ghost" onClick={stop}>
              멈추기
            </Button>
          </div>
        </div>
      )}
      {uploadErrors.length > 0 && (
        <ul className="space-y-0.5 text-xs text-risk">
          {uploadErrors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {error && <p className="text-xs text-risk">{error}</p>}
    </section>
  );
}
