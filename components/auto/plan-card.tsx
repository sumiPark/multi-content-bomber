"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Check, ExternalLink, FileText, RotateCcw, SkipForward } from "lucide-react";
import {
  confirmAllAction,
  confirmPlanAction,
  skipPlanAction,
  type ConfirmResult, approveVideoAction, remakeVideoAction } from "@/app/(dashboard)/auto/confirm/actions";
import { won } from "@/components/products/labels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

// B 칸 하나 — 제안 상품 · 이유 · 대안. 컨펌 / 대안으로 바꿔 컨펌 / 건너뛰기.

export interface ProductBrief {
  id: string;
  name: string;
  price: number | null;
  url: string;
  image: string | null;
  stock: string;
  oneLine: string | null;
}

export interface PlanCardData {
  id: string;
  slotTime: string;
  status: string;
  reason: string | null;
  note: string | null;
  productChanged: boolean;
  product: ProductBrief | null;
  alternatives: { reason: string; product: ProductBrief }[];
  // 서버에서 계산 — 렌더 중 시계를 읽으면 서버 · 클라이언트 결과가 갈린다
  pastSlot: boolean;
  // 대본 워커 오류(OpenAI 한도 등)
  error: string | null;
  // 대본 · 점검 결과 (확인 뒤 AI가 씀)
  script: { hookScore: number | null; beats: { spoken: string; onScreen: string }[]; caption: string; fixedHook: boolean; fixedNotes: string[] } | null;
  issues: string[];
  // 발행 작업 상태 (예약된 칸)
  jobStatus: string | null;
  // 저장된 장면표가 있는지 (0054). 없으면 화면만 다시 만들 수 없다
  hasStoryboard: boolean;
  // 완성본 (서명 주소)
  video: { url: string; seconds: number | null; reading: string | null; music: { title?: string; creator?: string; license?: string; landing?: string } | null } | null;
}

const STATUS: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive" | "ok" }> = {
  PROPOSED: { label: "확인 대기", variant: "default" },
  CONFIRMED: { label: "확인됨 · 대본 쓰는 중", variant: "secondary" },
  SCRIPTED: { label: "대본 완료 · 영상 만드는 중", variant: "secondary" },
  RENDERED: { label: "완성 · 확인 대기", variant: "default" },
  BLOCKED: { label: "점검에 걸림", variant: "destructive" },
  SCHEDULED: { label: "예약됨", variant: "ok" },
  PUBLISHED: { label: "발행됨", variant: "ok" },
  SKIPPED: { label: "건너뜀", variant: "outline" },
  FAILED: { label: "실패", variant: "destructive" },
};

// 칸 상태는 예약에서 멈춰 있어 실제 결과는 발행 작업에서 읽는다
const JOB_STATUS: Record<string, { label: string; variant: "secondary" | "destructive" | "outline" | "ok" }> = {
  SUCCESS: { label: "발행됨", variant: "ok" },
  FAILED: { label: "발행 실패", variant: "destructive" },
  CANCELLED: { label: "발행 취소", variant: "outline" },
  PROCESSING: { label: "올리는 중", variant: "secondary" },
  RETRYING: { label: "올리는 중", variant: "secondary" },
};

function useRun() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<ConfirmResult>, done?: string) =>
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

