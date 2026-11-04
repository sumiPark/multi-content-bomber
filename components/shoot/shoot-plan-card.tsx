"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Camera, Plus, RefreshCw, Search, SkipForward, Trash2 } from "lucide-react";
import {
  addWantedProductAction,
  chooseIdeaAction,
  dismissIdeaAction,
  refreshIdeasAction,
  searchProductsAction,
  skipShootAction,
  type ProductHit,
  type ShootResult,
} from "@/app/(dashboard)/shoot/actions";
import { ProductRow, type ProductBrief } from "@/components/auto/plan-card";
import { won } from "@/components/products/labels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";

// 촬영 기획 고르기의 부품 — 계정 머리(새로 고침 · 원하는 상품 추가), 목록의 기획 카드, 진행 중인 기획 줄.

export interface ShootIdeaData {
  id: string;
  title: string;
  format: string;
  concept: string;
  why: string;
  product: ProductBrief | null;
}

export interface ShootProgressData {
  id: string;
  status: string;
  title: string | null;
  humanBrief: string | null;
  product: ProductBrief | null;
  note: string | null;
  error: string | null;
  issues: string[];
}

const STATUS: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive" | "ok"; href?: string; go?: string }> = {
  CONFIRMED: { label: "찍을 컷 목록 만드는 중", variant: "secondary" },
  SCRIPTED: { label: "촬영 대기", variant: "default", href: "/shoot/uploads", go: "촬영 · 올리기로" },
  SHOT: { label: "편집 중", variant: "secondary", href: "/shoot/review", go: "완성본 받기로" },
  RENDERED: { label: "편집 완료", variant: "ok", href: "/shoot/review", go: "완성본 받기로" },
  BLOCKED: { label: "멈춤", variant: "destructive" },
};

function useRun() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // 상품 중복 경고가 오면 막지 않고 물어본 뒤 force로 다시 부른다
  const [warning, setWarning] = useState<{ text: string; retry: () => Promise<ShootResult>; done?: string } | null>(null);
  const run = (fn: () => Promise<ShootResult>, done?: string, retry?: () => Promise<ShootResult>, after?: () => void) =>
    startTransition(async () => {
      setError(null);
      const r = await fn();
      if (r.ok) {
        if (done) toast(done);
        after?.();
        router.refresh();
      } else if (r.warning && retry) setWarning({ text: r.error, retry, done });
      else setError(r.error);
    });
  return { isPending, error, run, warning, setWarning };
}

export function ShootIdeaCard({ idea, canManage }: { idea: ShootIdeaData; canManage: boolean }) {
  const { isPending, error, run, warning, setWarning } = useRun();
  const chose = "골랐어요. 찍을 컷 목록을 만들고 있어요.";
  return (
    <article className="flex flex-col gap-2.5 rounded-lg border bg-card p-4">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold">{idea.title}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{idea.format}</p>
      </div>
      <p className="text-[13px] leading-relaxed">{idea.concept}</p>
      {idea.product && <ProductRow product={idea.product} compact />}
      <p className="text-xs text-muted-foreground">AI 이유: {idea.why}</p>
      {canManage && (
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
          <Button
            size="sm"
            disabled={isPending || !idea.product}
            onClick={() =>
              run(
                () => chooseIdeaAction({ planId: idea.id }),
                chose,
                () => chooseIdeaAction({ planId: idea.id, force: true }),
              )
            }
          >
            <Camera className="size-4" /> 이걸로 찍기
          </Button>
          <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={isPending} onClick={() => run(() => dismissIdeaAction({ planId: idea.id }), "기획을 지웠어요. 내일 새벽에 새 기획으로 채워요.")}>
            <Trash2 className="size-4" /> 지우기
          </Button>
        </div>
      )}
      {error && <p className="text-xs text-risk">{error}</p>}
      <DuplicateDialog warning={warning} pending={isPending} onClose={() => setWarning(null)} onConfirm={() => {
        if (!warning) return;
        const { retry, done } = warning;
        setWarning(null);
        run(retry, done);
      }} />
    </article>
  );
}

function DuplicateDialog({
  warning,
  pending,
  onClose,
  onConfirm,
}: {
  warning: { text: string } | null;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog open={warning !== null} title="겹치는 상품이에요" confirmLabel="그래도 찍기" pending={pending} onClose={onClose} onConfirm={onConfirm}>
      <p>{warning?.text}</p>
      <p>비슷한 시기에 같은 상품이 올라갈 수 있어요. 그래도 이 상품으로 찍을까요?</p>
    </ConfirmDialog>
  );
}

