"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Camera, RefreshCw, Search, SkipForward } from "lucide-react";
import {
  chooseIdeaAction,
  pickProductAction,
  regenerateIdeasAction,
  searchProductsAction,
  skipShootAction,
  type ProductHit,
  type ShootResult,
} from "@/app/(dashboard)/shoot/actions";
import { ProductRow, type ProductBrief } from "@/components/auto/plan-card";
import { won } from "@/components/products/labels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

// 직접 촬영 칸 하나 — AI 기획안 후보 고르기 · 상품 직접 지정 · 다시 만들기 · 건너뛰기.

export interface ShootPlanCardData {
  id: string;
  slotTime: string;
  status: string;
  product: ProductBrief | null;
  productChanged: boolean;
  humanBrief: string | null;
  chosen: number | null;
  ideas: { title: string; format: string; concept: string; why: string; product: ProductBrief | null }[];
  note: string | null;
  error: string | null;
  issues: string[];
  pastSlot: boolean;
}

const STATUS: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  PROPOSED: { label: "고르기 전", variant: "default" },
  CONFIRMED: { label: "찍을 컷 목록 만드는 중", variant: "secondary" },
  SCRIPTED: { label: "촬영 대기", variant: "secondary" },
  SHOT: { label: "촬영 완료 · 편집 대기", variant: "secondary" },
  RENDERED: { label: "편집 완료 · 확인 대기", variant: "secondary" },
  BLOCKED: { label: "멈춤", variant: "destructive" },
  SCHEDULED: { label: "예약됨", variant: "secondary" },
  PUBLISHED: { label: "발행됨", variant: "secondary" },
  SKIPPED: { label: "건너뜀", variant: "outline" },
  FAILED: { label: "실패", variant: "destructive" },
};

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

