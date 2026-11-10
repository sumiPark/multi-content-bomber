"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Camera, ChevronRight, Plus, RefreshCw, Search, SkipForward, Trash2, X } from "lucide-react";
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

// 촬영 기획 고르기의 부품 — 계정 머리(새로 고침 · 원하는 상품 추가), 기획 목록 + 대본 서랍, 진행 중인 기획 줄.

export interface ShootIdeaData {
  id: string;
  title: string;
  format: string;
  concept: string;
  why: string;
  draft: { hook: string; beats: { scene: string; line: string }[] } | null;
  product: ProductBrief | null;
}

export interface ShootProgressData {
  id: string;
  // 촬영 요청이 있으면 그 상세로 바로 간다
  requestId: string | null;
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

/** 계정 기획 목록 — 짧은 줄로 훑고, 누르면 오른쪽 서랍에서 대본 초안을 읽고 고른다. */
export function ShootIdeaList({ ideas, account, canManage }: { ideas: ShootIdeaData[]; account: string; canManage: boolean }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = ideas.find((i) => i.id === openId) ?? null;
  return (
    <>
      <ul className="divide-y overflow-hidden rounded-lg border bg-card">
        {ideas.map((idea) => (
          <li key={idea.id}>
            <button type="button" onClick={() => setOpenId(idea.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2">
              {idea.product?.image ? (
                // 몰 CDN 이미지
                // eslint-disable-next-line @next/next/no-img-element
                <img src={idea.product.image} alt="" className="size-12 shrink-0 rounded object-cover" />
              ) : (
                <span className="size-12 shrink-0 rounded bg-muted" />
              )}
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="block text-sm font-semibold">
                  {idea.title} <span className="text-xs font-normal text-muted-foreground">· {idea.format}</span>
                </span>
                {idea.draft && <span className="block truncate text-sm text-ink-2">“{idea.draft.hook}”</span>}
                <span className="block truncate text-xs text-muted-foreground">
                  {idea.product?.name ?? "상품 정보 없음"}
                  {idea.product && ` · ${won(idea.product.price)}`}
                </span>
              </span>
              <span className="hidden shrink-0 text-xs font-medium text-primary sm:inline">대본 보기</span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      {open && <IdeaDrawer key={open.id} idea={open} account={account} canManage={canManage} onClose={() => setOpenId(null)} />}
    </>
  );
}

function IdeaDrawer({ idea, account, canManage, onClose }: { idea: ShootIdeaData; account: string; canManage: boolean; onClose: () => void }) {
  const { isPending, error, run, warning, setWarning } = useRun();
  const ref = useRef<HTMLDialogElement>(null);
  const chose = "골랐어요. 추천 대본을 만들고 있어요.";
  // 이 상품으로 하고 싶은 말(human_brief) — 추천 대본과 편집이 먼저 따른다. 촬영 화면에서도 고칠 수 있다
  const [brief, setBrief] = useState("");
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-label={`${idea.title} 대본`}
      className="fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-[480px] max-w-full border-l bg-card p-0 text-foreground shadow-[0_8px_24px_rgb(16_24_40/.12),0_2px_6px_rgb(16_24_40/.08)] backdrop:bg-black/40"
    >
      <div className="flex h-full flex-col">
        <header className="flex items-start justify-between gap-3 border-b px-5 py-4">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">
              @{account} · {idea.format}
            </p>
            <h2 className="mt-0.5 text-base font-bold">{idea.title}</h2>
          </div>
          <Button size="icon" variant="ghost" className="size-8 shrink-0" aria-label="닫기" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {idea.product && <ProductRow product={idea.product} />}

          {idea.draft ? (
            <section className="space-y-2.5">
              <h3 className="text-sm font-semibold text-muted-foreground">대본 초안</h3>
              <p className="rounded-md bg-brand-soft px-3 py-2.5 text-sm font-semibold">“{idea.draft.hook}”</p>
              <ol className="space-y-2.5">
                {idea.draft.beats.map((b, i) => (
                  <li key={i} className="flex gap-2.5 text-sm">
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold tabular-nums text-ink-2">{i + 1}</span>
                    <span className="min-w-0">
                      <span className="block leading-relaxed font-medium">{b.line}</span>
                      <span className="block text-xs leading-relaxed text-muted-foreground">{b.scene}</span>
                    </span>
                  </li>
                ))}
              </ol>
              <p className="text-xs text-muted-foreground">고르면 이 흐름대로 AI가 컷 목록 · 화면 문구 · 캡션을 쓰고 광고 문구 규칙을 점검해요. 그때 문구가 조금 바뀔 수 있어요.</p>
            </section>
          ) : (
            <p className="rounded-md border border-dashed px-3 py-2.5 text-xs text-muted-foreground">이 기획은 대본 초안이 없어요. 내일 새벽에 초안이 있는 기획으로 바뀌어요.</p>
          )}

          <section className="space-y-1">
            <h3 className="text-sm font-semibold text-muted-foreground">어떻게 찍나요</h3>
            <p className="text-sm leading-relaxed">{idea.concept}</p>
          </section>
          <section className="space-y-1">
            <h3 className="text-sm font-semibold text-muted-foreground">AI가 고른 이유</h3>
            <p className="text-sm leading-relaxed">{idea.why}</p>
          </section>
        </div>

        {canManage && (
          <footer className="space-y-2 border-t px-5 py-3">
            {idea.product && (
              <label className="block space-y-1 text-xs font-semibold">
                하고 싶은 말 <span className="font-normal text-muted-foreground">(선택)</span>
                <Textarea
                  value={brief}
                  maxLength={300}
                  rows={2}
                  placeholder="이 상품으로 꼭 보여 주거나 말하고 싶은 것. 비우면 대본 초안과 상품 정보로 만들어요."
                  onChange={(e) => setBrief(e.target.value)}
                />
              </label>
            )}
            {error && <p className="text-xs text-risk">{error}</p>}
            <div className="flex items-center gap-2">
              <Button
                className="flex-1"
                disabled={isPending || !idea.product}
                onClick={() =>
                  run(
                    () => chooseIdeaAction({ planId: idea.id, brief: brief.trim() || null }),
                    chose,
                    () => chooseIdeaAction({ planId: idea.id, brief: brief.trim() || null, force: true }),
                    onClose,
                  )
                }
              >
                <Camera className="size-4" /> 이걸로 찍기
              </Button>
              <Button variant="ghost" className="text-muted-foreground" disabled={isPending} onClick={() => run(() => dismissIdeaAction({ planId: idea.id }), "기획을 지웠어요. 내일 새벽에 새 기획으로 채워요.", undefined, onClose)}>
                <Trash2 className="size-4" /> 지우기
              </Button>
            </div>
          </footer>
        )}
      </div>
      <DuplicateDialog
        warning={warning}
        pending={isPending}
        onClose={() => setWarning(null)}
        onConfirm={() => {
          if (!warning) return;
          const { retry, done } = warning;
          setWarning(null);
          run(retry, done, undefined, onClose);
        }}
      />
    </dialog>
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
  const href = plan.status === "SCRIPTED" && plan.requestId ? `/shoot/uploads/${plan.requestId}` : s.href;
  return (
    <li className="space-y-2 rounded-md border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={s.variant}>{s.label}</Badge>
        <span className="min-w-0 text-sm font-semibold">{plan.title ?? plan.product?.name ?? "기획"}</span>
        {!plan.title && <Badge variant="outline">직접 추가</Badge>}
        <span className="ml-auto flex items-center gap-1">
          {href && (
            <Link href={href} className="text-xs font-medium underline underline-offset-2">
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
      {plan.humanBrief && <p className="text-xs">하고 싶은 말: {plan.humanBrief}</p>}
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
            aria-label="하고 싶은 말"
            placeholder="하고 싶은 말이 있으면 적어 주세요 (예: 손등에 덜어서 제형 보여 주기). 비워 두면 AI가 정해요."
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
