"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import {
  AlertTriangle,
  Ban,
  CalendarCheck,
  Check,
  CheckCircle2,
  ChevronDown,
  Clapperboard,
  ExternalLink,
  FileText,
  Hand,
  Loader2,
  RotateCcw,
  Search,
  SkipForward,
  Sparkles,
  XCircle,
} from "lucide-react";
import {
  approveVideoAction,
  confirmAllAction,
  confirmPlanAction,
  pickProductAction,
  remakeVideoAction,
  searchAutoProductsAction,
  skipPlanAction,
  type AutoProductHit,
  type ConfirmResult,
} from "@/app/(dashboard)/auto/confirm/actions";
import { won } from "@/components/products/labels";
import { SearchGroupHead, SearchMoreHint } from "@/components/products/search-group";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import type { UsedEvidence } from "@/lib/agents/knowledge";
import type { SearchGroup } from "@/lib/products/search";

// AI 자동 칸 하나 — 위: 시각 · 상태 · 진행 단계 / 가운데: 영상(없으면 상품 사진) + 상품 · 이유 · 알림 · 대본 / 아래: 조작 버튼.
// 사람이 할 일(확인 · 올리기)은 늘 카드 맨 아래 왼쪽 첫 버튼이다.

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
  // 지금 상품에 대한 AI 이유 (처음 제안이면 그 이유, 대안으로 바꿨으면 그 대안의 이유)
  reason: string | null;
  // 사람이 찾아 넣은 상품 — AI 이유가 없다
  humanPicked: boolean;
  note: string | null;
  productChanged: boolean;
  product: ProductBrief | null;
  // first = AI가 처음 제안한 상품(바꾼 뒤 되돌리기용)
  alternatives: { reason: string; first: boolean; product: ProductBrief }[];
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
  // lemo로 끝내 못 만들어 영상 없이 멈춘 칸(BLOCKED)의 이유. 있으면 "다시 만들기 필요"로 보여 준다
  needsRemake: string | null;
  // 이 영상이 쓴 근거 (저장된 장면표 기준). 장면표가 없으면 null
  evidence: UsedEvidence | null;
  // 완성본 (서명 주소)
  video: { url: string; seconds: number | null; reading: string | null; music: { title?: string; creator?: string; license?: string; landing?: string } | null } | null;
}

type BadgeVariant = "default" | "secondary" | "outline" | "destructive" | "ok" | "warn";
type StatusView = { label: string; variant: BadgeVariant; icon: typeof Check };

const STATUS: Record<string, StatusView> = {
  PROPOSED: { label: "상품 확인 대기", variant: "default", icon: Hand },
  CONFIRMED: { label: "대본 쓰는 중", variant: "secondary", icon: Loader2 },
  SCRIPTED: { label: "영상 만드는 중", variant: "secondary", icon: Loader2 },
  RENDERED: { label: "완성본 확인 대기", variant: "default", icon: Hand },
  BLOCKED: { label: "점검에서 멈춤", variant: "destructive", icon: AlertTriangle },
  SCHEDULED: { label: "예약됨", variant: "ok", icon: CalendarCheck },
  PUBLISHED: { label: "발행됨", variant: "ok", icon: CheckCircle2 },
  SKIPPED: { label: "건너뜀", variant: "outline", icon: SkipForward },
  FAILED: { label: "실패", variant: "destructive", icon: XCircle },
};

// 영상 제작에서 멈춘 칸(BLOCKED + needsRemake) — 점검이 아니라 영상을 만들지 못해 멈췄다
const NEEDS_REMAKE: StatusView = { label: "다시 만들기 필요", variant: "destructive", icon: AlertTriangle };

// 칸 상태는 예약에서 멈춰 있어 실제 결과는 발행 작업에서 읽는다
const JOB_STATUS: Record<string, StatusView> = {
  SUCCESS: { label: "발행됨", variant: "ok", icon: CheckCircle2 },
  FAILED: { label: "발행 실패", variant: "destructive", icon: XCircle },
  CANCELLED: { label: "발행 취소", variant: "outline", icon: Ban },
  PROCESSING: { label: "올리는 중", variant: "secondary", icon: Loader2 },
  RETRYING: { label: "올리는 중", variant: "secondary", icon: Loader2 },
};

