"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { AlertCircle, Loader2, Pencil, RefreshCw } from "lucide-react";
import { rebuildCardAction, saveCardAction } from "@/app/(dashboard)/style-shorts/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { RelativeTime } from "@/components/ui/relative-time";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { CAPTION_POSITIONS, CAPTION_SIZES, FONT_KINDS, FONT_WEIGHTS, type CaptionLook } from "@/lib/style-shorts/caption-look";
import { CARD_SECTIONS, CARD_STATUS, CARD_TEXT_MAX, sfxKindLabel, type CardEdit, type StyleCard } from "@/lib/style-shorts/card";

// 스타일 카드 — 보기 · 글 고치기 · 지금 레퍼런스로 다시 만들기. 숫자는 레퍼런스에서 잰 값이라 고치지 않는다.

const CAPTION_LABEL = { sentence: "문장 자막", keyword: "낱말 자막", none: "자막 없음", mixed: "레퍼런스마다 다름" } as const;

function editOf(card: StyleCard): CardEdit {
  return { summary: card.summary, sections: { ...card.sections }, music: { ...card.music }, captionLook: card.captionLook ? { ...card.captionLook } : null };
}

function Swatch({ color, label }: { color: string; label: string }) {
  if (!color) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-ink-2">
      <span className="inline-block size-4 rounded border" style={{ backgroundColor: color }} aria-hidden />
      {label} {color}
    </span>
  );
}

