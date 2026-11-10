"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Check, Pencil, RotateCcw, X } from "lucide-react";
import {
  approveAnalysisAction,
  editAnalysisAction,
  reanalyzeAction,
  setExcludedAction,
  type ProductActionResult,
} from "@/app/(dashboard)/products/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RelativeTime } from "@/components/ui/relative-time";
import { Textarea } from "@/components/ui/textarea";
import type { ProductKind } from "@/lib/products/shops";
import { cn } from "@/lib/utils";

// 상품 요약 검수 패널 — 근거 확인된 특징 · 버려진 문장 · 건기식 기능성 문구 후보를 보여 주고,
// 승인 · 고치기 · 다시 분석 · 제외를 한다.

export interface ReviewClaim {
  claim: string;
  imageIndex: number | null;
  quote: string;
}

// 종류별 세부 항목 라벨 (lib/products/analysis/analyze.ts의 스키마와 같은 키)
const DETAIL_LABEL: Record<string, string> = {
  origin: "산지",
  variety: "품종 · 종류",
  weightOrCount: "중량 · 구성",
  sizeGrade: "크기 · 등급",
  preparation: "손질 · 가공",
  sweetness: "당도",
  taste: "맛 · 식감",
  storage: "보관",
  season: "제철 · 계절",
  packaging: "포장",
  productType: "유형",
  fullIngredients: "전성분",
  ingredientsComplete: "전성분 완결",
  concerns: "고민",
  skinTypes: "피부 타입",
  texture: "제형",
  certifiedFunctions: "기능성 표기",
  certification: "인증 표기",
  mainIngredients: "주원료",
  productForm: "제형",
  intake: "섭취",
  material: "소재",
  sizes: "사이즈",
  fit: "핏",
  colors: "색상",
  care: "세탁 · 관리",
  modelInfo: "모델",
};
// 따로 보여 주는 항목
const HIDDEN_DETAILS = new Set(["keyIngredients", "functionalClaims"]);

function detailText(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (typeof v === "boolean") return v ? "예" : "아니요";
  if (Array.isArray(v)) return v.length ? v.join(", ") : null;
  return String(v);
}

function useAction() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const run = (fn: () => Promise<ProductActionResult>, done: string, after?: () => void) =>
    startTransition(async () => {
      setMessage(null);
      const r = await fn();
      if (r.ok) {
        setMessage({ ok: true, text: done });
        after?.();
        router.refresh();
      } else setMessage({ ok: false, text: r.error });
    });
  return { isPending, message, run };
}