// 진행 단계 — 사람 차례(상품 확인 · 완성본 확인)와 AI 차례를 한 줄로 보여 준다
const STEPS = ["상품 확인", "대본 · 점검", "영상 제작", "완성본 확인", "업로드"] as const;

/** 지금 단계 번호와 그 단계의 상태. 끝난 칸은 단계 수(전부 완료), 건너뜀 · 실패는 null(단계 줄을 숨긴다) */
function stepOf(plan: PlanCardData): { index: number; tone: "now" | "stop" } | null {
  if (plan.jobStatus === "SUCCESS") return { index: STEPS.length, tone: "now" };
  if (plan.jobStatus === "FAILED") return { index: 4, tone: "stop" };
  switch (plan.status) {
    case "PROPOSED":
      return { index: 0, tone: "now" };
    case "CONFIRMED":
      return { index: 1, tone: "now" };
    case "SCRIPTED":
      return { index: 2, tone: "now" };
    case "BLOCKED":
      // 완성본이 있으면 영상 점검, 영상 제작에서 멈췄으면(다시 만들기 필요) 영상 제작, 그 밖에는 대본 점검에서 멈췄다
      return { index: plan.video ? 3 : plan.needsRemake ? 2 : 1, tone: "stop" };
    case "RENDERED":
      return { index: 3, tone: "now" };
    case "SCHEDULED":
      return { index: 4, tone: "now" };
    case "PUBLISHED":
      return { index: STEPS.length, tone: "now" };
    default:
      return null;
  }
}

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
  const [picking, setPicking] = useState(false);
  const s = (plan.jobStatus && JOB_STATUS[plan.jobStatus]) || (blocked && plan.needsRemake ? NEEDS_REMAKE : null) || STATUS[plan.status] || { label: plan.status, variant: "outline" as const, icon: Clapperboard };
  const canRemake = canManage && (plan.status === "RENDERED" || plan.status === "BLOCKED") && (!!plan.video || !!plan.script);
  const canSkip = editable || (canRemake && (plan.status === "RENDERED" || plan.pastSlot));
  const canApprove = canRemake && plan.status === "RENDERED" && !!plan.video;
  const step = stepOf(plan);
  const StatusIcon = s.icon;

  const hasActions = canApprove || canRemake || editable || canSkip;

  return (
    <article
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border bg-card",
        blocked && "border-risk/40",
        plan.status === "SKIPPED" && "opacity-60",
      )}
    >
      {/* 머리: 시각 · 상태 · 진행 단계 */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3">
        <span className="text-lg leading-7 font-bold tabular-nums">{plan.slotTime}</span>
        <Badge variant={s.variant}>
          <StatusIcon className={cn(s.icon === Loader2 && "animate-spin")} />
          {s.label}
        </Badge>
        {plan.productChanged && <Badge variant="outline">사람이 바꿈</Badge>}
        {step && <StepTrack step={step} />}
      </header>

      <div className="grid flex-1 gap-4 p-4 sm:grid-cols-[180px_minmax(0,1fr)]">
        {/* 왼쪽: 완성본이 있으면 영상, 없으면 상품 사진 */}
        <div className="space-y-2">
          {plan.video ? (
            <>
              <video src={plan.video.url} controls playsInline preload="metadata" className="aspect-[9/16] w-full max-w-[220px] rounded-md bg-black sm:max-w-none" />
              <VideoMeta video={plan.video} />
            </>
          ) : plan.product?.image ? (
            // 몰 CDN 이미지
            // eslint-disable-next-line @next/next/no-img-element
            <img src={plan.product.image} alt="" className="aspect-square w-full max-w-[180px] rounded-md border object-cover" />
          ) : (
            <div className="flex aspect-square w-full max-w-[180px] items-center justify-center rounded-md bg-surface-2 text-xs text-faint">사진 없음</div>
          )}
        </div>

        {/* 오른쪽: 상품 → 이유 → 알림 → 대본 · 근거 → 다른 후보 */}
        <div className="min-w-0 space-y-4">
          {plan.product ? <ProductInfo product={plan.product} /> : <p className="text-sm text-muted-foreground">상품 없음</p>}

          {plan.reason ? (
            <Labeled label="AI가 고른 이유" icon={<Sparkles className="size-3.5" />}>
              <p className="text-sm leading-relaxed text-ink-2">{plan.reason}</p>
            </Labeled>
          ) : (
            plan.humanPicked && <p className="text-sm text-muted-foreground">사람이 직접 고른 상품이에요.</p>
          )}
          {/* 다시 만들기 필요 칸은 같은 이유를 아래 알림에 보여 준다 */}
          {plan.note && !plan.needsRemake && <p className="text-xs text-muted-foreground">{plan.note}</p>}

          <Notices plan={plan} editable={editable} soldOut={soldOut} canManage={canManage} />

          {(plan.script || plan.evidence) && (
            <div className="space-y-2">
              {plan.script && <ScriptDetails script={plan.script} />}
              {plan.evidence && <EvidenceList evidence={plan.evidence} />}
            </div>
          )}

          {editable && plan.alternatives.length > 0 && (
            <Fold title={`다른 후보 ${plan.alternatives.length}개`}>
              <ul className="divide-y">
                {plan.alternatives.map((a) => (
                  <li key={a.product.id} className="flex gap-3 py-3 first:pt-1 last:pb-1">
                    <Thumb src={a.product.image} />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p className="truncate text-sm font-medium">{a.product.name}</p>
                        {a.first && <Badge variant="outline">AI 처음 제안</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground tabular-nums">{won(a.product.price)}</p>
                      <p className="text-sm leading-relaxed text-ink-2">{a.reason}</p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0 self-start"
                      disabled={isPending}
                      onClick={() => run(() => confirmPlanAction({ planId: plan.id, productId: a.product.id }), "상품을 바꿔 확인했어요.")}
                    >
                      이걸로 바꾸기
                    </Button>
                  </li>
                ))}
              </ul>
            </Fold>
          )}
        </div>
      </div>

      {/* 아래: 조작 — 사람 차례인 주 버튼이 맨 앞, 건너뛰기는 맨 오른쪽 */}
      {hasActions && (
        <footer className="space-y-3 border-t bg-surface-2/60 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            {canApprove && (
              <Button disabled={isPending} onClick={() => run(() => approveVideoAction({ planId: plan.id }), plan.pastSlot ? "바로 올려요." : "올릴 시각에 올라가요.")}>
                <Check /> 이대로 올리기
              </Button>
            )}
            {editable && plan.status === "PROPOSED" && (
              <Button disabled={isPending || soldOut} onClick={() => run(() => confirmPlanAction({ planId: plan.id, productId: null }), "확인했어요. AI가 대본을 쓸 거예요.")}>
                <Check /> 이 상품으로 확인
              </Button>
            )}
            {editable && blocked && (
              <Button disabled={isPending || soldOut} onClick={() => run(() => confirmPlanAction({ planId: plan.id, productId: null }), "다시 쓰기를 시작했어요. 몇 분 뒤 새로 고쳐 주세요.")}>
                <RotateCcw /> 이 상품으로 다시 쓰기
              </Button>
            )}
            {canRemake && (
              <>
                <Button
                  variant={redo === "visual" ? "secondary" : "outline"}
                  aria-expanded={redo === "visual"}
                  disabled={isPending || !plan.hasStoryboard}
                  title={plan.hasStoryboard ? undefined : "저장된 장면표가 없는 칸이에요"}
                  onClick={() => setRedo(redo === "visual" ? null : "visual")}
                >
                  <RotateCcw /> 화면만 다시
                </Button>
                <Button variant={redo === "script" ? "secondary" : "outline"} aria-expanded={redo === "script"} disabled={isPending} onClick={() => setRedo(redo === "script" ? null : "script")}>
                  <FileText /> 대본부터 다시
                </Button>
              </>
            )}
            {editable && (
              <Button variant="outline" aria-expanded={picking} disabled={isPending} onClick={() => setPicking((v) => !v)}>
                <Search /> 다른 상품 직접 찾기
              </Button>
            )}
            {canSkip && (
              <Button variant="ghost" className="ml-auto text-muted-foreground" disabled={isPending} onClick={() => setAskSkip(true)}>
                <SkipForward /> 이 칸 건너뛰기
              </Button>
            )}
          </div>

          {canRemake && redo && (
            <div className="space-y-2 rounded-md border bg-card p-3">
              <p className="text-sm text-ink-2">
                {redo === "visual" ? "후킹 · 말 · 캡션은 그대로 두고 화면 소재만 다시 골라요." : "장면표(대본)부터 새로 써요. 후킹 · 말 · 캡션도 바뀌어요."}{" "}
                <span className="text-muted-foreground">메모는 이 영상에만 반영해요.</span>
              </p>
              <Textarea value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={500} rows={2} placeholder={redo === "visual" ? "예시: 같은 사진이 너무 많이 나와요" : "예시: 성분 설명보다 먹는 상황 위주로"} className="placeholder:text-faint" />
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

          {editable && picking && <ProductPicker planId={plan.id} disabled={isPending} run={run} onClose={() => setPicking(false)} />}
          {error && <p className="text-xs text-risk">{error}</p>}
        </footer>
      )}

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
    </article>
  );
}