export function PlanCard({ plan, canManage }: { plan: PlanCardData; canManage: boolean }) {
  const { isPending, error, run } = useRun();
  const blocked = plan.status === "BLOCKED";
  // 올릴 시각 전까지 확인하고 고칠 수 있다
  const editable = canManage && !plan.pastSlot && (blocked || plan.status === "PROPOSED" || plan.status === "CONFIRMED");
  const soldOut = !!plan.product && plan.product.stock !== "available";
  const [askSkip, setAskSkip] = useState(false);
  // 다시 만들기: 화면만(말 · 후킹 · 캡션 유지) / 대본부터. 메모는 이 칸에만 반영한다
  const [redo, setRedo] = useState<"visual" | "script" | null>(null);
  const [memo, setMemo] = useState("");
  const s = (plan.jobStatus && JOB_STATUS[plan.jobStatus]) || STATUS[plan.status] || { label: plan.status, variant: "outline" as const };
  const canRemake = canManage && (plan.status === "RENDERED" || plan.status === "BLOCKED") && (!!plan.video || !!plan.script);

  return (
    <div className={cn("space-y-3 rounded-lg border bg-card p-4", plan.status === "SKIPPED" && "opacity-60")}>
      <div className="flex items-center gap-2">
        <span className="text-base font-bold tabular-nums">{plan.slotTime}</span>
        <Badge variant={s.variant}>{s.label}</Badge>
        {plan.productChanged && <Badge variant="outline">사람이 바꿈</Badge>}
      </div>

      {plan.product ? (
        <ProductRow product={plan.product} />
      ) : (
        <p className="text-sm text-muted-foreground">상품 없음</p>
      )}
      {plan.reason && <p className="rounded-md bg-muted/40 px-3 py-2 text-xs leading-relaxed">AI 이유: {plan.reason}</p>}
      {plan.note && <p className="text-xs text-muted-foreground">{plan.note}</p>}
      {plan.error && (
        <p className="rounded-md border border-risk/30 bg-risk-soft px-3 py-2 text-xs text-risk">만드는 중에 오류가 났어요. 다음 실행(1시간 안)에 다시 시도해요. ({plan.error.slice(0, 120)})</p>
      )}
      {editable && soldOut && (
        <p className="rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">
          이 상품은 지금 판매 중이 아니라 확인할 수 없어요. {plan.alternatives.length > 0 ? "아래 다른 후보로 바꾸거나 건너뛰어 주세요." : "바꿀 후보가 없어 이 칸은 건너뛰어 주세요."}
        </p>
      )}

      {plan.issues.length > 0 && (
        <ul className={cn("space-y-0.5 rounded-md border px-3 py-2 text-xs", plan.status === "BLOCKED" ? "border-risk/30 bg-risk-soft text-risk" : "border-warn/40 bg-warn-soft text-warn")}>
          {plan.issues.map((i) => (
            <li key={i}>{plan.status === "BLOCKED" ? "✗" : "!"} {i}</li>
          ))}
        </ul>
      )}

      {plan.video && (
        <div className="space-y-2">
          <video src={plan.video.url} controls playsInline preload="metadata" className="aspect-[9/16] max-h-[480px] rounded-md bg-black" />
          {plan.video.reading && <p className="text-xs text-muted-foreground">글자 디자인: {plan.video.reading}</p>}
          {plan.video.music?.title && (
            <p className="text-xs text-muted-foreground">
              음악: {plan.video.music.landing ? <a href={plan.video.music.landing} target="_blank" rel="noreferrer" className="underline">{plan.video.music.title}</a> : plan.video.music.title}
              {plan.video.music.creator && ` · ${plan.video.music.creator}`}
              {plan.video.music.license && ` · ${plan.video.music.license.toUpperCase()}`}
            </p>
          )}
        </div>
      )}

      {canRemake && (
        <div className="flex flex-wrap gap-2">
          {plan.status === "RENDERED" && plan.video && (
            <Button size="sm" disabled={isPending} onClick={() => run(() => approveVideoAction({ planId: plan.id }), plan.pastSlot ? "바로 올려요." : "올릴 시각에 올라가요.")}>
              <Check className="size-4" /> 이대로 올리기
            </Button>
          )}
          <Button size="sm" variant={redo === "visual" ? "secondary" : "outline"} disabled={isPending || !plan.hasStoryboard} title={plan.hasStoryboard ? undefined : "저장된 장면표가 없는 칸이에요"} onClick={() => setRedo(redo === "visual" ? null : "visual")}>
            <RotateCcw className="size-4" /> 화면만 다시
          </Button>
          <Button size="sm" variant={redo === "script" ? "secondary" : "outline"} disabled={isPending} onClick={() => setRedo(redo === "script" ? null : "script")}>
            <FileText className="size-4" /> 대본부터 다시
          </Button>
          {(plan.status === "RENDERED" || plan.pastSlot) && (
            <Button size="sm" variant="ghost" disabled={isPending} onClick={() => setAskSkip(true)}>
              <SkipForward className="size-4" /> 이 칸 건너뛰기
            </Button>
          )}
        </div>
      )}

      {canRemake && redo && (
        <div className="space-y-2 rounded-md border px-3 py-2">
          <p className="text-xs text-muted-foreground">
            {redo === "visual" ? "후킹 · 말 · 캡션은 그대로 두고 화면 소재만 다시 골라요." : "장면표(대본)부터 새로 써요. 후킹 · 말 · 캡션도 바뀌어요."} 메모는 이 영상에만 반영해요.
          </p>
          <Textarea value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={500} rows={2} placeholder={redo === "visual" ? "예: 같은 사진이 너무 많이 나와요" : "예: 성분 설명보다 먹는 상황 위주로"} />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={isPending}
              onClick={() =>
                run(async () => {
                  const r = await remakeVideoAction({ planId: plan.id, kind: redo, memo: memo.trim() || undefined });
                  if (r.ok) {
                    setRedo(null);
                    setMemo("");
                  }
                  return r;
                }, redo === "visual" ? "화면만 다시 만들어요." : "대본부터 다시 만들어요.")
              }
            >
              다시 만들기
            </Button>
            <Button size="sm" variant="ghost" disabled={isPending} onClick={() => setRedo(null)}>
              취소
            </Button>
          </div>
        </div>
      )}

      {plan.script && plan.script.fixedNotes.length > 0 && (
        <ul className="space-y-0.5 rounded-md border border-warn/40 px-3 py-2 text-xs text-warn">
          {plan.script.fixedNotes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}

      {plan.script && (
        <details className="rounded-md border px-3 py-2 text-xs">
          <summary className="cursor-pointer font-semibold">
            AI가 쓴 대본 · 캡션{plan.script.fixedHook ? " (저장한 후킹 문구)" : plan.script.hookScore != null && ` (훅 ${Math.round(plan.script.hookScore)}점)`}
          </summary>
          <ol className="mt-2 space-y-1">
            {plan.script.beats.map((b, i) => (
              <li key={i}>
                <span className="text-muted-foreground">{i === 0 ? "훅" : i}.</span> {b.spoken}
                {b.onScreen && <span className="ml-1 rounded bg-muted px-1 text-xs">{b.onScreen}</span>}
              </li>
            ))}
          </ol>
          <p className="mt-2 whitespace-pre-wrap rounded bg-muted/40 p-2">{plan.script.caption}</p>
        </details>
      )}

      {canManage && plan.pastSlot && (plan.status === "PROPOSED" || plan.status === "CONFIRMED") && (
        <p className="rounded-md border border-warn/40 px-3 py-2 text-xs text-warn">
          올릴 시각이 지나 바꿀 수 없어요.{" "}
          {plan.status === "PROPOSED" ? "확인하지 않은 이 칸은 건너뛰어요." : "확인한 상품으로 만들어 끝나는 즉시 올려요."}
        </p>
      )}

      {editable && (
        <div className="flex flex-wrap gap-2">
          {plan.status === "PROPOSED" && (
            <Button size="sm" disabled={isPending || soldOut} onClick={() => run(() => confirmPlanAction({ planId: plan.id, productId: null }), "확인했어요. AI가 대본을 쓸 거예요.")}>
              <Check className="size-4" /> 이 상품으로 확인
            </Button>
          )}
          {blocked && (
            <Button size="sm" disabled={isPending || soldOut} onClick={() => run(() => confirmPlanAction({ planId: plan.id, productId: null }), "다시 쓰기를 시작했어요. 몇 분 뒤 새로 고쳐 주세요.")}>
              <RotateCcw className="size-4" /> 이 상품으로 다시 쓰기
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={isPending} onClick={() => setAskSkip(true)}>
            <SkipForward className="size-4" /> 이 칸 건너뛰기
          </Button>
        </div>
      )}

      {editable && plan.alternatives.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-muted-foreground">다른 후보로 바꾸기</p>
          {plan.alternatives.map((a) => (
            <div key={a.product.id} className="flex items-center gap-2 rounded-md border px-2 py-1.5">
              <ProductRow product={a.product} compact />
              <Button
                size="sm"
                variant="outline"
                className="ml-auto shrink-0"
                disabled={isPending}
                onClick={() => run(() => confirmPlanAction({ planId: plan.id, productId: a.product.id }), "상품을 바꿔 확인했어요.")}
              >
                이걸로 바꾸기
              </Button>
            </div>
          ))}
        </div>
      )}
      {error && <p className="text-xs text-risk">{error}</p>}
      <ConfirmDialog
        open={askSkip}
        title={`${plan.slotTime} 칸을 건너뛸까요?`}
        confirmLabel="건너뛰기"
        pending={isPending}
        onClose={() => setAskSkip(false)}
        onConfirm={() => {
          setAskSkip(false);
          run(() => skipPlanAction({ planId: plan.id }), "이 칸을 건너뛰었어요.");
        }}
      >
        <p>건너뛰면 되돌릴 수 없어요. 이 칸은 그날 비게 돼요.</p>
      </ConfirmDialog>
    </div>
  );
}

export function ProductRow({ product, compact }: { product: ProductBrief; compact?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      {product.image ? (
        // 몰 CDN 이미지
        // eslint-disable-next-line @next/next/no-img-element
        <img src={product.image} alt="" className={cn("shrink-0 rounded object-cover", compact ? "size-10" : "size-16")} />
      ) : (
        <div className={cn("shrink-0 rounded bg-muted", compact ? "size-10" : "size-16")} />
      )}
      <div className="min-w-0">
        <p className={cn("truncate font-medium", compact ? "text-xs" : "text-sm")}>{product.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {won(product.price)}
          {product.stock !== "available" && <span className="text-risk"> · 지금 판매 중 아님</span>}
          {!compact && product.oneLine && ` · ${product.oneLine}`}
        </p>
      </div>
      {!compact && (
        <a href={product.url} target="_blank" rel="noreferrer" className="ml-auto shrink-0 text-muted-foreground hover:text-foreground" aria-label="몰에서 보기">
          <ExternalLink className="size-4" />
        </a>
      )}
    </div>
  );
}

export function ConfirmAllButton({ slotDate, count }: { slotDate: string; count: number }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const r = await confirmAllAction({ slotDate });
            if (!r.ok) return setError(r.error);
            toast(`${r.count ?? 0}개를 확인했어요.${r.soldOut ? ` ${r.soldOut}개는 판매 중이 아니라 남겨 뒀어요.` : ""}`);
            router.refresh();
          })
        }
      >
        <Check className="size-4" /> {count}개 모두 그대로 확인
      </Button>
      {error && <p className="text-xs text-risk">{error}</p>}
    </div>
  );
}
