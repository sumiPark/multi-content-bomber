"use client";

import { useMemo, useState, useTransition } from "react";
import { ExternalLink, Plus, Sparkles } from "lucide-react";
import {
  requestDraftAction,
  reviewCardAction,
  reviewDifferenceAction,
  saveCardAction,
  saveDifferenceAction,
  type KnowledgeResult,
} from "@/app/(dashboard)/auto/knowledge/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";

export interface CardRow {
  id: string;
  product_kind: string;
  topic: string;
  terms: string[];
  statement: string;
  source_title: string;
  source_url: string;
  source_quote: string;
  source_checked: boolean;
  status: "DRAFT" | "APPROVED" | "REJECTED";
  origin: "AI" | "HUMAN";
  created_at: string;
}

export interface DifferenceRow {
  id: string;
  product_id: string;
  difference: string;
  compare_to: string;
  evidence: string;
  status: "DRAFT" | "CONFIRMED" | "REJECTED";
  origin: "AI" | "HUMAN";
}

export interface ProductRow {
  id: string;
  name: string;
  kindLabel: string;
  upcoming: boolean;
}

const KINDS = [
  { value: "COSMETIC", label: "화장품" },
  { value: "HEALTH_FOOD", label: "건강식품" },
  { value: "FRUIT", label: "과일" },
  { value: "CLOTHING", label: "의류" },
  { value: "ALL", label: "전체" },
] as const;
type KindValue = (typeof KINDS)[number]["value"];

const kindLabel = (k: string) => KINDS.find((x) => x.value === k)?.label ?? k;

function useRun() {
  const [pending, start] = useTransition();
  const run = (job: () => Promise<KnowledgeResult>, done: string, after?: () => void) =>
    start(async () => {
      const res = await job();
      if (res.ok) {
        toast(done);
        after?.();
      } else toast(res.error, "risk");
    });
  return { pending, run };
}

const STATUS_FILTER = [
  { value: "DRAFT", label: "확인 필요" },
  { value: "APPROVED", label: "승인" },
  { value: "REJECTED", label: "제외" },
] as const;

export function KnowledgeManager({ cards, differences, products, canManage }: { cards: CardRow[]; differences: DifferenceRow[]; products: ProductRow[]; canManage: boolean }) {
  const needCards = cards.filter((c) => c.status === "DRAFT").length;
  const needDiffs = differences.filter((d) => d.status === "DRAFT").length;
  return (
    <Tabs defaultValue="cards">
      <TabsList>
        <TabsTrigger value="cards">상식 카드{needCards ? ` ${needCards}` : ""}</TabsTrigger>
        <TabsTrigger value="differences">우리 차이{needDiffs ? ` ${needDiffs}` : ""}</TabsTrigger>
      </TabsList>
      <TabsContent value="cards" className="mt-4">
        <CardsPanel cards={cards} canManage={canManage} />
      </TabsContent>
      <TabsContent value="differences" className="mt-4">
        <DifferencesPanel differences={differences} products={products} canManage={canManage} />
      </TabsContent>
    </Tabs>
  );
}

function CardsPanel({ cards, canManage }: { cards: CardRow[]; canManage: boolean }) {
  const [status, setStatus] = useState<CardRow["status"]>("DRAFT");
  const [adding, setAdding] = useState(false);
  const list = cards.filter((c) => c.status === status);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented ariaLabel="카드 상태" options={STATUS_FILTER.map((s) => ({ value: s.value, label: `${s.label} ${cards.filter((c) => c.status === s.value).length}` }))} value={status} onChange={(v) => setStatus(v as CardRow["status"])} />
        {canManage && (
          <Button variant="outline" size="sm" onClick={() => setAdding((v) => !v)}>
            <Plus className="size-4" />
            카드 추가
          </Button>
        )}
      </div>
      {adding && <CardForm onDone={() => setAdding(false)} />}
      {list.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-ink-2">
            {status === "DRAFT" ? "확인할 초안이 없어요. 우리 차이 탭에서 상품을 골라 AI 초안을 만들 수 있어요." : "해당하는 카드가 없어요."}
          </CardContent>
        </Card>
      )}
      {list.map((c) => (
        <CardItem key={c.id} card={c} canManage={canManage} />
      ))}
    </div>
  );
}

