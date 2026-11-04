"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { CalendarCheck, Pencil, RotateCcw, Save, SkipForward, Upload } from "lucide-react";
import {
  approveShootAction,
  reEditAction,
  reopenShootAction,
  saveCaptionAction,
  skipShootAction,
  type ShootResult,
} from "@/app/(dashboard)/shoot/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";

// 완성본 하나 — 영상 미리보기 · 점검 결과 · 캡션 고치기 · 화면 문구/자막 고쳐 다시 편집 · 확인(예약) · 빼기.

export interface ReviewCardData {
  planId: string;
  requestId: string | null;
  requestStatus: string | null;
  account: string;
  slotDate: string;
  slotTime: string;
  status: string;
  productName: string;
  videoUrl: string | null;
  posterUrl: string | null;
  seconds: number | null;
  caption: string;
  cuts: { no: number; onScreen: string; subtitle: string | null }[];
  // 확인을 막는 것(광고 문구 규칙 · 판매 상태) / 사람이 판단할 것(AI 점검)
  blocking: string[];
  warnings: string[];
  error: string | null;
  tooLate: boolean;
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
  return { isPending, error, run };
}

export function ReviewCard({ card, canManage }: { card: ReviewCardData; canManage: boolean }) {
  const { isPending, error, run } = useRun();
  const [caption, setCaption] = useState(card.caption);
  const [editingTexts, setEditingTexts] = useState(false);
  const [texts, setTexts] = useState(card.cuts);
  const [ask, setAsk] = useState<"skip" | "reopen" | null>(null);
  const editing = card.status === "SHOT" && card.requestStatus !== "FAILED";
  const failed = card.requestStatus === "FAILED";
  const reviewable = card.status === "RENDERED";
  const captionChanged = caption.trim() !== card.caption.trim();

  return (
    <article className="grid gap-4 rounded-lg border bg-card p-4 md:grid-cols-[260px_1fr]">
      <div className="mx-auto w-full max-w-[260px]">
        {card.videoUrl ? (
          <video src={card.videoUrl} poster={card.posterUrl ?? undefined} controls playsInline preload="metadata" className="aspect-[9/16] w-full rounded-md bg-black" />
        ) : (
          <div className="flex aspect-[9/16] w-full items-center justify-center rounded-md bg-muted px-4 text-center text-xs text-muted-foreground">
            {failed ? "편집에 실패했어요" : reviewable ? "영상을 불러오지 못했어요. 새로 고쳐 주세요." : "AI가 편집하고 있어요 (보통 몇 분)"}
          </div>
        )}
      </div>

      <div className="min-w-0 space-y-3">
        <header className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">@{card.account}</span>
          <span className="text-sm tabular-nums">
            {card.slotDate.slice(5)} {card.slotTime}
          </span>
          {card.status === "SCHEDULED" ? (
            <Badge variant="ok">예약됨</Badge>
          ) : failed ? (
            <Badge variant="destructive">편집 실패</Badge>
          ) : editing ? (
            <Badge variant="secondary">편집 중</Badge>
          ) : (
            <Badge>확인 대기</Badge>
          )}
          {card.seconds != null && <span className="text-xs text-muted-foreground">{card.seconds.toFixed(1)}초</span>}
        </header>
        <p className="truncate text-sm">{card.productName}</p>

        {card.error && failed && (
          <details className="rounded-md border border-risk/30 bg-risk-soft px-3 py-2 text-xs text-risk">
            <summary className="cursor-pointer font-semibold">자동 편집이 실패했어요. 다시 편집하거나 촬영본을 다시 올려 주세요.</summary>
            <p className="mt-1 break-all">{card.error}</p>
          </details>
        )}
        {reviewable && card.blocking.length > 0 && (
          <ul className="space-y-0.5 rounded-md border border-risk/30 bg-risk-soft px-3 py-2 text-xs text-risk">
            <li className="font-semibold">고쳐야 확인할 수 있어요</li>
            {card.blocking.map((b) => (
              <li key={b}>✗ {b}</li>
            ))}
          </ul>
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
        {reviewable && card.blocking.length === 0 && card.warnings.length === 0 && (
          <p className="text-xs text-ok">광고 문구 규칙 ✓ · 판매 중 ✓ · AI 점검 ✓</p>
        )}

        {(reviewable || editing) && canManage && (
          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-muted-foreground">캡션</p>
            <Textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={6} maxLength={2200} />
            {captionChanged && (
              <Button size="sm" variant="outline" disabled={isPending} onClick={() => run(() => saveCaptionAction({ planId: card.planId, caption }), "캡션을 저장했어요.")}>
                <Save className="size-4" /> 캡션 저장
              </Button>
            )}
          </div>
        )}
        {card.status === "SCHEDULED" && <p className="whitespace-pre-wrap rounded bg-muted/40 p-2 text-xs">{card.caption}</p>}

        {reviewable && editingTexts && card.requestId && (
          <div className="space-y-2 rounded-md border border-dashed p-2.5">
            <p className="text-xs text-muted-foreground">컷마다 화면 문구 · 자막을 고치고 다시 편집하면 몇 분 뒤 새 완성본이 나와요. 자막을 비우면 그 컷 자막은 빠져요.</p>
            {texts.map((t, i) => (
              <div key={t.no} className="grid gap-1 sm:grid-cols-[2rem_1fr_1.4fr] sm:items-center">
                <span className="text-xs font-semibold">{t.no}.</span>
                <Input
                  value={t.onScreen}
                  maxLength={40}
                  placeholder="화면 문구"
                  onChange={(e) => setTexts((prev) => prev.map((x, j) => (j === i ? { ...x, onScreen: e.target.value } : x)))}
                />
                <Input
                  value={t.subtitle ?? ""}
                  maxLength={120}
                  placeholder="자막 (말한 내용)"
                  onChange={(e) => setTexts((prev) => prev.map((x, j) => (j === i ? { ...x, subtitle: e.target.value } : x)))}
                />
              </div>
            ))}
            <Button
              size="sm"
              disabled={isPending}
              onClick={() =>
                run(
                  () =>
                    reEditAction({
                      requestId: card.requestId!,
                      cuts: texts
                        .filter((t, i) => t.onScreen !== card.cuts[i].onScreen || (t.subtitle ?? "") !== (card.cuts[i].subtitle ?? ""))
                        .map((t) => ({ no: t.no, onScreen: t.onScreen, subtitle: t.subtitle })),
                    }),
                  "다시 편집을 시작했어요. 몇 분 뒤 새 완성본이 나와요.",
                  () => setEditingTexts(false),
                )
              }
            >
              <RotateCcw className="size-4" /> 고친 문구로 다시 편집
            </Button>
          </div>
        )}

        {canManage && (
          <div className="flex flex-wrap gap-2">
            {reviewable && (
              <Button
                disabled={isPending || card.blocking.length > 0 || captionChanged || card.tooLate}
                onClick={() => run(() => approveShootAction({ planId: card.planId }), `${card.slotTime}로 예약했어요.`)}
              >
                <CalendarCheck className="size-4" /> 확인 · {card.slotTime} 예약
              </Button>
            )}
            {reviewable && card.requestId && (
              <Button size="sm" variant="outline" disabled={isPending} onClick={() => setEditingTexts((v) => !v)}>
                <Pencil className="size-4" /> 화면 문구 · 자막 고치기
              </Button>
            )}
            {failed && card.requestId && (
              <Button size="sm" variant="outline" disabled={isPending} onClick={() => run(() => reEditAction({ requestId: card.requestId!, cuts: [] }), "다시 편집을 시작했어요.")}>
                <RotateCcw className="size-4" /> 다시 편집
              </Button>
            )}
            {/* 실패 원인이 촬영본(너무 짧음 등)이거나 컷 하나를 다시 찍고 싶을 때 — 촬영 · 올리기로 되돌린다 */}
            {(failed || reviewable) && card.requestId && (
              <Button
                size="sm"
                variant="outline"
                disabled={isPending}
                onClick={() => setAsk("reopen")}
              >
                <Upload className="size-4" /> 촬영본 다시 올리기
              </Button>
            )}
            {card.status !== "SCHEDULED" && (
              <Button size="sm" variant="ghost" disabled={isPending} onClick={() => setAsk("skip")}>
                <SkipForward className="size-4" /> 이 칸 건너뛰기
              </Button>
            )}
          </div>
        )}
        {reviewable && captionChanged && <p className="text-xs text-muted-foreground">캡션을 저장해야 확인할 수 있어요.</p>}
        {reviewable && card.tooLate && <p className="text-xs text-risk">올릴 시각이 지났거나 5분 안으로 다가와 예약할 수 없어요.</p>}
        {error && <p className="text-xs text-risk">{error}</p>}
        <ConfirmDialog
          open={ask === "skip"}
          title={`${card.slotTime} 칸을 건너뛸까요?`}
          confirmLabel="건너뛰기"
          danger
          pending={isPending}
          onClose={() => setAsk(null)}
          onConfirm={() => {
            setAsk(null);
            run(() => skipShootAction({ planId: card.planId }), "이 칸을 건너뛰었어요.");
          }}
        >
          <p>찍어 올린 영상도 올라가지 않아요. 건너뛰면 되돌릴 수 없어요.</p>
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
        </ConfirmDialog>
      </div>
    </article>
  );
}