export function ProductReviewPanel(props: {
  productId: string;
  canManage: boolean;
  excluded: boolean;
  kind: ProductKind;
  oneLine: string;
  usage: string;
  cautions: string;
  isKindMatch: boolean | null;
  details: Record<string, unknown>;
  claims: ReviewClaim[];
  rejected: ReviewClaim[];
  healthFunctional: boolean | null;
  functionalClaims: string[];
  // 표현 규칙에서 확정한 기능성 문구 수 — 건기식은 이게 있어야 AI 후보가 된다
  approvedClaimCount: number;
  uncertainties: string[];
  edited: boolean;
  approvedAt: string | null;
  model: string | null;
  analyzedAt: string;
}) {
  const { isPending, message, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [oneLine, setOneLine] = useState(props.oneLine);
  const [usage, setUsage] = useState(props.usage);
  const [cautions, setCautions] = useState(props.cautions);
  const [keep, setKeep] = useState<Set<number>>(() => new Set(props.claims.map((_, i) => i)));

  const details = Object.entries(props.details).filter(
    ([k, v]) => !HIDDEN_DETAILS.has(k) && detailText(v) != null,
  );

  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        {props.approvedAt ? (
          <Badge variant="secondary" className="text-xs">
            사람 확인 <RelativeTime iso={props.approvedAt} format="date" />
          </Badge>
        ) : (
          <Badge variant="outline" className="text-xs">
            확인 전
          </Badge>
        )}
        {props.edited && <Badge variant="outline" className="text-xs">고친 요약</Badge>}
        <span>
          <RelativeTime iso={props.analyzedAt} /> 분석
        </span>
      </div>

      {props.kind === "HEALTH_FOOD" && (
        <div
          className={cn(
            "rounded-md border px-3 py-2 text-xs",
            props.healthFunctional ? "border-warn/40 bg-warn-soft" : "bg-muted/30",
          )}
        >
          <p className="font-semibold">
            {props.healthFunctional ? "건강기능식품으로 보임" : "일반 식품으로 보임 — 기능성 표현을 쓰면 안 돼요"}
          </p>
          {props.functionalClaims.length > 0 && (
            <>
              <p className="mt-1 text-muted-foreground">기능성 문구 후보 (원문 그대로 · 심의 문구는 표현 규칙에서 확정)</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {props.functionalClaims.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </>
          )}
          {props.healthFunctional && (
            <div className="mt-2 border-t border-warn/30 pt-2">
              <p className="font-semibold">AI 후보가 되려면 두 가지가 필요해요</p>
              <ul className="mt-1 space-y-0.5">
                <li>{props.approvedAt ? "✓" : "○"} 이 화면에서 분석 결과 확인</li>
                <li>
                  {props.approvedClaimCount > 0 ? "✓" : "○"}{" "}
                  <Link href="/rules" className="underline underline-offset-2">
                    표현 규칙
                  </Link>
                  에서 기능성 문구 확정{props.approvedClaimCount > 0 && ` (${props.approvedClaimCount}개)`}
                </li>
              </ul>
            </div>
          )}
        </div>
      )}
      {props.kind !== "HEALTH_FOOD" && props.isKindMatch === false && (
        <p className="rounded-md border border-warn/40 px-3 py-2 text-xs">
          카테고리와 상품 종류가 달라 보여요. 수집 카테고리 설정을 확인해 주세요.
        </p>
      )}

      {editing ? (
        <div className="space-y-2">
          <Field label="한 줄 소개">
            <Textarea value={oneLine} onChange={(e) => setOneLine(e.target.value)} rows={2} maxLength={200} />
          </Field>
          <Field label="사용 · 섭취 · 보관">
            <Textarea value={usage} onChange={(e) => setUsage(e.target.value)} rows={3} maxLength={2000} />
          </Field>
          <Field label="주의사항">
            <Textarea value={cautions} onChange={(e) => setCautions(e.target.value)} rows={3} maxLength={2000} />
          </Field>
        </div>
      ) : (
        <div className="space-y-2 text-sm">
          <p className="font-medium">{props.oneLine || "(한 줄 소개 없음)"}</p>
          {props.usage && <Small label="사용 · 섭취 · 보관">{props.usage}</Small>}
          {props.cautions && <Small label="주의사항">{props.cautions}</Small>}
        </div>
      )}

      {details.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {details.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{DETAIL_LABEL[k] ?? k}</dt>
              <dd className="break-words">{detailText(v)}</dd>
            </div>
          ))}
        </dl>
      )}

      <div>
        <p className="mb-1 text-xs font-semibold">
          콘텐츠에 쓸 수 있는 특징 <span className="font-normal text-muted-foreground">(원문 근거 확인됨)</span>
        </p>
        {props.claims.length === 0 ? (
          <p className="text-xs text-muted-foreground">없음</p>
        ) : (
          <ul className="space-y-1.5">
            {props.claims.map((c, i) => (
              <li key={i} className={cn("rounded-md border px-2 py-1.5 text-xs", editing && !keep.has(i) && "opacity-40 line-through")}>
                <div className="flex items-start gap-1.5">
                  {editing && (
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={keep.has(i)}
                      onChange={(e) => {
                        const next = new Set(keep);
                        if (e.target.checked) next.add(i);
                        else next.delete(i);
                        setKeep(next);
                      }}
                      aria-label="이 특징 남기기"
                    />
                  )}
                  <div>
                    <p>{c.claim}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      “{c.quote}” {c.imageIndex != null && `· 이미지 ${c.imageIndex + 1}`}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {props.rejected.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            원문에서 찾지 못해 버린 문장 {props.rejected.length}개
          </summary>
          <ul className="mt-1 space-y-1">
            {props.rejected.map((c, i) => (
              <li key={i} className="text-muted-foreground">
                ✗ {c.claim} — “{c.quote}”
              </li>
            ))}
          </ul>
        </details>
      )}

      {props.uncertainties.length > 0 && (
        <Small label="확실하지 않은 것">{props.uncertainties.join(" · ")}</Small>
      )}

      {props.canManage && (
        <div className="flex flex-wrap gap-2 border-t pt-3">
          {editing ? (
            <>
              <Button
                size="sm"
                disabled={isPending}
                onClick={() =>
                  run(
                    () =>
                      editAnalysisAction({
                        productId: props.productId,
                        oneLine,
                        usage,
                        cautions,
                        keepClaims: [...keep],
                      }),
                    "고친 요약을 저장했어요",
                    () => setEditing(false),
                  )
                }
              >
                <Check className="size-4" /> 저장하고 확인
              </Button>
              <Button size="sm" variant="ghost" disabled={isPending} onClick={() => setEditing(false)}>
                취소
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                disabled={isPending}
                onClick={() => run(() => approveAnalysisAction({ productId: props.productId }), "확인했어요")}
              >
                <Check className="size-4" /> 확인
              </Button>
              <Button size="sm" variant="outline" disabled={isPending} onClick={() => setEditing(true)}>
                <Pencil className="size-4" /> 고치기
              </Button>
            </>
          )}
        </div>
      )}
      <ProductActions
        productId={props.productId}
        canManage={props.canManage}
        excluded={props.excluded}
        hasAnalysis
        message={message}
      />
    </div>
  );
}

/** 다시 분석 · 제외 — 분석 결과가 없을 때도 쓴다. */
export function ProductActions({
  productId,
  canManage,
  excluded,
  hasAnalysis,
  message: outer,
}: {
  productId: string;
  canManage: boolean;
  excluded: boolean;
  hasAnalysis: boolean;
  message?: { ok: boolean; text: string } | null;
}) {
  const { isPending, message, run } = useAction();
  const shown = message ?? outer ?? null;
  if (!canManage) return null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={isPending}
          onClick={() => run(() => reanalyzeAction({ productId, fromImages: false }), "다시 분석을 시작했어요. 판매 중인 상품이면 몇 분 뒤 결과가 나와요.")}
        >
          <RotateCcw className="size-4" /> {hasAnalysis ? "요약만 다시" : "분석 대기로"}
        </Button>
        {hasAnalysis && (
          <Button
            size="sm"
            variant="outline"
            disabled={isPending}
            onClick={() => {
              if (window.confirm("상세 이미지를 처음부터 다시 분석할까요? AI 비용이 다시 듭니다.")) {
                run(() => reanalyzeAction({ productId, fromImages: true }), "이미지부터 다시 분석을 시작했어요. 판매 중인 상품이면 몇 분 뒤 결과가 나와요.");
              }
            }}
          >
            이미지부터 다시
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={isPending}
          className={excluded ? "" : "text-destructive hover:text-destructive"}
          onClick={() =>
            run(
              () => setExcludedAction({ productId, excluded: !excluded }),
              excluded ? "다시 포함했어요" : "추천 · 분석에서 뺐어요",
            )
          }
        >
          <X className="size-4" /> {excluded ? "제외 풀기" : "제외"}
        </Button>
      </div>
      {shown && <p className={cn("text-xs", shown.ok ? "text-muted-foreground" : "text-destructive")}>{shown.text}</p>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function Small({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="text-xs">
      <p className="text-muted-foreground">{label}</p>
      <p className="whitespace-pre-wrap">{children}</p>
    </div>
  );
}