function CardItem({ card, canManage }: { card: CardRow; canManage: boolean }) {
  const { pending, run } = useRun();
  const [editing, setEditing] = useState(false);
  if (editing) return <CardForm card={card} onDone={() => setEditing(false)} />;
  return (
    <Card>
      <CardContent className="space-y-2 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] font-semibold">{card.topic}</span>
          <Badge variant="secondary">{kindLabel(card.product_kind)}</Badge>
          {card.origin === "AI" && <Badge variant="outline">AI 초안</Badge>}
          {card.source_checked ? <Badge variant="ok">출처 문구 확인됨</Badge> : <Badge variant="warn">출처 직접 확인 필요</Badge>}
        </div>
        <p className="text-sm text-foreground">{card.statement}</p>
        <blockquote className="border-l-2 border-border pl-3 text-xs text-ink-2">{card.source_quote}</blockquote>
        <a href={card.source_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
          {card.source_title}
          <ExternalLink className="size-3.5" />
        </a>
        {canManage && (
          <div className="flex flex-wrap gap-2 pt-1">
            {card.status !== "APPROVED" && (
              <Button size="sm" disabled={pending} onClick={() => run(() => reviewCardAction(card.id, "APPROVED"), "승인했어요.")}>
                승인
              </Button>
            )}
            <Button variant="outline" size="sm" disabled={pending} onClick={() => setEditing(true)}>
              고치기
            </Button>
            {card.status !== "REJECTED" && (
              <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => reviewCardAction(card.id, "REJECTED"), "제외했어요.")}>
                제외
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CardForm({ card, onDone }: { card?: CardRow; onDone: () => void }) {
  const { pending, run } = useRun();
  const [kind, setKind] = useState<KindValue>((card?.product_kind as KindValue) ?? "COSMETIC");
  const [topic, setTopic] = useState(card?.topic ?? "");
  const [terms, setTerms] = useState(card?.terms.join(", ") ?? "");
  const [statement, setStatement] = useState(card?.statement ?? "");
  const [sourceTitle, setSourceTitle] = useState(card?.source_title ?? "");
  const [sourceUrl, setSourceUrl] = useState(card?.source_url ?? "");
  const [sourceQuote, setSourceQuote] = useState(card?.source_quote ?? "");
  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
          <div className="space-y-1.5">
            <Label htmlFor="card-topic">주제</Label>
            <Input id="card-topic" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="예: PDRN, 카라카라" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="card-kind">상품 종류</Label>
            <select id="card-kind" value={kind} onChange={(e) => setKind(e.target.value as KindValue)} className="h-9 w-full rounded-lg border border-input bg-card px-2.5 text-sm">
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="card-terms">상품 자료에서 찾을 낱말</Label>
          <Input id="card-terms" value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="쉼표로 구분해요. 예: 소듐디엔에이, Sodium DNA" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="card-statement">영상에서 말할 사실</Label>
          <Textarea id="card-statement" value={statement} onChange={(e) => setStatement(e.target.value)} rows={2} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="card-source">출처 이름</Label>
            <Input id="card-source" value={sourceTitle} onChange={(e) => setSourceTitle(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="card-url">출처 주소</Label>
            <Input id="card-url" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://" />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="card-quote">출처의 문구</Label>
          <Textarea id="card-quote" value={sourceQuote} onChange={(e) => setSourceQuote(e.target.value)} rows={2} />
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              run(
                () =>
                  saveCardAction({
                    id: card?.id,
                    productKind: kind,
                    topic,
                    terms: terms.split(",").map((t) => t.trim()).filter(Boolean),
                    statement,
                    sourceTitle,
                    sourceUrl,
                    sourceQuote,
                  }),
                "저장하고 승인했어요.",
                onDone,
              )
            }
          >
            저장하고 승인
          </Button>
          <Button variant="ghost" size="sm" disabled={pending} onClick={onDone}>
            취소
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function DifferencesPanel({ differences, products, canManage }: { differences: DifferenceRow[]; products: ProductRow[]; canManage: boolean }) {
  const [productId, setProductId] = useState(products[0]?.id ?? "");
  const { pending, run } = useRun();
  const [adding, setAdding] = useState(false);
  const product = products.find((p) => p.id === productId);
  const list = useMemo(() => differences.filter((d) => d.product_id === productId && d.status !== "REJECTED"), [differences, productId]);
  const missing = products.filter((p) => p.upcoming && !differences.some((d) => d.product_id === p.id && d.status === "CONFIRMED")).length;

  if (!products.length) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-ink-2">다가오는 AI 자동 칸에 상품이 없어요. 상품이 정해지면 여기에 나타나요.</CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-3">
      {missing > 0 && <p className="rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-foreground">다가오는 칸의 상품 {missing}개에 확정된 차이가 없어요. 이 상품은 상식과 상품 설명까지만 영상으로 만들어요.</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="difference-product" className="shrink-0">
          상품
        </Label>
        <select id="difference-product" value={productId} onChange={(e) => { setProductId(e.target.value); setAdding(false); }} className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-card px-2.5 text-sm sm:max-w-md">
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.upcoming ? "" : "(칸 없음) "}
              {p.name} · {p.kindLabel}
            </option>
          ))}
        </select>
        {canManage && (
          <>
            <Button variant="outline" size="sm" disabled={pending || !productId} onClick={() => run(() => requestDraftAction(productId), "AI 초안 만들기를 시작했어요. 잠시 후 새로 고침해 주세요.")}>
              <Sparkles className="size-4" />
              AI 초안 만들기
            </Button>
            <Button variant="outline" size="sm" onClick={() => setAdding((v) => !v)}>
              <Plus className="size-4" />
              차이 추가
            </Button>
          </>
        )}
      </div>
      {adding && product && <DifferenceForm productId={product.id} onDone={() => setAdding(false)} />}
      {list.length === 0 && !adding && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-ink-2">이 상품에 등록된 차이가 없어요. 다른 상품과 무엇이 다른지 직접 추가하거나 AI 초안을 만들어 확인해 주세요.</CardContent>
        </Card>
      )}
      {list.map((d) => (
        <DifferenceItem key={d.id} row={d} canManage={canManage} />
      ))}
    </div>
  );
}

function DifferenceItem({ row, canManage }: { row: DifferenceRow; canManage: boolean }) {
  const { pending, run } = useRun();
  const [editing, setEditing] = useState(false);
  if (editing) return <DifferenceForm productId={row.product_id} row={row} onDone={() => setEditing(false)} />;
  return (
    <Card>
      <CardContent className="space-y-2 py-4">
        <div className="flex flex-wrap items-center gap-2">
          {row.status === "CONFIRMED" ? <Badge variant="ok">확정</Badge> : <Badge variant="warn">확인 필요</Badge>}
          {row.origin === "AI" && <Badge variant="outline">AI 초안</Badge>}
        </div>
        <p className="text-sm font-medium text-foreground">{row.difference}</p>
        <p className="text-xs text-ink-2">비교 대상: {row.compare_to}</p>
        <p className="text-xs text-ink-2">근거: {row.evidence}</p>
        {canManage && (
          <div className="flex flex-wrap gap-2 pt-1">
            {row.status !== "CONFIRMED" && (
              <Button size="sm" disabled={pending} onClick={() => run(() => reviewDifferenceAction(row.id, "CONFIRMED"), "확정했어요.")}>
                확정
              </Button>
            )}
            <Button variant="outline" size="sm" disabled={pending} onClick={() => setEditing(true)}>
              고치기
            </Button>
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => reviewDifferenceAction(row.id, "REJECTED"), "제외했어요.")}>
              제외
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DifferenceForm({ productId, row, onDone }: { productId: string; row?: DifferenceRow; onDone: () => void }) {
  const { pending, run } = useRun();
  const [difference, setDifference] = useState(row?.difference ?? "");
  const [compareTo, setCompareTo] = useState(row?.compare_to ?? "");
  const [evidence, setEvidence] = useState(row?.evidence ?? "");
  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="space-y-1.5">
          <Label htmlFor="difference-text">우리 상품의 차이</Label>
          <Textarea id="difference-text" value={difference} onChange={(e) => setDifference(e.target.value)} rows={2} placeholder="영상에서 말할 내용을 한 문장으로 써 주세요." />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="difference-compare">비교 대상</Label>
          <Input id="difference-compare" value={compareTo} onChange={(e) => setCompareTo(e.target.value)} placeholder="타사 이름 없이 써 주세요. 예: 일반적인 버블토너" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="difference-evidence">근거</Label>
          <Textarea id="difference-evidence" value={evidence} onChange={(e) => setEvidence(e.target.value)} rows={2} placeholder="상세페이지 문구, 시험 자료, 선별 기준 등" />
        </div>
        <div className="flex gap-2">
          <Button size="sm" disabled={pending} onClick={() => run(() => saveDifferenceAction({ id: row?.id, productId, difference, compareTo, evidence }), "저장하고 확정했어요.", onDone)}>
            저장하고 확정
          </Button>
          <Button variant="ghost" size="sm" disabled={pending} onClick={onDone}>
            취소
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
