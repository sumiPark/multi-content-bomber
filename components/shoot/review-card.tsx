"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { CheckCircle2, ClipboardCopy, Download, ExternalLink, FolderDown, Link2Off, ListChecks, Pencil, RotateCcw, Save, SkipForward, Upload } from "lucide-react";
import {
  ackWarningsAction,
  confirmRevisionAction,
  getShootFilesAction,
  listRecentReelsAction,
  markPostedAction,
  proposeRevisionAction,
  reEditAction,
  reopenShootAction,
  saveCaptionAction,
  skipShootAction,
  unlinkPostedAction,
  type RecentReel,
  type RevisionProposal,
  type ShootFile,
  type ShootFilesResult,
  type ShootResult,
} from "@/app/(dashboard)/shoot/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { RelativeTime } from "@/components/ui/relative-time";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { EDIT_RESTART_REASON, type EditRestart } from "@/lib/shoot/edit-sig";
import { saveZip } from "@/lib/shoot/zip-download";
import { cn } from "@/lib/utils";

// 완성본 하나 — 미리보기 · 경고 확인 · 받기(완성본 · 다시 편집용 파일) · 캡션 복사 · 올렸어요 + 릴스 연결.
// 받기 · 올렸어요는 조직 누구나, 캡션 고치기 · 완성본 고치기 · 빼기는 관리자 · 매니저.
// 완성본 고치기: 고칠 내용을 말로 적으면 AI가 바뀔 내용(전 → 후)을 먼저 보여 주고, 확인하면 다시 편집한다.

const REQUEST_MAX = 500;

export interface ReviewCardData {
  planId: string;
  requestId: string | null;
  requestStatus: string | null;
  account: string;
  status: string;
  productName: string;
  ideaTitle: string | null;
  videoUrl: string | null;
  posterUrl: string | null;
  // 완성본 파일이 있는지 — 편집이 실패했으면 촬영 원본만 받을 수 있다
  hasFinal: boolean;
  seconds: number | null;
  caption: string;
  // 저장된 편집 계획이 있는지 — 있어야 고칠 내용을 적어 고칠 수 있다(기본 편집으로 만든 완성본 · 실패한 편집은 없다)
  hasPlan: boolean;
  // 편집 계획이 있어도 다시 편집하면 그 계획을 못 쓰고 처음부터 새로 편집하게 되는 이유(계획을 세운 뒤 촬영본 · 하고 싶은 말이 바뀜). 그대로 쓸 수 있으면 null
  planRestart: EditRestart | null;
  // 찍지 못해 뺀 컷 번호
  skippedCuts: number[];
  // 받기 전에 확인할 것(광고 문구 규칙 · 판매 상태) / 사람이 판단할 것(AI 점검)
  blocking: string[];
  warnings: string[];
  acked: boolean;
  error: string | null;
  postedAt: string | null;
  postedPermalink: string | null;
  filesGone: boolean;
  // 곧 지워지면 남은 날
  deleteInDays: number | null;
}

function useRun() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<ShootResult>, done?: string, after?: () => void) =>
    startTransition(async () => {
      setError(null);
      const r = await fn();
      if (r.ok) {
        if (done) toast(done);
        after?.();
        router.refresh();
      } else setError(r.error);
    });
  return { isPending, error, setError, run };
}

