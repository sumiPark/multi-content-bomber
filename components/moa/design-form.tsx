"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { copyTheme, updateTheme } from "@/app/(dashboard)/moa/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { toast } from "@/components/ui/toast";
import {
  BUTTON_STYLES,
  BUTTON_STYLE_LABEL,
  FONT_KEYS,
  FONT_LABEL,
  RADIUS_LABEL,
  RADIUS_STYLES,
  THEME_PRESETS,
  type MoaTheme,
} from "@/lib/moa/theme";
import type { MoaPageView } from "@/lib/moa/types";
import { ImageField } from "./image-field";

// 꾸미기 — 고르는 동안 오른쪽 미리보기에 바로 보이고(onDraft), "저장"을 눌러야 공개 페이지에 반영된다.

export function DesignForm({
  page,
  organizationId,
  canManage,
  otherPages,
  onDraft,
}: {
  page: MoaPageView;
  organizationId: string;
  canManage: boolean;
  otherPages: { id: string; label: string }[];
  onDraft: (t: MoaTheme | null) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [theme, setTheme] = useState<MoaTheme>(page.theme);
  const [copyFrom, setCopyFrom] = useState(otherPages[0]?.id ?? "");

  const set = (patch: Partial<MoaTheme>) => {
    const next = { ...theme, ...patch };
    setTheme(next);
    onDraft(next);
  };
  const dirty = JSON.stringify(theme) !== JSON.stringify(page.theme);

  const save = () =>
    start(async () => {
      const res = await updateTheme({ pageId: page.id, theme });
      if (!res.ok) return toast(res.error, "risk");
      toast("디자인을 저장했어요.");
      onDraft(null);
      router.refresh();
    });

  const copy = () =>
    start(async () => {
      const res = await copyTheme({ pageId: page.id, fromPageId: copyFrom });
      if (!res.ok) return toast(res.error, "risk");
      toast("디자인을 복사했어요.");
      onDraft(null);
      router.refresh();
    });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>색</CardTitle>
          <CardDescription>배경과 버튼에 쓰는 대표 색이에요. 글자색은 배경 밝기에 맞춰 자동으로 정해요.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {THEME_PRESETS.map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={() => set({ background: p.background, accent: p.accent })}
                className="flex items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-xs hover:bg-muted"
                aria-pressed={theme.background === p.background && theme.accent === p.accent}
              >
                <span className="flex size-5 overflow-hidden rounded-full border">
                  <span className="w-1/2" style={{ background: p.background }} />
                  <span className="w-1/2" style={{ background: p.accent }} />
                </span>
                {p.name}
              </button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <ColorField label="배경색" value={theme.background} onChange={(v) => set({ background: v })} />
            <ColorField label="대표 색 (버튼)" value={theme.accent} onChange={(v) => set({ accent: v })} />
          </div>
          <ImageField
            label="배경 이미지 (선택)"
            value={theme.backgroundImage}
            onChange={(v) => set({ backgroundImage: v })}
            organizationId={organizationId}
            hint="세로로 긴 이미지를 권장해요. 글자가 잘 보이도록 흐리거나 밝은 이미지를 써 주세요."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>모양 · 글꼴</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Row label="버튼">
            <Segmented ariaLabel="버튼 모양" value={theme.buttonStyle} onChange={(v) => set({ buttonStyle: v })} options={BUTTON_STYLES.map((v) => ({ value: v, label: BUTTON_STYLE_LABEL[v] }))} />
          </Row>
          <Row label="모서리">
            <Segmented ariaLabel="모서리 모양" value={theme.radius} onChange={(v) => set({ radius: v })} options={RADIUS_STYLES.map((v) => ({ value: v, label: RADIUS_LABEL[v] }))} />
          </Row>
          <Row label="글꼴">
            <Segmented ariaLabel="글꼴" value={theme.font} onChange={(v) => set({ font: v })} options={FONT_KEYS.map((v) => ({ value: v, label: FONT_LABEL[v] }))} />
          </Row>
          <p className="text-xs text-muted-foreground">프리텐다드 외 글꼴은 공개 페이지에서만 적용돼요(미리보기는 비슷한 기본 글꼴로 보여요).</p>
        </CardContent>
      </Card>

      {canManage && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {otherPages.length > 0 ? (
            <div className="flex items-center gap-2">
              <select
                value={copyFrom}
                onChange={(e) => setCopyFrom(e.target.value)}
                className="h-9 rounded-md border border-input bg-card px-2 text-sm"
                aria-label="디자인을 가져올 페이지"
              >
                {otherPages.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
              <Button variant="outline" onClick={copy} disabled={pending || !copyFrom}>
                이 페이지 디자인 가져오기
              </Button>
            </div>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            {dirty && (
              <Button
                variant="outline"
                onClick={() => {
                  setTheme(page.theme);
                  onDraft(null);
                }}
                disabled={pending}
              >
                되돌리기
              </Button>
            )}
            <Button onClick={save} disabled={pending || !dirty}>
              {pending ? "저장 중…" : "저장"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="w-14 text-sm font-medium">{label}</span>
      {children}
    </div>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">{label}</p>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={(e) => {
            setText(e.target.value.toUpperCase());
            onChange(e.target.value.toUpperCase());
          }}
          className="h-9 w-12 cursor-pointer rounded-md border border-input bg-card p-1"
          aria-label={`${label} 고르기`}
        />
        <Input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) onChange(e.target.value.toUpperCase());
          }}
          className="w-32 font-mono"
          aria-label={`${label} 값`}
        />
      </div>
    </div>
  );
}
