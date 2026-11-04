"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import {
  approveClaimAction,
  createRuleAction,
  deleteRuleAction,
  previewCheckAction,
  removeClaimAction,
  setRuleActiveAction,
  type RuleActionResult,
} from "@/app/(dashboard)/rules/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { RuleHit } from "@/lib/rules/check";
import { cn } from "@/lib/utils";

// 표현 규칙 화면의 인터랙션 — 규칙 추가 · 켜고 끄기 · 삭제, 건기식 심의 문구 확정, 미리 검사.

export const SCOPE_LABEL: Record<string, string> = {
  ALL: "전체",
  FRUIT: "과일",
  COSMETIC: "화장품",
  HEALTH_FOOD: "건기식",
  CLOTHING: "의류",
};

function useRun() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<RuleActionResult>, after?: () => void) =>
    startTransition(async () => {
      setError(null);
      const r = await fn();
      if (r.ok) {
        after?.();
        router.refresh();
      } else setError(r.error);
    });
  return { isPending, error, run };
}

// ── 규칙 ────────────────────────────────────────────────────────────────────

export interface RuleRowData {
  id: string;
  scope: string;
  ruleType: "BANNED" | "REQUIRED";
  phrase: string;
  matchType: "CONTAINS" | "REGEX";
  reason: string | null;
  suggestion: string | null;
  active: boolean;
}

export function RuleRow({ rule, canManage }: { rule: RuleRowData; canManage: boolean }) {
  const { isPending, error, run } = useRun();
  return (
    <li className={cn("flex flex-wrap items-start gap-2 px-3 py-2 text-sm", !rule.active && "opacity-50")}>
      <input
        type="checkbox"
        className="mt-1"
        checked={rule.active}
        disabled={!canManage || isPending}
        onChange={(e) => run(() => setRuleActiveAction({ id: rule.id, active: e.target.checked }))}
        aria-label="규칙 켜기"
      />
      <div className="min-w-0 flex-1">
        <p>
          <code className="rounded bg-muted px-1">{rule.phrase}</code>
          {rule.matchType === "REGEX" && <span className="ml-1 text-xs text-muted-foreground">정규식</span>}
          {rule.suggestion && <span className="ml-2 text-xs text-muted-foreground">→ {rule.suggestion}</span>}
        </p>
        {rule.reason && <p className="text-xs text-muted-foreground">{rule.reason}</p>}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
      {canManage && (
        <button
          type="button"
          disabled={isPending}
          onClick={() => {
            if (window.confirm(`“${rule.phrase}” 규칙을 지울까요? 끄기만 하려면 체크를 푸세요.`)) {
              run(() => deleteRuleAction({ id: rule.id }));
            }
          }}
          className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          aria-label="규칙 지우기"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </li>
  );
}

export function AddRuleForm() {
  const { isPending, error, run } = useRun();
  const [scope, setScope] = useState("ALL");
  const [ruleType, setRuleType] = useState<"BANNED" | "REQUIRED">("BANNED");
  const [phrase, setPhrase] = useState("");
  const [matchType, setMatchType] = useState<"CONTAINS" | "REGEX">("CONTAINS");
  const [reason, setReason] = useState("");
  const [suggestion, setSuggestion] = useState("");

  return (
    <form
      className="flex flex-wrap items-end gap-2 rounded-lg border bg-muted/20 p-3 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        run(
          () =>
            createRuleAction({
              scope: scope as "ALL",
              ruleType,
              phrase,
              matchType,
              reason: reason || null,
              suggestion: suggestion || null,
            }),
          () => {
            setPhrase("");
            setReason("");
            setSuggestion("");
          },
        );
      }}
    >
      <Labeled label="적용">
        <select value={scope} onChange={(e) => setScope(e.target.value)} className="h-8 rounded-md border bg-card px-2">
          {Object.entries(SCOPE_LABEL).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </Labeled>
      <Labeled label="종류">
        <select
          value={ruleType}
          onChange={(e) => setRuleType(e.target.value as "BANNED" | "REQUIRED")}
          className="h-8 rounded-md border bg-card px-2"
        >
          <option value="BANNED">금지 표현</option>
          <option value="REQUIRED">꼭 넣을 문구</option>
        </select>
      </Labeled>
      <Labeled label="표현" grow>
        <Input value={phrase} onChange={(e) => setPhrase(e.target.value)} className="h-8 text-xs" maxLength={200} required />
      </Labeled>
      <Labeled label="찾는 방식">
        <select
          value={matchType}
          onChange={(e) => setMatchType(e.target.value as "CONTAINS" | "REGEX")}
          className="h-8 rounded-md border bg-card px-2"
        >
          <option value="CONTAINS">글자 포함</option>
          <option value="REGEX">정규식</option>
        </select>
      </Labeled>
      <Labeled label="이유" grow>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} className="h-8 text-xs" maxLength={300} />
      </Labeled>
      <Labeled label="대신 쓸 표현">
        <Input value={suggestion} onChange={(e) => setSuggestion(e.target.value)} className="h-8 w-32 text-xs" maxLength={200} />
      </Labeled>
      <Button size="sm" disabled={isPending || !phrase.trim()}>
        <Plus className="size-4" /> 추가
      </Button>
      {error && <p className="w-full text-destructive">{error}</p>}
    </form>
  );
}