function fileSize(bytes: number | null): string {
  if (bytes == null) return "";
  return bytes >= 1024 * 1024 * 1024 ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB` : `${Math.max(1, Math.round(bytes / 1024 / 1024))}MB`;
}

function textHref(content: string): string {
  // 메모장에서 한글이 깨지지 않게 BOM을 붙인다
  return `data:text/plain;charset=utf-8,%EF%BB%BF${encodeURIComponent(content)}`;
}

export function ReviewCard({ card, canManage }: { card: ReviewCardData; canManage: boolean }) {
  const { isPending, error, setError, run } = useRun();
  const [caption, setCaption] = useState(card.caption);
  const [revising, setRevising] = useState(false);
  const [request, setRequest] = useState("");
  const [proposal, setProposal] = useState<Extract<RevisionProposal, { ok: true }> | null>(null);
  const [proposing, startProposing] = useTransition();
  const [ask, setAsk] = useState<"skip" | "reopen" | "unlink" | null>(null);
  const [files, setFiles] = useState<Extract<ShootFilesResult, { ok: true }> | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  const [loading, startLoading] = useTransition();
  const [zipping, setZipping] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [reels, setReels] = useState<RecentReel[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const failed = card.requestStatus === "FAILED";
  const posted = card.status === "PUBLISHED";
  const editing = card.status === "SHOT" && !failed;
  const ready = card.status === "RENDERED" || (card.status === "SHOT" && failed);
  const reviewable = card.status === "RENDERED";
  const needsAck = !posted && card.blocking.length > 0 && !card.acked;
  const canDownload = (ready || posted) && !needsAck && !card.filesGone;
  const captionChanged = caption.trim() !== card.caption.trim();
  // 편집 계획이 있는 완성본만 고칠 내용을 적어 고친다. 없으면(기본 편집 · 실패) 같은 촬영본으로 다시 편집만 할 수 있다
  const canRevise = reviewable && card.hasPlan && !!card.requestId;
  const canReEdit = (failed || (reviewable && !card.hasPlan)) && !!card.requestId;
  // 페이지를 오래 열어 두면 미리보기 링크가 만료된다 — 한 번만 새 링크를 받아 온다
  const router = useRouter();
  const refreshedOnce = useRef(false);

  const loadFiles = (then: (f: Extract<ShootFilesResult, { ok: true }>) => void) =>
    startLoading(async () => {
      setError(null);
      const r = await getShootFilesAction({ planId: card.planId });
      if (!r.ok) return setError(r.error);
      setFiles(r);
      then(r);
    });

  const downloadFinal = () =>
    loadFiles((f) => {
      if (f.final) window.location.href = f.final.downloadUrl;
      else setError("완성본이 없어요. 다시 편집용 파일을 받아 주세요.");
    });

  const downloadZip = async (f: Extract<ShootFilesResult, { ok: true }>) => {
    setError(null);
    const list: { name: string; url?: string; content?: string }[] = [
      ...(f.final ? [{ name: f.final.name, url: f.final.rawUrl }] : []),
      ...(f.thumbnail ? [{ name: f.thumbnail.name, url: f.thumbnail.rawUrl }] : []),
      ...f.clips.map((c) => ({ name: c.name, url: c.rawUrl })),
      ...f.texts.map((t) => ({ name: t.name, content: t.content })),
    ];
    setZipping("준비 중");
    try {
      const saved = await saveZip(f.zipName, list, (name) => setZipping(name));
      if (saved) toast("ZIP을 저장했어요.");
    } catch (e) {
      setError(`ZIP을 만들지 못했어요. 파일을 하나씩 받아 주세요. (${e instanceof Error ? e.message : "알 수 없는 오류"})`);
    } finally {
      setZipping(null);
    }
  };

  const copyCaption = async () => {
    try {
      await navigator.clipboard.writeText(caption);
      toast("캡션을 복사했어요.");
    } catch {
      setError("복사하지 못했어요. 캡션 칸에서 직접 복사해 주세요.");
    }
  };

  // 바뀔 내용 확인 — AI가 저장된 편집 계획에서 바꿀 곳을 정리한다(10~40초). 완성본은 아직 바뀌지 않는다
  const propose = () =>
    startProposing(async () => {
      setError(null);
      const r = await proposeRevisionAction({ requestId: card.requestId!, request });
      if (r.ok) setProposal(r);
      else setError(r.error);
    });

  const closeRevise = () => {
    setRevising(false);
    setProposal(null);
    setError(null);
  };

  const openPicker = () => {
    setPicking(true);
    setSelected(null);
    setReels(null);
    setError(null);
    startLoading(async () => {
      const r = await listRecentReelsAction({ planId: card.planId });
      if (r.ok) setReels(r.reels);
      else {
        setPicking(false);
        setError(r.error);
      }
    });
  };

  return (
    <article className="grid gap-4 rounded-lg border bg-card p-4 md:grid-cols-[260px_1fr]">
      <div className="mx-auto w-full max-w-[260px]">
        {card.videoUrl ? (
          <video
            src={card.videoUrl}
            poster={card.posterUrl ?? undefined}
            controls
            playsInline
            preload="metadata"
            onError={() => {
              if (refreshedOnce.current) return;
              refreshedOnce.current = true;
              router.refresh();
            }}
            className="aspect-[9/16] w-full rounded-md bg-black"
          />
        ) : (
          <div className="flex aspect-[9/16] w-full items-center justify-center rounded-md bg-muted px-4 text-center text-xs text-muted-foreground">
            {card.filesGone ? "보관 기간이 지나 파일을 지웠어요" : failed ? "편집에 실패했어요" : reviewable || posted ? "영상을 불러오지 못했어요. 새로 고쳐 주세요." : "AI가 편집하고 있어요 (보통 몇 분)"}
          </div>
        )}
      </div>

      <div className="min-w-0 space-y-3">
        <header className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">@{card.account}</span>
          {posted ? (
            <Badge variant="ok">
              <CheckCircle2 className="size-3.5" /> 올림
            </Badge>
          ) : failed ? (
            <Badge variant="destructive">편집 실패</Badge>
          ) : editing ? (
            <Badge variant="secondary">편집 중</Badge>
          ) : (
            <Badge>받기 전</Badge>
          )}
          {card.seconds != null && <span className="text-xs text-muted-foreground tabular-nums">{card.seconds.toFixed(1)}초</span>}
        </header>
        <div className="min-w-0">
          {card.ideaTitle && <p className="text-sm font-semibold">{card.ideaTitle}</p>}
          <p className="truncate text-sm text-muted-foreground">{card.productName}</p>
        </div>

        {posted && (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            {card.postedAt && (
              <span className="text-muted-foreground">
                <RelativeTime iso={card.postedAt} /> 올림
              </span>
            )}
            {card.postedPermalink && (
              <a href={card.postedPermalink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium underline underline-offset-2">
                릴스 보기 <ExternalLink className="size-3.5" />
              </a>
            )}
          </p>
        )}
        {card.deleteInDays != null && !card.filesGone && (
          <p className="rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-xs font-medium text-warn">
            {card.deleteInDays === 0 ? "오늘" : `${card.deleteInDays}일 뒤`} 파일이 지워져요. 필요하면 지금 받아 두세요.
          </p>
        )}
        {card.skippedCuts.length > 0 && <p className="text-xs text-warn">찍지 못해 뺀 컷: {card.skippedCuts.join(", ")}번. 내용이 이어지는지 봐 주세요.</p>}

        {card.error && failed && (
          <details className="rounded-md border border-risk/30 bg-risk-soft px-3 py-2 text-xs text-risk">
            <summary className="cursor-pointer font-semibold">자동 편집이 실패했어요. 다시 편집하거나 촬영 원본을 받아 직접 편집해 주세요.</summary>
            <p className="mt-1 break-all">{card.error}</p>
          </details>
        )}
        {!posted && card.blocking.length > 0 && (
          <div className="space-y-2 rounded-md border border-risk/30 bg-risk-soft px-3 py-2 text-xs text-risk">
            <p className="font-semibold">올리기 전에 꼭 고칠 내용</p>
            <ul className="space-y-0.5">
              {card.blocking.map((b) => (
                <li key={b}>✗ {b}</li>
              ))}
            </ul>
            <label className="flex items-start gap-2 pt-0.5 font-medium text-foreground">
              <input
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 accent-primary"
                checked={card.acked}
                disabled={card.acked || isPending}
                onChange={() => run(() => ackWarningsAction({ planId: card.planId, items: card.blocking }), "확인했어요.")}
              />
              위 내용을 확인했어요. 고쳐서 올릴게요.
            </label>
          </div>
        )}
        {reviewable && card.warnings.length > 0 && (
          <details className="rounded-md border border-warn/40 px-3 py-2 text-xs text-warn">
            <summary className="cursor-pointer font-semibold">AI 점검이 짚은 것 {card.warnings.length}개 — 보고 판단하세요</summary>
            <ul className="mt-1 space-y-0.5">
              {card.warnings.map((w) => (
                <li key={w}>· {w}</li>
              ))}
            </ul>
          </details>
        )}
        {reviewable && card.blocking.length === 0 && card.warnings.length === 0 && <p className="text-xs text-ok">광고 문구 규칙 ✓ · 판매 중 ✓ · AI 점검 ✓ (받은 뒤 고친 내용은 직접 확인해 주세요)</p>}

        {(ready || posted) && !card.filesGone && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              {!posted && card.hasFinal && (
                <Button disabled={!canDownload || loading} onClick={downloadFinal}>
                  <Download className="size-4" /> 완성본 받기
                </Button>
              )}
              <Button
                variant="outline"
                disabled={!canDownload || loading}
                onClick={() => {
                  if (showFiles) return setShowFiles(false);
                  loadFiles(() => setShowFiles(true));
                }}
              >
                <FolderDown className="size-4" /> 다시 편집용 파일
              </Button>
              {card.caption && (
                <Button variant="outline" onClick={copyCaption}>
                  <ClipboardCopy className="size-4" /> 캡션 복사
                </Button>
              )}
              {!posted && (
                <Button variant="outline" disabled={loading} onClick={openPicker}>
                  <CheckCircle2 className="size-4" /> 올렸어요
                </Button>
              )}
              {posted && (
                <Button variant="ghost" disabled={isPending} onClick={() => setAsk("unlink")}>
                  <Link2Off className="size-4" /> 연결 풀기
                </Button>
              )}
            </div>
            {!posted && !needsAck && <p className="text-xs text-muted-foreground">휴대폰에서 받으면 다운로드 폴더에 저장돼요. 인스타에 올린 뒤 ‘올렸어요’를 눌러 릴스를 연결해 주세요.</p>}

            {showFiles && files && (
              <div className="space-y-2 rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold">다시 편집용 파일</p>
                  <Button size="sm" variant="outline" className="hidden md:inline-flex" disabled={zipping !== null} onClick={() => downloadZip(files)}>
                    <FolderDown className="size-4" /> {zipping ? `묶는 중: ${zipping}` : "전체 ZIP 받기"}
                  </Button>
                </div>
                <ul className="divide-y text-sm">
                  {[...(files.final ? [{ ...files.final, label: "완성본" }] : []), ...(files.thumbnail ? [{ ...files.thumbnail, label: "표지" }] : []), ...files.clips.map((c) => ({ ...c, label: `${c.cut}번 촬영본` }))].map((f: ShootFile & { label: string }) => (
                    <li key={f.name} className="flex items-center justify-between gap-3 py-1.5">
                      <span className="min-w-0 truncate">
                        {f.label} {f.size != null && <span className="text-xs text-muted-foreground tabular-nums">{fileSize(f.size)}</span>}
                      </span>
                      <a href={f.downloadUrl} className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary underline-offset-2 hover:underline">
                        <Download className="size-3.5" /> 받기
                      </a>
                    </li>
                  ))}
                  {files.texts.map((t) => (
                    <li key={t.name} className="flex items-center justify-between gap-3 py-1.5">
                      <span className="min-w-0 truncate">{t.name}</span>
                      <a href={textHref(t.content)} download={t.name} className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary underline-offset-2 hover:underline">
                        <Download className="size-3.5" /> 받기
                      </a>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-muted-foreground">받기 주소는 한 시간 동안 쓸 수 있어요. ZIP은 PC에서 받아 주세요.</p>
              </div>
            )}
          </div>
        )}

        {(reviewable || editing) && canManage && (
          <details className="rounded-md border px-3 py-2" open={captionChanged}>
            <summary className="cursor-pointer text-xs font-semibold text-muted-foreground">캡션 보기 · 고치기</summary>
            <div className="mt-2 space-y-1.5">
              <Textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={6} maxLength={2200} aria-label="캡션" />
              {captionChanged && (
                <Button size="sm" variant="outline" disabled={isPending} onClick={() => run(() => saveCaptionAction({ planId: card.planId, caption }), "캡션을 저장했어요.")}>
                  <Save className="size-4" /> 캡션 저장
                </Button>
              )}
            </div>
          </details>
        )}
        {(!canManage || posted) && card.caption && (
          <details className="rounded-md border px-3 py-2">
            <summary className="cursor-pointer text-xs font-semibold text-muted-foreground">캡션 보기</summary>
            <p className="mt-2 whitespace-pre-wrap text-xs">{card.caption}</p>
          </details>
        )}

        {canManage && canRevise && revising && (
          <div className="space-y-2 rounded-md border border-dashed p-2.5">
            {card.planRestart && (
              <p className="rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-xs font-medium text-warn">
                {EDIT_RESTART_REASON[card.planRestart]} 다시 편집하면 지난 편집을 이어 쓰지 않고 처음부터 새로 편집해요. 따옴표 안에 적은 후킹 · 표지 글자만 남고, 나머지 고칠 내용은 반영되지 않아요.
              </p>
            )}
            <label className="block space-y-1 text-xs font-semibold">
              고칠 내용
              <Textarea
                value={request}
                rows={3}
                maxLength={REQUEST_MAX}
                disabled={proposing || isPending}
                placeholder={'예시: 후킹을 "이거 모르고 사면 손해"로 바꿔 줘. 3번 장면은 빼고, 음악은 더 잔잔하게.'}
                className="font-normal placeholder:text-faint"
                onChange={(e) => {
                  setRequest(e.target.value);
                  setProposal(null);
                }}
              />
            </label>
            <p className="text-xs text-muted-foreground">
              후킹 · 표지 · 읽는 말 · 자막 · 화면 문구 · 효과음 · 장면 순서 · 음악처럼 고치고 싶은 것을 적어 주세요. 따옴표 안에 적은 글자는 그대로 넣어요. 다시 편집하기 전에 바뀔 내용을 먼저 보여 드려요.{" "}
              <span className="tabular-nums">
                {request.length}/{REQUEST_MAX}
              </span>
            </p>

            {!proposal && (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" disabled={proposing || isPending || !request.trim()} onClick={propose}>
                  <ListChecks className="size-4" /> 바뀔 내용 확인
                </Button>
                <Button size="sm" variant="ghost" disabled={proposing} onClick={closeRevise}>
                  취소
                </Button>
                {proposing && <span className="text-xs text-muted-foreground">AI가 바뀔 내용을 정리하고 있어요. 10~40초쯤 걸려요.</span>}
              </div>
            )}

            {proposal && (
              <div className="space-y-2">
                {proposal.changes.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs font-semibold">
                      바뀌는 내용 <span className="tabular-nums">{proposal.changes.length}</span>개
                    </p>
                    <ul className="divide-y rounded-md border bg-card text-sm">
                      {proposal.changes.map((c, i) => (
                        <li key={`${i}-${c.label}`} className="grid gap-x-3 gap-y-0.5 px-3 py-2 sm:grid-cols-[9.5rem_1fr]">
                          <span className="text-xs font-semibold text-muted-foreground">{c.label}</span>
                          <div className="min-w-0 space-y-0.5">
                            <p className="break-words text-muted-foreground">
                              <span className="mr-1.5 text-xs font-semibold">전</span>
                              {c.before}
                            </p>
                            <p className="break-words font-medium">
                              <span className="mr-1.5 text-xs font-semibold text-primary">후</span>
                              {c.after}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {proposal.footage.length > 0 && (
                  <div className="space-y-1 rounded-md bg-brand-soft px-3 py-2">
                    <p className="text-xs font-semibold">촬영본을 다시 보고 골라요</p>
                    <ul className="space-y-0.5 text-sm">
                      {proposal.footage.map((f) => (
                        <li key={f}>· {f}</li>
                      ))}
                    </ul>
                    <p className="text-xs text-muted-foreground">이 요청은 바뀔 내용을 미리 보여 드릴 수 없어요. 다시 편집할 때 AI가 촬영본을 다시 분석해서 정해요.</p>
                  </div>
                )}
                {proposal.cannot.length > 0 && (
                  <div className="space-y-1 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">
                    <p className="font-semibold">반영하지 못한 요청</p>
                    <ul className="space-y-0.5">
                      {proposal.cannot.map((c, i) => (
                        <li key={`${i}-${c.request}`}>
                          · {c.request}
                          {c.request && c.reason ? " — " : ""}
                          {c.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {proposal.notes.length > 0 && (
                  <div className="space-y-1 text-xs text-muted-foreground">
                    <p className="font-semibold">참고</p>
                    <ul className="space-y-0.5">
                      {proposal.notes.map((n) => (
                        <li key={n}>· {n}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {!proposal.revisionId && <p className="text-sm">바뀌는 내용이 없어요. 고칠 내용을 더 자세히 적어 주세요.</p>}
                <div className="flex flex-wrap items-center gap-2">
                  {proposal.revisionId && (
                    <Button
                      size="sm"
                      disabled={isPending}
                      onClick={() =>
                        run(() => confirmRevisionAction({ requestId: card.requestId!, revisionId: proposal.revisionId! }), "다시 편집을 시작했어요. 몇 분 뒤 새 완성본이 나와요.", () => {
                          closeRevise();
                          setRequest("");
                        })
                      }
                    >
                      <RotateCcw className="size-4" /> 이대로 다시 편집
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" disabled={isPending} onClick={closeRevise}>
                    취소
                  </Button>
                  {proposal.revisionId && <span className="text-xs text-muted-foreground">취소하면 아무것도 바뀌지 않아요.</span>}
                </div>
              </div>
            )}
          </div>
        )}

        {canManage && !posted && (
          <div className="flex flex-wrap gap-2">
            {canRevise && (
              <Button size="sm" variant="ghost" disabled={isPending || proposing} onClick={() => (revising ? closeRevise() : setRevising(true))}>
                <Pencil className="size-4" /> 완성본 고치기
              </Button>
            )}
            {canReEdit && (
              <Button size="sm" variant="ghost" disabled={isPending} onClick={() => run(() => reEditAction({ requestId: card.requestId! }), "다시 편집을 시작했어요.")}>
                <RotateCcw className="size-4" /> 다시 편집
              </Button>
            )}
            {/* 실패 원인이 촬영본(너무 짧음 등)이거나 컷 하나를 다시 찍고 싶을 때 — 촬영 · 올리기로 되돌린다 */}
            {(failed || reviewable) && card.requestId && (
              <Button size="sm" variant="ghost" disabled={isPending} onClick={() => setAsk("reopen")}>
                <Upload className="size-4" /> 촬영본 다시 올리기
              </Button>
            )}
            <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={isPending} onClick={() => setAsk("skip")}>
              <SkipForward className="size-4" /> 이 기획 빼기
            </Button>
          </div>
        )}
        {error && <p className="text-xs text-risk">{error}</p>}

        <ConfirmDialog
          open={picking}
          title="어떤 릴스로 올렸나요?"
          confirmLabel="이 릴스로 연결"
          pending={isPending}
          confirmDisabled={!selected}
          onClose={() => setPicking(false)}
          onConfirm={() => {
            if (!selected) return;
            run(() => markPostedAction({ planId: card.planId, mediaId: selected }), "릴스를 연결했어요.", () => setPicking(false));
          }}
        >
          <p>@{card.account}에 올라간 최근 릴스예요. 방금 올렸는데 안 보이면 잠시 뒤 다시 열어 주세요.</p>
          {!reels ? (
            <p className="py-6 text-center text-muted-foreground">인스타에서 불러오는 중…</p>
          ) : reels.length === 0 ? (
            <p className="py-6 text-center text-muted-foreground">최근 릴스가 없어요.</p>
          ) : (
            <ul className="max-h-80 space-y-1 overflow-y-auto" role="radiogroup" aria-label="최근 릴스">
              {reels.map((r) => (
                <li key={r.id}>
                  <label
                    className={cn(
                      "flex items-center gap-3 rounded-md border p-2",
                      r.linked ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-surface-2",
                      selected === r.id && "border-primary bg-brand-soft",
                    )}
                  >
                    <input type="radio" name={`reel-${card.planId}`} className="sr-only" disabled={r.linked} checked={selected === r.id} onChange={() => setSelected(r.id)} />
                    {r.thumbnailUrl ? (
                      // 인스타 CDN 이미지
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.thumbnailUrl} alt="" className="h-16 w-9 shrink-0 rounded object-cover" />
                    ) : (
                      <span className="h-16 w-9 shrink-0 rounded bg-muted" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 block text-xs">{r.caption || "캡션 없음"}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {r.postedAt && <RelativeTime iso={r.postedAt} />}
                        {r.linked && " · 이미 연결됨"}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </ConfirmDialog>
        <ConfirmDialog
          open={ask === "skip"}
          title="이 기획을 뺄까요?"
          confirmLabel="빼기"
          danger
          pending={isPending}
          onClose={() => setAsk(null)}
          onConfirm={() => {
            setAsk(null);
            run(() => skipShootAction({ planId: card.planId }), "이 기획을 뺐어요.");
          }}
        >
          <p>이 화면에서 사라지고 파일은 보관 기간이 지나면 지워져요. 빼면 되돌릴 수 없어요.</p>
        </ConfirmDialog>
        <ConfirmDialog
          open={ask === "reopen"}
          title="촬영본을 다시 올릴까요?"
          confirmLabel="촬영 · 올리기로 되돌리기"
          pending={isPending}
          onClose={() => setAsk(null)}
          onConfirm={() => {
            setAsk(null);
            run(() => reopenShootAction({ requestId: card.requestId! }), "촬영 · 올리기로 되돌렸어요. 바꿀 컷만 다시 올려 주세요.");
          }}
        >
          <p>올린 촬영본은 남아 있어요. 바꿀 컷만 다시 올리고 &lsquo;다 올렸어요&rsquo;를 누르면 다시 편집해요.</p>
          {card.hasPlan && <p>촬영본이나 하고 싶은 말을 바꾸면 처음부터 새로 편집해요. 완성본 고치기로 고친 내용도 남지 않아요.</p>}
        </ConfirmDialog>
        <ConfirmDialog
          open={ask === "unlink"}
          title="릴스 연결을 풀까요?"
          confirmLabel="연결 풀기"
          pending={isPending}
          onClose={() => setAsk(null)}
          onConfirm={() => {
            setAsk(null);
            run(() => unlinkPostedAction({ planId: card.planId }), "연결을 풀었어요. 다시 ‘올렸어요’로 연결할 수 있어요.");
          }}
        >
          <p>인스타의 릴스는 그대로예요. 잘못 연결했을 때만 풀어 주세요.</p>
        </ConfirmDialog>
      </div>
    </article>
  );
}