export function ShootProgressRow({ plan, canManage }: { plan: ShootProgressData; canManage: boolean }) {
  const { isPending, error, run } = useRun();
  const [askSkip, setAskSkip] = useState(false);
  const s = STATUS[plan.status] ?? { label: plan.status, variant: "outline" as const };
  const hasVideo = plan.status === "SHOT" || plan.status === "RENDERED";
  return (
    <li className="space-y-2 rounded-md border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={s.variant}>{s.label}</Badge>
        <span className="min-w-0 text-[13px] font-semibold">{plan.title ?? plan.product?.name ?? "기획"}</span>
        {!plan.title && <Badge variant="outline">직접 추가</Badge>}
        <span className="ml-auto flex items-center gap-1">
          {s.href && (
            <Link href={s.href} className="text-xs font-medium underline underline-offset-2">
              {s.go} →
            </Link>
          )}
          {canManage && (
            <Button size="sm" variant="ghost" disabled={isPending} onClick={() => setAskSkip(true)}>
              <SkipForward className="size-4" /> 빼기
            </Button>
          )}
        </span>
      </div>
      {plan.title && plan.product && <p className="text-xs text-muted-foreground">{plan.product.name}</p>}
      {plan.humanBrief && <p className="text-xs">메모: {plan.humanBrief}</p>}
      {plan.note && <p className="text-xs text-muted-foreground">{plan.note}</p>}
      {plan.error && (
        <details className="rounded-md border border-risk/30 bg-risk-soft px-3 py-2 text-xs text-risk">
          <summary className="cursor-pointer font-semibold">컷 목록을 만들다 오류가 났어요. 이 기획을 빼고 다른 기획을 고르거나 잠시 뒤 다시 해 주세요.</summary>
          <p className="mt-1 break-all">{plan.error}</p>
        </details>
      )}
      {plan.status === "BLOCKED" && plan.issues.length > 0 && (
        <ul className="space-y-0.5 rounded-md border border-risk/30 bg-risk-soft px-3 py-2 text-xs text-risk">
          {plan.issues.map((i) => (
            <li key={i}>✗ {i}</li>
          ))}
        </ul>
      )}
      {error && <p className="text-xs text-risk">{error}</p>}
      <ConfirmDialog
        open={askSkip}
        title="이 기획을 뺄까요?"
        confirmLabel="빼기"
        danger={hasVideo}
        pending={isPending}
        onClose={() => setAskSkip(false)}
        onConfirm={() => {
          setAskSkip(false);
          run(() => skipShootAction({ planId: plan.id }), "기획을 뺐어요.");
        }}
      >
        <p>{hasVideo ? "찍어 올린 영상도 받을 수 없게 돼요. " : ""}빼면 되돌릴 수 없어요.</p>
      </ConfirmDialog>
    </li>
  );
}

export function ShootAccountActions({ accountId, name, listCount }: { accountId: string; name: string; listCount: number }) {
  const { isPending, error, run } = useRun();
  const [adding, setAdding] = useState(false);
  const [askRefresh, setAskRefresh] = useState(false);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => setAdding((v) => !v)}>
          <Plus className="size-4" /> 원하는 상품 추가
        </Button>
        <Button size="sm" variant="outline" disabled={isPending} onClick={() => setAskRefresh(true)}>
          <RefreshCw className="size-4" /> 새로 고침
        </Button>
      </div>
      {adding && <WantedProduct accountId={accountId} onDone={() => setAdding(false)} />}
      {error && <p className="text-xs text-risk">{error}</p>}
      <ConfirmDialog
        open={askRefresh}
        title={`@${name} 기획을 새로 만들까요?`}
        confirmLabel="새로 고침"
        pending={isPending}
        onClose={() => setAskRefresh(false)}
        onConfirm={() => {
          setAskRefresh(false);
          run(() => refreshIdeasAction({ accountId }), "목록을 비웠어요. 몇 분 뒤 새 기획이 나와요.");
        }}
      >
        <p>{listCount > 0 ? `고르기 전 기획 ${listCount}개를 빼고` : "목록을"} AI가 다른 상품으로 새로 채워요. 고른 기획은 그대로예요.</p>
      </ConfirmDialog>
    </div>
  );
}

function WantedProduct({ accountId, onDone }: { accountId: string; onDone: () => void }) {
  const { isPending, error, run, warning, setWarning } = useRun();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ProductHit[] | null>(null);
  const [selected, setSelected] = useState<ProductHit | null>(null);
  const [brief, setBrief] = useState("");
  const [searching, startSearch] = useTransition();
  const [searchError, setSearchError] = useState<string | null>(null);
  const added = "상품을 추가했어요. 찍을 컷 목록을 만들고 있어요.";

  const search = () =>
    startSearch(async () => {
      setSearchError(null);
      const r = await searchProductsAction({ accountId, query });
      if (r.ok) setHits(r.hits);
      else setSearchError(r.error);
    });

  return (
    <div className="max-w-xl space-y-2 rounded-md border border-dashed bg-card p-3">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
      >
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="상품 이름으로 찾기" aria-label="상품 이름" />
        <Button size="sm" type="submit" className="h-9" disabled={searching || !query.trim()}>
          <Search className="size-4" /> 찾기
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">이 계정이 쓰는 몰 · 종류 중 판매 중이고 상세페이지 분석이 끝난 상품만 나와요.</p>
      {searchError && <p className="text-xs text-risk">{searchError}</p>}
      {hits && hits.length === 0 && <p className="text-xs text-muted-foreground">찾는 상품이 없어요.</p>}
      {hits && hits.length > 0 && !selected && (
        <ul className="max-h-64 space-y-1 overflow-y-auto">
          {hits.map((h) => (
            <li key={h.id}>
              <button type="button" onClick={() => setSelected(h)} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-surface-2">
                {h.image ? (
                  // 몰 CDN 이미지
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={h.image} alt="" className="size-9 shrink-0 rounded object-cover" />
                ) : (
                  <div className="size-9 shrink-0 rounded bg-muted" />
                )}
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium">{h.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
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
          />
          <Button
            size="sm"
            disabled={isPending}
            onClick={() =>
              run(
                () => addWantedProductAction({ accountId, productId: selected.id, brief: brief.trim() || null }),
                added,
                () => addWantedProductAction({ accountId, productId: selected.id, brief: brief.trim() || null, force: true }),
                onDone,
              )
            }
          >
            <Camera className="size-4" /> 이 상품으로 찍기
          </Button>
        </div>
      )}
      {error && <p className="text-xs text-risk">{error}</p>}
      <DuplicateDialog warning={warning} pending={isPending} onClose={() => setWarning(null)} onConfirm={() => {
        if (!warning) return;
        const { retry, done } = warning;
        setWarning(null);
        run(retry, done, undefined, onDone);
      }} />
    </div>
  );
}
