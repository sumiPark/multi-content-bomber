"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Check, ExternalLink, SkipForward } from "lucide-react";
import {
  confirmAllAction,
  confirmPlanAction,
  skipPlanAction,
  type ConfirmResult,
} from "@/app/(dashboard)/auto/confirm/actions";
import { won } from "@/components/products/labels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// B 칸 하나 — 제안 상품 · 이유 · 대안. 컨펌 / 대안으로 바꿔 컨펌 / 건너뛰기.

interface ProductBrief {
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
  pastDeadline: boolean;
}

const STATUS: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  PROPOSED: { label: "확인 대기", variant: "default" },
  CONFIRMED: { label: "확인됨 · 제작 대기", variant: "secondary" },
  SCRIPTED: { label: "대본 완료", variant: "secondary" },
  RENDERED: { label: "영상 완료", variant: "secondary" },
  BLOCKED: { label: "점검에 걸림", variant: "destructive" },
  SCHEDULED: { label: "예약됨", variant: "secondary" },
  PUBLISHED: { label: "발행됨", variant: "secondary" },
  SKIPPED: { label: "건너뜀", variant: "outline" },
  FAILED: { label: "실패", variant: "destructive" },
};

function useRun() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<ConfirmResult>) =>
    startTransition(async () => {
      setError(null);
      const r = await fn();
      if (r.ok) router.refresh();
      else setError(r.error);
    });
  return { isPending, error, run };
}

export function PlanCard({ plan, canManage }: { plan: PlanCardData; canManage: boolean }) {
  const { isPending, error, run } = useRun();
  const editable = canManage && (plan.status === "PROPOSED" || plan.status === "CONFIRMED") && !plan.pastDeadline;
  const s = STATUS[plan.status] ?? { label: plan.status, variant: "outline" as const };

  return (
    <div className={cn("space-y-3 rounded-lg border p-4", plan.status === "SKIPPED" && "opacity-60")}>
      <div className="flex items-center gap-2">
        <span className="text-lg font-bold tabular-nums">{plan.slotTime}</span>
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

      {canManage && plan.pastDeadline && (plan.status === "PROPOSED" || plan.status === "CONFIRMED") && (
        <p className="rounded-md border border-amber-400/50 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          확인 마감(올리기 전날 18시)이 지나 바꿀 수 없어요.{" "}
          {plan.status === "PROPOSED" ? "확인하지 않은 이 칸은 건너뜁니다." : "확인한 상품으로 만들어 올립니다."}
        </p>
      )}

      {editable && (
        <div className="flex flex-wrap gap-2">
          {plan.status === "PROPOSED" && (
            <Button size="sm" disabled={isPending} onClick={() => run(() => confirmPlanAction({ planId: plan.id, productId: null }))}>
              <Check className="size-4" /> 이 상품으로 확인
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={isPending} onClick={() => run(() => skipPlanAction({ planId: plan.id }))}>
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
                className="ml-auto h-7 shrink-0 text-xs"
                disabled={isPending}
                onClick={() => run(() => confirmPlanAction({ planId: plan.id, productId: a.product.id }))}
              >
                이걸로 바꾸기
              </Button>
            </div>
          ))}
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function ProductRow({ product, compact }: { product: ProductBrief; compact?: boolean }) {
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
          {product.stock !== "available" && <span className="text-destructive"> · 지금 판매 중 아님</span>}
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
  const { isPending, error, run } = useRun();
  return (
    <div className="flex flex-col items-end gap-1">
      <Button disabled={isPending} onClick={() => run(() => confirmAllAction({ slotDate }))}>
        <Check className="size-4" /> {count}개 모두 그대로 확인
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