export function ShootPlanCard({ plan, canManage }: { plan: ShootPlanCardData; canManage: boolean }) {
  const { isPending, error, run } = useRun();
  const [picking, setPicking] = useState(false);
  const s = STATUS[plan.status] ?? { label: plan.status, variant: "outline" as const };
  // 촬영본을 올리기 전까지는 다시 고를 수 있다(서버가 한 번 더 확인)
  const choosable = canManage && !plan.pastSlot && ["PROPOSED", "CONFIRMED", "SCRIPTED", "BLOCKED"].includes(plan.status);
  const skippable = canManage && !["SCHEDULED", "PUBLISHED", "SKIPPED"].includes(plan.status);
  const directPick = plan.chosen == null && plan.status !== "PROPOSED";

  return (
    <div className={cn("space-y-3 rounded-lg border p-4", plan.status === "SKIPPED" && "opacity-60")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-lg font-bold tabular-nums">{plan.slotTime}</span>
        <Badge variant={s.variant}>{s.label}</Badge>
        {directPick && <Badge variant="outline">직접 지정</Badge>}
        {plan.status === "SCRIPTED" && (
          <Link href="/shoot/uploads" className="ml-auto text-xs font-medium underline">
            촬영 · 올리기로 →
          </Link>
        )}
      </div>

      {plan.status !== "PROPOSED" && plan.product && (
        <div className="space-y-1.5 rounded-md bg-muted/40 p-2">
          <ProductRow product={plan.product} />
          {plan.chosen != null && plan.ideas[plan.chosen] && (
            <p className="text-xs">
              <b>{plan.ideas[plan.chosen].title}</b> · {plan.ideas[plan.chosen].concept}
            </p>
          )}
          {plan.humanBrief && <p className="text-xs">메모: {plan.humanBrief}</p>}
        </div>
      )}
      {plan.note && <p className="text-xs text-muted-foreground">{plan.note}</p>}
      {plan.error && <p className="text-xs text-destructive">처리 오류: {plan.error}</p>}
      {plan.issues.length > 0 && plan.status === "BLOCKED" && (
        <ul className="space-y-0.5 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {plan.issues.map((i) => (
            <li key={i}>✗ {i}</li>
          ))}
        </ul>
      )}

      {plan.ideas.length > 0 && (plan.status === "PROPOSED" || choosable) && (
        <div className="space-y-2">
          {plan.status !== "PROPOSED" && <p className="text-xs font-semibold text-muted-foreground">다른 후보로 바꾸기</p>}
          {plan.ideas.map((idea, i) =>
            plan.status !== "PROPOSED" && i === plan.chosen ? null : (
              <div key={i} className="space-y-1.5 rounded-md border p-2.5">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">
                      {idea.title} <span className="text-xs font-normal text-muted-foreground">· {idea.format}</span>
                    </p>
                    <p className="text-xs leading-relaxed">{idea.concept}</p>
                  </div>
                  {choosable && (
                    <Button
                      size="sm"
                      variant={plan.status === "PROPOSED" ? "default" : "outline"}
                      className="shrink-0"
                      disabled={isPending || !idea.product}
                      onClick={() => run(() => chooseIdeaAction({ planId: plan.id, ideaIndex: i }))}
                    >
                      <Camera className="size-4" /> 이걸로 찍기
                    </Button>
                  )}
                </div>
                {idea.product && <ProductRow product={idea.product} compact />}
                <p className="text-[11px] text-muted-foreground">AI 이유: {idea.why}</p>
              </div>
            ),
          )}
        </div>
      )}

      {(choosable || skippable) && (
        <div className="flex flex-wrap gap-2">
          {choosable && (
            <Button size="sm" variant="outline" disabled={isPending} onClick={() => setPicking((v) => !v)}>
              <Search className="size-4" /> 상품 직접 고르기
            </Button>
          )}
          {canManage && plan.status === "PROPOSED" && !plan.pastSlot && (
            <Button size="sm" variant="ghost" disabled={isPending} onClick={() => run(() => regenerateIdeasAction({ planId: plan.id }))}>
              <RefreshCw className="size-4" /> 후보 다시 만들기
            </Button>
          )}
          {skippable && (
            <Button size="sm" variant="ghost" disabled={isPending} onClick={() => run(() => skipShootAction({ planId: plan.id }))}>
              <SkipForward className="size-4" /> 이 칸 건너뛰기
            </Button>
          )}
        </div>
      )}

      {picking && choosable && <DirectPick planId={plan.id} onDone={() => setPicking(false)} />}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function DirectPick({ planId, onDone }: { planId: string; onDone: () => void }) {
  const { isPending, error, run } = useRun();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ProductHit[] | null>(null);
  const [selected, setSelected] = useState<ProductHit | null>(null);
  const [brief, setBrief] = useState("");
  const [searching, startSearch] = useTransition();
  const [searchError, setSearchError] = useState<string | null>(null);

  const search = () =>
    startSearch(async () => {
      setSearchError(null);
      const r = await searchProductsAction({ planId, query });
      if (r.ok) setHits(r.hits);
      else setSearchError(r.error);
    });

  return (
    <div className="space-y-2 rounded-md border border-dashed p-3">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
      >
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="상품 이름으로 찾기" className="h-8 text-sm" />
        <Button size="sm" type="submit" disabled={searching || !query.trim()}>
          찾기
        </Button>
      </form>
      <p className="text-[11px] text-muted-foreground">이 계정이 쓰는 몰 · 종류 중 판매 중이고 상세페이지 분석이 끝난 상품만 나와요.</p>
      {searchError && <p className="text-xs text-destructive">{searchError}</p>}
      {hits && hits.length === 0 && <p className="text-xs text-muted-foreground">찾는 상품이 없어요.</p>}
      {hits && hits.length > 0 && !selected && (
        <ul className="max-h-64 space-y-1 overflow-y-auto">
          {hits.map((h) => (
            <li key={h.id}>
              <button type="button" onClick={() => setSelected(h)} className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-muted">
                {h.image ? (
                  // 몰 CDN 이미지
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={h.image} alt="" className="size-9 shrink-0 rounded object-cover" />
                ) : (
                  <div className="size-9 shrink-0 rounded bg-muted" />
                )}
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium">{h.name}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {won(h.price)}
                    {h.oneLine && ` · ${h.oneLine}`}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected && (
        <div className="space-y-2">
          <p className="text-xs">
            고른 상품: <b>{selected.name}</b>{" "}
            <button type="button" className="underline" onClick={() => setSelected(null)}>
              다시 고르기
            </button>
          </p>
          <Textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            maxLength={300}
            rows={2}
            placeholder="찍고 싶은 게 있으면 적어 주세요 (예: 손등에 덜어서 제형 보여 주기). 비워 두면 AI가 정해요."
            className="text-xs"
          />
          <Button
            size="sm"
            disabled={isPending}
            onClick={() => run(async () => {
              const r = await pickProductAction({ planId, productId: selected.id, brief: brief.trim() || null });
              if (r.ok) onDone();
              return r;
            })}
          >
            <Camera className="size-4" /> 이 상품으로 찍기
          </Button>
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