/** 진행 단계 줄 — 끝난 단계는 체크, 지금 단계는 파랑(멈췄으면 빨강), 남은 단계는 흐리게 */
function StepTrack({ step }: { step: { index: number; tone: "now" | "stop" } }) {
  return (
    <ol className="flex w-full flex-wrap items-center gap-x-1 gap-y-1 text-xs md:ml-auto md:w-auto" aria-label="진행 단계">
      {STEPS.map((label, i) => {
        const done = i < step.index;
        const now = i === step.index;
        return (
          <li key={label} className="flex items-center gap-1">
            {i > 0 && <span aria-hidden className={cn("h-px w-3", done || now ? "bg-line-strong" : "bg-border")} />}
            <span
              aria-current={now ? "step" : undefined}
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 leading-6 whitespace-nowrap",
                done && "text-ok",
                now && step.tone === "now" && "bg-brand-soft font-semibold text-primary",
                now && step.tone === "stop" && "bg-risk-soft font-semibold text-risk",
                !done && !now && "text-faint",
              )}
            >
              {done && <Check className="size-3" />}
              {now && step.tone === "stop" && <AlertTriangle className="size-3" />}
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** 알림 상자 묶음 — 멈춤 · 오류(빨강)가 먼저, 확인 필요(주황)가 다음 */
function Notices({ plan, editable, soldOut, canManage }: { plan: PlanCardData; editable: boolean; soldOut: boolean; canManage: boolean }) {
  const blocked = plan.status === "BLOCKED";
  const late = canManage && plan.pastSlot && (plan.status === "PROPOSED" || plan.status === "CONFIRMED");
  const items: ReactNode[] = [];
  if (blocked && plan.needsRemake)
    items.push(
      <Notice key="remake" tone="risk" title="다시 만들기 필요">
        코드 애니메이션으로 영상을 만들지 못해 이 칸은 영상 없이 멈췄어요. 사진 · 스톡 영상으로는 만들지 않아요. &lsquo;화면만 다시&rsquo; 또는 &lsquo;대본부터 다시&rsquo;로 다시 만들어 주세요.
        <span className="mt-1 block break-all opacity-80">이유: {plan.needsRemake}</span>
      </Notice>,
    );
  if (plan.error)
    items.push(
      <Notice key="error" tone="risk" title="만드는 중에 오류가 났어요">
        다음 실행(1시간 안)에 다시 시도해요. <span className="break-all opacity-80">({plan.error.slice(0, 120)})</span>
      </Notice>,
    );
  if (plan.issues.length > 0)
    items.push(
      <Notice key="issues" tone={blocked ? "risk" : "warn"} title={blocked ? "점검에서 어긋난 점" : "점검이 짚은 점"}>
        <ul className="list-disc space-y-0.5 pl-4">
          {plan.issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      </Notice>,
    );
  if (editable && soldOut)
    items.push(
      <Notice key="soldout" tone="warn" title="지금 판매 중이 아닌 상품이에요">
        {plan.alternatives.length > 0 ? "다른 후보로 바꾸거나 이 칸을 건너뛰어 주세요." : "바꿀 후보가 없어 이 칸은 건너뛰어 주세요."}
      </Notice>,
    );
  if (plan.script && plan.script.fixedNotes.length > 0)
    items.push(
      <Notice key="fixed" tone="warn">
        <ul className="space-y-0.5">
          {plan.script.fixedNotes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </Notice>,
    );
  if (late)
    items.push(
      <Notice key="late" tone="warn" title="올릴 시각이 지나 바꿀 수 없어요">
        {plan.status === "PROPOSED" ? "확인하지 않은 이 칸은 건너뛰어요." : "확인한 상품으로 만들어 끝나는 즉시 올려요."}
      </Notice>,
    );
  if (!items.length) return null;
  return <div className="space-y-2">{items}</div>;
}

function Notice({ tone, title, children }: { tone: "risk" | "warn"; title?: string; children: ReactNode }) {
  const Icon = tone === "risk" ? XCircle : AlertTriangle;
  return (
    <div className={cn("flex gap-2.5 rounded-md border px-3 py-2.5 text-sm", tone === "risk" ? "border-risk/30 bg-risk-soft" : "border-warn/40 bg-warn-soft")}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", tone === "risk" ? "text-risk" : "text-warn")} />
      <div className="min-w-0 space-y-0.5 text-ink-2">
        {title && <p className={cn("font-semibold", tone === "risk" ? "text-risk" : "text-warn")}>{title}</p>}
        <div>{children}</div>
      </div>
    </div>
  );
}

/** 접는 영역 — 요약 줄 + 오른쪽 화살표 */
function Fold({ title, extra, children }: { title: ReactNode; extra?: ReactNode; children: ReactNode }) {
  return (
    <details className="group rounded-md border">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-sm font-semibold select-none hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">{title}</span>
        {extra}
        <ChevronDown className="ml-auto size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t px-3 py-3">{children}</div>
    </details>
  );
}

function Labeled({ label, icon, children }: { label: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
        {icon}
        {label}
      </p>
      {children}
    </div>
  );
}

function ScriptDetails({ script }: { script: NonNullable<PlanCardData["script"]> }) {
  const hook = script.fixedHook ? (
    <Badge variant="secondary">저장한 후킹 문구</Badge>
  ) : (
    script.hookScore != null && <Badge variant="secondary">훅 {Math.round(script.hookScore)}점</Badge>
  );
  return (
    <Fold title="AI가 쓴 대본 · 캡션" extra={hook}>
      <ol className="space-y-2.5">
        {script.beats.map((b, i) => (
          <li key={i} className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-2 text-sm">
            <span className={cn("pt-px text-xs font-semibold tabular-nums", i === 0 ? "text-primary" : "text-muted-foreground")}>{i === 0 ? "훅" : i}</span>
            <div className="space-y-1">
              <p className="leading-relaxed">{b.spoken}</p>
              {b.onScreen && (
                <p className="w-fit rounded bg-surface-2 px-1.5 text-xs leading-5 text-ink-2">
                  <span className="text-muted-foreground">화면 글자</span> {b.onScreen}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
      {script.caption && (
        <div className="mt-3 space-y-1 border-t pt-3">
          <p className="text-xs font-medium text-muted-foreground">캡션</p>
          <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink-2">{script.caption}</p>
        </div>
      )}
    </Fold>
  );
}

function VideoMeta({ video }: { video: NonNullable<PlanCardData["video"]> }) {
  if (!video.reading && !video.music?.title) return null;
  return (
    <dl className="space-y-1 text-xs text-muted-foreground">
      {video.reading && (
        <div>
          <dt className="inline font-medium">글자 디자인 </dt>
          <dd className="inline">{video.reading}</dd>
        </div>
      )}
      {video.music?.title && (
        <div>
          <dt className="inline font-medium">음악 </dt>
          <dd className="inline">
            {video.music.landing ? (
              <a href={video.music.landing} target="_blank" rel="noreferrer" className="underline hover:text-foreground">
                {video.music.title}
              </a>
            ) : (
              video.music.title
            )}
            {video.music.creator && ` · ${video.music.creator}`}
            {video.music.license && ` · ${video.music.license.toUpperCase()}`}
          </dd>
        </div>
      )}
    </dl>
  );
}

function ProductInfo({ product }: { product: ProductBrief }) {
  return (
    <div className="space-y-1">
      <div className="flex items-start gap-2">
        <h3 className="min-w-0 text-base leading-6 font-semibold">{product.name}</h3>
        <a href={product.url} target="_blank" rel="noreferrer" className="mt-0.5 ml-auto inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          몰에서 보기 <ExternalLink className="size-3.5" />
        </a>
      </div>
      <p className="flex flex-wrap items-center gap-x-2 text-sm">
        <span className="font-medium tabular-nums">{won(product.price)}</span>
        {product.stock !== "available" && <span className="font-medium text-risk">지금 판매 중 아님</span>}
      </p>
      {product.oneLine && <p className="text-sm text-muted-foreground">{product.oneLine}</p>}
    </div>
  );
}

function Thumb({ src }: { src: string | null }) {
  return src ? (
    // 몰 CDN 이미지
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" className="size-12 shrink-0 rounded-md border object-cover" />
  ) : (
    <div className="size-12 shrink-0 rounded-md bg-surface-2" />
  );
}

/**
 * 상품 직접 찾아 넣기 — 이 계정이 쓰는 몰 · 종류에서 판매 중 · 분석 완료 상품만 나온다.
 * 최근에 쓴 상품 · 다른 계정이 진행 중인 상품은 서버가 경고를 돌려주고, 확인하면 그대로 넣는다(직접 촬영과 같다).
 */
function ProductPicker({ planId, disabled, run, onClose }: { planId: string; disabled: boolean; run: ReturnType<typeof useRun>["run"]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<SearchGroup[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, startSearch] = useTransition();
  const [warn, setWarn] = useState<{ hit: AutoProductHit; message: string } | null>(null);

  const search = () => {
    if (!query.trim()) return;
    startSearch(async () => {
      setSearchError(null);
      const r = await searchAutoProductsAction({ planId, query: query.trim() });
      if (r.ok) setGroups(r.groups);
      else {
        setGroups(null);
        setSearchError(r.error);
      }
    });
  };

  const pick = (hit: AutoProductHit, force: boolean) =>
    run(async () => {
      const r = await pickProductAction({ planId, productId: hit.id, force });
      // 겹침 경고는 오류로 보이지 않고 확인 창으로 묻는다
      if (!r.ok && r.warning) {
        setWarn({ hit, message: r.error });
        return { ok: true };
      }
      if (r.ok) {
        toast("고른 상품으로 확인했어요. AI가 대본을 쓸 거예요.");
        onClose();
      }
      return r;
    });

  return (
    <div className="space-y-2 rounded-md border bg-card p-3">
      <p className="text-sm text-ink-2">
        상품 직접 찾기 <span className="text-muted-foreground">— 이 계정이 쓰는 상품 종류 중 판매 중이고 상세페이지 분석이 끝난 상품만 나와요.</span>
      </p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
      >
        <Input value={query} onChange={(e) => setQuery(e.target.value)} maxLength={50} placeholder="상품 이름" autoFocus />
        <Button type="submit" variant="outline" disabled={searching || !query.trim()}>
          {searching ? <Loader2 className="animate-spin" /> : <Search />} 찾기
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          닫기
        </Button>
      </form>
      {searchError && <p className="text-xs text-risk">{searchError}</p>}
      {groups && groups.length === 0 && <p className="text-sm text-muted-foreground">맞는 상품이 없어요.</p>}
      {groups && groups.length > 0 && (
        <>
          <SearchMoreHint groups={groups} />
          <div className="max-h-[28rem] space-y-3 overflow-y-auto">
            {groups.map((g) => (
              <section key={g.label}>
                <SearchGroupHead group={g} />
                <ul className="divide-y rounded-md border">
                  {g.hits.map((h) => (
                    <li key={h.id} className="flex items-center gap-3 px-3 py-2">
                      <Thumb src={h.image} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{h.name}</p>
                        <p className="truncate text-xs text-muted-foreground tabular-nums">
                          {won(h.price)}
                          {h.oneLine && ` · ${h.oneLine}`}
                        </p>
                      </div>
                      <Button size="sm" variant="outline" className="shrink-0" disabled={disabled} onClick={() => pick(h, false)}>
                        이걸로 확인
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}
      <ConfirmDialog
        open={!!warn}
        title="그래도 이 상품으로 할까요?"
        confirmLabel="이 상품으로 확인"
        pending={disabled}
        onClose={() => setWarn(null)}
        onConfirm={() => {
          const w = warn;
          setWarn(null);
          if (w) pick(w.hit, true);
        }}
      >
        <p>
          {warn?.hit.name} — {warn?.message}
        </p>
      </ConfirmDialog>
    </div>
  );
}

// 장면 번호 표기 — 대본 목록과 같게 첫 장면은 "훅"
const sceneLabel = (scenes: number[]) => scenes.map((i) => (i === 0 ? "훅" : String(i))).join(" · ");

/** 이 영상이 쓴 근거. 승인 전 초안 카드를 썼으면 요약 줄에 표시해 사람이 출처를 보고 확인하게 한다 */
function EvidenceList({ evidence }: { evidence: UsedEvidence }) {
  const drafts = evidence.cards.filter((c) => !c.approved).length;
  const parts = [
    evidence.cards.length ? `상식 카드 ${evidence.cards.length}개` : null,
    evidence.differences.length ? `우리 차이 ${evidence.differences.length}개` : null,
    evidence.productScenes ? `상품 자료 ${evidence.productScenes}장면` : null,
    evidence.commonScenes ? `일반 상식 ${evidence.commonScenes}장면` : null,
  ].filter(Boolean);
  return (
    <Fold
      title={
        <>
          쓴 근거 <span className="font-normal text-muted-foreground">{parts.length ? parts.join(" · ") : "없음"}</span>
        </>
      }
      extra={drafts > 0 && <Badge variant="warn">승인 전 초안 {drafts}개</Badge>}
    >
      {(evidence.cards.length > 0 || evidence.differences.length > 0) && (
        <ul className="space-y-3">
          {evidence.cards.map((c) => (
            <li key={c.id} className="space-y-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant={c.approved ? "ok" : "warn"}>{c.approved ? "승인" : "초안"}</Badge>
                <span className="text-sm font-medium">{c.topic}</span>
                <span className="text-xs text-muted-foreground">장면 {sceneLabel(c.scenes)}</span>
              </div>
              <p className="text-sm leading-relaxed text-ink-2">{c.statement}</p>
              <a href={c.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                {c.sourceTitle} <ExternalLink className="size-3" />
              </a>
            </li>
          ))}
          {evidence.differences.map((d) => (
            <li key={d.id} className="space-y-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="ok">확정한 차이</Badge>
                <span className="text-xs text-muted-foreground">장면 {sceneLabel(d.scenes)}</span>
              </div>
              <p className="text-sm leading-relaxed text-ink-2">
                {d.difference} <span className="text-muted-foreground">(비교 대상: {d.compareTo})</span>
              </p>
            </li>
          ))}
        </ul>
      )}
      <p className={cn("text-xs text-muted-foreground", (evidence.cards.length > 0 || evidence.differences.length > 0) && "mt-3")}>
        장면표를 쓸 때의 상태예요. 그 뒤에 승인한 카드는 &quot;대본부터 다시&quot;로 만들면 반영돼요.
      </p>
    </Fold>
  );
}

// 직접 촬영 기획 카드도 쓰는 상품 한 줄 — 생김새를 바꾸면 그 화면도 바뀌니 그대로 둔다
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

/** 그날 확인 대기 칸 모두 확인. 계정 탭에서는 그 계정 칸만 확인한다 */
export function ConfirmAllButton({ slotDate, count, accountId, accountName }: { slotDate: string; count: number; accountId: string | null; accountName: string | null }) {
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
            const r = await confirmAllAction({ slotDate, ...(accountId ? { accountId } : {}) });
            if (!r.ok) return setError(r.error);
            toast(`${r.count ?? 0}개를 확인했어요.${r.soldOut ? ` ${r.soldOut}개는 판매 중이 아니라 남겨 뒀어요.` : ""}`);
            router.refresh();
          })
        }
      >
        <Check /> {accountName ? `@${accountName} ` : ""}{count}개 모두 그대로 확인
      </Button>
      {error && <p className="text-xs text-risk">{error}</p>}
    </div>
  );
}