/** 레퍼런스 자막 모양 고치기 — 색은 색 고르기, 테두리 · 상자는 없음도 고를 수 있다. */
function CaptionLookFields({ value, onChange }: { value: CaptionLook; onChange: (v: CaptionLook) => void }) {
  const select = <K extends keyof CaptionLook>(key: K, options: readonly string[], label: string) => (
    <label className="block space-y-1">
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      <select value={String(value[key])} onChange={(e) => onChange({ ...value, [key]: e.target.value })} className="h-9 w-full rounded-md border border-input bg-card px-3 text-sm">
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
  const color = (key: "text_color" | "accent_color" | "outline_color" | "box_color", label: string, optional: boolean) => (
    <div className="space-y-1">
      <span className="block text-xs font-semibold text-muted-foreground">{label}</span>
      <div className="flex h-9 items-center gap-2">
        {(!optional || value[key]) && (
          <input type="color" value={value[key] || "#000000"} onChange={(e) => onChange({ ...value, [key]: e.target.value.toUpperCase() })} className="h-9 w-12 cursor-pointer rounded border border-input bg-card" aria-label={label} />
        )}
        {optional && (
          <label className="inline-flex items-center gap-1 text-xs text-ink-2">
            <input type="checkbox" checked={!value[key]} onChange={(e) => onChange({ ...value, [key]: e.target.checked ? "" : "#000000" })} />
            없음
          </label>
        )}
      </div>
    </div>
  );
  return (
    <fieldset className="space-y-3 rounded-lg border p-3">
      <legend className="px-1 text-xs font-semibold text-muted-foreground">자막 모양</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {select("font", FONT_KINDS, "글꼴 계열")}
        {select("weight", FONT_WEIGHTS, "굵기")}
        {select("position", CAPTION_POSITIONS, "자리")}
        {select("size", CAPTION_SIZES, "크기")}
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        {color("text_color", "글자색", false)}
        {color("accent_color", "강조색", false)}
        {color("outline_color", "테두리", true)}
        {color("box_color", "상자", true)}
      </div>
      <label className="inline-flex items-center gap-2 text-sm">
        <input type="checkbox" checked={value.shadow} onChange={(e) => onChange({ ...value, shadow: e.target.checked })} />
        그림자
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-semibold text-muted-foreground">움직임</span>
        <Input value={value.motion} maxLength={60} onChange={(e) => onChange({ ...value, motion: e.target.value })} />
      </label>
    </fieldset>
  );
}

export function StyleCardPanel({
  folderId,
  card,
  status,
  error,
  edited,
  stale,
  hasRefs,
  updatedAt,
}: {
  folderId: string;
  card: StyleCard | null;
  status: string;
  error: string | null;
  edited: boolean;
  stale: boolean;
  hasRefs: boolean;
  updatedAt: string | null;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<CardEdit | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [pending, start] = useTransition();
  const s = CARD_STATUS[status] ?? { label: status, variant: "secondary" as const };
  const working = status === "PENDING" || status === "ANALYZING";

  const rebuild = () =>
    start(async () => {
      const res = await rebuildCardAction({ id: folderId });
      setConfirm(false);
      if (!res.ok) return toast(res.error, "risk");
      toast(res.warning ?? "카드를 다시 만들어요", res.warning ? "risk" : "ok");
      setDraft(null);
      router.refresh();
    });

  const save = () =>
    start(async () => {
      if (!draft) return;
      const res = await saveCardAction({ folderId, edit: draft });
      if (!res.ok) return setFormError(res.error);
      setFormError(null);
      setDraft(null);
      toast("카드를 저장했어요");
      router.refresh();
    });

  const n = card?.numbers;
  const numbers = n
    ? [
        n.durationSec && `길이 ${n.durationSec[0]}~${n.durationSec[1]}초`,
        n.avgShotSec != null && `평균 컷 ${n.avgShotSec}초`,
        n.cutsPer10s != null && `10초당 컷 ${n.cutsPer10s}개`,
        n.sfxPer10s != null && `효과음 10초당 ${n.sfxPer10s}개`,
        n.tempo != null && `음악 ${n.tempo}BPM`,
        CAPTION_LABEL[n.captionStyle],
      ].filter((x): x is string => !!x)
    : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          스타일 카드
          <Badge variant={s.variant}>
            {working && <Loader2 className="animate-spin" aria-hidden />}
            {s.label}
          </Badge>
          {edited && <Badge variant="outline">직접 고침</Badge>}
        </CardTitle>
        <CardDescription>
          {card ? (
            <>
              레퍼런스 {n?.references}개(영상까지 분석 {n?.videoReferences}개)로 만들었어요{updatedAt && <> · <RelativeTime iso={updatedAt} /></>}. 편집할 때 AI가 이 카드를 꼭 따라요.
            </>
          ) : (
            "레퍼런스 분석이 끝나면 공통 스타일을 카드로 정리해요."
          )}
        </CardDescription>
        {card && !draft && (
          <CardAction className="flex gap-2">
            <Button variant="outline" size="sm" disabled={working} onClick={() => setDraft(editOf(card))}>
              <Pencil className="size-4" aria-hidden />
              고치기
            </Button>
            <Button variant="outline" size="sm" disabled={working || pending || !hasRefs} onClick={() => (edited ? setConfirm(true) : rebuild())}>
              <RefreshCw className="size-4" aria-hidden />
              다시 만들기
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {status === "FAILED" && error && (
          <div className="flex items-start gap-2 rounded-md bg-risk-soft p-3 text-sm text-risk">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div className="space-y-2">
              <p>{error}</p>
              {hasRefs && (
                <Button size="sm" variant="outline" disabled={pending} onClick={rebuild}>
                  다시 만들기
                </Button>
              )}
            </div>
          </div>
        )}
        {stale && edited && !working && (
          <div className="rounded-md border border-warn/40 bg-warn-soft p-3 text-sm text-ink-2">
            카드를 고친 뒤 레퍼런스가 바뀌었어요. 고친 내용을 지키려고 자동으로 다시 만들지 않았어요. 새 레퍼런스를 반영하려면 다시 만들기를 눌러 주세요.
          </div>
        )}

        {!card && !working && status !== "FAILED" && <p className="text-sm text-muted-foreground">아직 카드가 없어요. 왼쪽에 레퍼런스를 넣어 주세요.</p>}
        {!card && working && <p className="text-sm text-muted-foreground">레퍼런스를 분석하고 있어요. 하나에 1~3분 걸려요. 이 화면은 자동으로 새로 고쳐져요.</p>}

        {card && !draft && (
          <>
            <p className="text-base font-semibold">{card.summary}</p>
            {numbers.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {numbers.map((x) => (
                  <Badge key={x} variant="secondary" className="tabular-nums">
                    {x}
                  </Badge>
                ))}
                {n?.sfxKinds.slice(0, 4).map((k) => (
                  <Badge key={k.kind} variant="outline" className="tabular-nums">
                    {sfxKindLabel(k.kind)} {Math.round(k.share * 100)}%
                  </Badge>
                ))}
              </div>
            )}
            <dl className="divide-y rounded-lg border">
              {CARD_SECTIONS.map((sec) => (
                <div key={sec.key} className="grid gap-1 p-3 sm:grid-cols-[120px_1fr] sm:gap-3">
                  <dt className="text-xs font-semibold text-muted-foreground">{sec.title}</dt>
                  <dd className="whitespace-pre-line text-sm text-ink-2">{card.sections[sec.key] || "-"}</dd>
                </div>
              ))}
              <div className="grid gap-1 p-3 sm:grid-cols-[120px_1fr] sm:gap-3">
                <dt className="text-xs font-semibold text-muted-foreground">자막 모양</dt>
                <dd className="space-y-1.5 text-sm text-ink-2">
                  {card.captionLook ? (
                    <>
                      <p>
                        {card.captionLook.font} · {card.captionLook.weight} · {card.captionLook.position} · {card.captionLook.size}
                        {card.captionLook.shadow && " · 그림자"}
                        {card.captionLook.motion && ` · ${card.captionLook.motion}`}
                      </p>
                      <p className="flex flex-wrap gap-3">
                        <Swatch color={card.captionLook.text_color} label="글자" />
                        <Swatch color={card.captionLook.accent_color} label="강조" />
                        <Swatch color={card.captionLook.outline_color} label="테두리" />
                        <Swatch color={card.captionLook.box_color} label="상자" />
                      </p>
                    </>
                  ) : (
                    <span className="text-muted-foreground">이 카드는 자막 모양을 읽기 전에 만들었어요. 다시 만들기를 누르면 레퍼런스를 다시 분석해 채워요.</span>
                  )}
                </dd>
              </div>
              <div className="grid gap-1 p-3 sm:grid-cols-[120px_1fr] sm:gap-3">
                <dt className="text-xs font-semibold text-muted-foreground">배경음악 찾기</dt>
                <dd className="text-sm text-ink-2">
                  {card.music.mood} <span className="text-muted-foreground">· 검색어 “{card.music.query}”</span>
                </dd>
              </div>
            </dl>
          </>
        )}

        {draft && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <label className="block space-y-1">
              <span className="text-xs font-semibold text-muted-foreground">한 줄 요약</span>
              <Input value={draft.summary} maxLength={80} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} />
            </label>
            {CARD_SECTIONS.map((sec) => (
              <label key={sec.key} className="block space-y-1">
                <span className="text-xs font-semibold text-muted-foreground">{sec.title}</span>
                <Textarea
                  value={draft.sections[sec.key]}
                  maxLength={CARD_TEXT_MAX * 2}
                  rows={sec.key === "rules" ? 6 : 3}
                  onChange={(e) => setDraft({ ...draft, sections: { ...draft.sections, [sec.key]: e.target.value } })}
                />
              </label>
            ))}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="text-xs font-semibold text-muted-foreground">배경음악 분위기</span>
                <Input value={draft.music.mood} maxLength={80} onChange={(e) => setDraft({ ...draft, music: { ...draft.music, mood: e.target.value } })} />
              </label>
              <label className="block space-y-1">
                <span className="text-xs font-semibold text-muted-foreground">배경음악 검색어 (영어)</span>
                <Input value={draft.music.query} maxLength={80} onChange={(e) => setDraft({ ...draft, music: { ...draft.music, query: e.target.value } })} />
              </label>
            </div>
            {draft.captionLook && <CaptionLookFields value={draft.captionLook} onChange={(captionLook) => setDraft({ ...draft, captionLook })} />}
            {formError && <p className="text-xs text-risk">{formError}</p>}
            <div className="flex gap-2">
              <Button type="submit" disabled={pending}>
                저장
              </Button>
              <Button type="button" variant="outline" disabled={pending} onClick={() => setDraft(null)}>
                취소
              </Button>
            </div>
          </form>
        )}
      </CardContent>
      <ConfirmDialog open={confirm} title="카드를 다시 만들까요?" confirmLabel="다시 만들기" pending={pending} onConfirm={rebuild} onClose={() => setConfirm(false)}>
        지금 레퍼런스로 카드를 새로 만들어요. 직접 고친 내용은 사라져요.
      </ConfirmDialog>
    </Card>
  );
}