// ── 건기식 심의 문구 ────────────────────────────────────────────────────────

export interface ClaimProduct {
  id: string;
  name: string;
  shopName: string;
  candidates: string[];
  analysisConfirmed: boolean;
  approved: { id: string; claim: string; source: string }[];
}

export function ClaimProductCard({ product, canManage }: { product: ClaimProduct; canManage: boolean }) {
  const { isPending, error, run } = useRun();
  const [manual, setManual] = useState("");
  const approvedSet = new Set(product.approved.map((a) => a.claim));
  const pending = product.candidates.filter((c) => !approvedSet.has(c));

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/products/${product.id}`} className="text-sm font-medium hover:underline">
          {product.name}
        </Link>
        <span className="text-xs text-muted-foreground">{product.shopName}</span>
        {product.approved.length > 0 ? (
          <Badge variant="secondary" className="text-xs">
            확정 {product.approved.length}개
          </Badge>
        ) : (
          <Badge variant="outline" className="text-xs">
            확정 전 · AI 자동 업로드에 안 씀
          </Badge>
        )}
        {!product.analysisConfirmed && (
          <Link href={`/products/${product.id}`} className="text-xs font-medium text-warn underline underline-offset-2">
            상품 화면에서 분석 확인 필요
          </Link>
        )}
      </div>

      {product.approved.length > 0 && (
        <ul className="space-y-1 text-xs">
          {product.approved.map((a) => (
            <li key={a.id} className="flex items-start gap-2 rounded bg-ok-soft px-2 py-1">
              <Check className="mt-0.5 size-3.5 shrink-0 text-ok" />
              <span className="flex-1">{a.claim}</span>
              <span className="text-xs text-muted-foreground">{a.source === "MANUAL" ? "직접 입력" : "분석 후보"}</span>
              {canManage && (
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => run(() => removeClaimAction({ id: a.id }))}
                  className="text-muted-foreground hover:text-destructive"
                  aria-label="확정 취소"
                >
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {pending.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground">분석 후보 — 상세페이지 원문 그대로. 심의받은 문구와 같은지 확인하고 확정하세요.</p>
          <ul className="mt-1 space-y-1 text-xs">
            {pending.map((c) => (
              <li key={c} className="flex items-start gap-2 rounded border px-2 py-1">
                <span className="flex-1">{c}</span>
                {canManage && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-xs"
                    disabled={isPending}
                    onClick={() => run(() => approveClaimAction({ productId: product.id, claim: c, source: "ANALYSIS" }))}
                  >
                    확정
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {canManage && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => approveClaimAction({ productId: product.id, claim: manual, source: "MANUAL" }), () => setManual(""));
          }}
        >
          <Input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="심의받은 문구를 직접 입력"
            className="h-8 text-xs"
            maxLength={500}
          />
          <Button size="sm" variant="outline" disabled={isPending || !manual.trim()}>
            추가
          </Button>
        </form>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

// ── 미리 검사 ────────────────────────────────────────────────────────────────

export function PreviewCheck() {
  const [isPending, startTransition] = useTransition();
  const [text, setText] = useState("");
  const [kind, setKind] = useState<"FRUIT" | "COSMETIC" | "HEALTH_FOOD" | "CLOTHING">("COSMETIC");
  const [hits, setHits] = useState<RuleHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <p className="text-sm font-semibold">미리 검사</p>
      <p className="text-xs text-muted-foreground">
        캡션이나 자막을 넣으면 지금 켜진 규칙으로 검사해요. AI 자동 업로드 영상은 올리기 전에 이 검사를 자동으로 거칩니다.
      </p>
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={5000} placeholder="예: 피부 재생에 최고인 세럼" />
      <div className="flex items-center gap-2">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
          className="h-8 rounded-md border bg-card px-2 text-xs"
        >
          {Object.entries(SCOPE_LABEL)
            .filter(([v]) => v !== "ALL")
            .map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
        </select>
        <Button
          size="sm"
          disabled={isPending || !text.trim()}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const r = await previewCheckAction({ text, kind });
              if (r.ok) setHits(r.hits);
              else setError(r.error);
            })
          }
        >
          검사
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {hits &&
        (hits.length === 0 ? (
          <p className="text-xs text-ok">걸린 규칙이 없어요.</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {hits.map((h) => (
              <li key={h.rule.id} className="rounded bg-destructive/10 px-2 py-1">
                {h.rule.ruleType === "BANNED" ? (
                  <>
                    금지 표현 <b>{h.matched}</b>
                    {h.rule.suggestion && ` → ${h.rule.suggestion}`}
                  </>
                ) : (
                  <>
                    꼭 넣을 문구 <b>{h.rule.phrase}</b> 빠짐
                  </>
                )}
                {h.rule.reason && <span className="text-muted-foreground"> — {h.rule.reason}</span>}
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

function Labeled({ label, children, grow }: { label: string; children: React.ReactNode; grow?: boolean }) {
  return (
    <label className={cn("flex flex-col gap-1", grow && "min-w-[10rem] flex-1")}>
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
