"use client";

import Link from "next/link";
import { useState } from "react";
import { Save } from "lucide-react";
import { saveConceptAction } from "@/app/(dashboard)/schedule/actions";
import { TrackBadge, useScheduleRun } from "@/components/schedule/slot-rule-cell";
import { Button } from "@/components/ui/button";
import { RelativeTime } from "@/components/ui/relative-time";
import { Textarea } from "@/components/ui/textarea";

// 계정 컨셉 — 계정마다 AI 자동 업로드(자동 업로드 일정 탭)와 직접 촬영(촬영 설정 화면)의
// 후킹 문구 · 마지막 문구 · 말투 · 스타일 · 자유 메모를 각각의 화면에서 저장한다(0038 · 0039). 값은 한 행에 함께 저장된다.
// 문구는 {상품}처럼 중괄호 안만 AI가 채우고 나머지 글자는 고정된다. 편집 스타일은 저장할 때 AI가 편집 값으로 옮기고 결과를 여기 보여 준다.

export interface ConceptCardData {
  accountId: string;
  name: string;
  role: string | null;
  autoSlots: number;
  autoConcept: string;
  autoHooks: string;
  autoEndings: string;
  autoTone: string;
  autoVideoStyle: string;
  shootConcept: string;
  shootHooks: string;
  shootEndings: string;
  shootTone: string;
  shootEditStyle: string;
  // 지금 편집에 들어가는 값(기본과 다른 것만) · 따르지 못하는 요청
  editApplied: string[];
  editUnsupported: string[];
  updatedAt: string | null;
}

type FormKey = "autoConcept" | "autoHooks" | "autoEndings" | "autoTone" | "autoVideoStyle" | "shootConcept" | "shootHooks" | "shootEndings" | "shootTone" | "shootEditStyle";
const FORM_KEYS: FormKey[] = ["autoConcept", "autoHooks", "autoEndings", "autoTone", "autoVideoStyle", "shootConcept", "shootHooks", "shootEndings", "shootTone", "shootEditStyle"];

function Field({
  label,
  help,
  placeholder,
  value,
  rows = 2,
  max = 1000,
  onChange,
  disabled,
}: {
  label: string;
  help: string;
  placeholder: string;
  value: string;
  rows?: number;
  max?: number;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <label className="block space-y-1">
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-semibold text-ink-2">{label}</span>
        <span className="text-xs tabular-nums text-faint">
          {value.length.toLocaleString("ko-KR")} / {max.toLocaleString("ko-KR")}
        </span>
      </span>
      <Textarea value={value} onChange={(e) => onChange(e.target.value)} rows={rows} maxLength={max} placeholder={placeholder} disabled={disabled} className="bg-card text-[13px] leading-relaxed" />
      <span className="block text-xs text-muted-foreground">{help}</span>
    </label>
  );
}

const PHRASE_HELP = "한 줄에 문구 하나, 10개까지. {상품}처럼 중괄호 안은 AI가 채우고 나머지 글자는 그대로 나가요. 말과 화면 문구에 똑같이 들어가요.";

export function AccountConceptCard({ data, canManage, mode, top, hideName }: { data: ConceptCardData; canManage: boolean; mode: "auto" | "shoot"; top?: React.ReactNode; hideName?: boolean }) {
  const { isPending, error, run } = useScheduleRun();
  const [form, setForm] = useState<Record<FormKey, string>>(() => Object.fromEntries(FORM_KEYS.map((k) => [k, data[k]])) as Record<FormKey, string>);
  const bind = (key: FormKey) => ({ value: form[key], onChange: (v: string) => setForm((f) => ({ ...f, [key]: v })), disabled: !canManage || isPending });
  const dirty = FORM_KEYS.some((k) => form[k] !== data[k]);
  const editDirty = form.shootEditStyle !== data.shootEditStyle;

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4" aria-label={`@${data.name} 컨셉`}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {!hideName && <h3 className="text-[15px] font-semibold">@{data.name}</h3>}
        <span className="text-xs text-muted-foreground">
          계정 역할 {data.role ?? "미정"} ·{" "}
          <Link href="/accounts" className="underline underline-offset-2">
            계정 연동에서 바꾸기
          </Link>
        </span>
      </header>
      {top}

      {mode === "auto" ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <p className="flex items-center gap-2 lg:col-span-2">
            <TrackBadge track="B" />
            <span className="text-xs text-muted-foreground">{data.autoSlots > 0 ? `하루 ${data.autoSlots}칸` : "지금 칸 없음"}</span>
          </p>
          <Field {...bind("autoHooks")} label="후킹 문구" rows={3} max={2000} help={PHRASE_HELP} placeholder={"{상품} 고를 때 이것만 보세요\n이거 모르고 사면 손해예요"} />
          <Field {...bind("autoEndings")} label="마지막 문구" rows={2} max={2000} help="영상 끝에 나가요. 빈칸 쓰는 법은 후킹 문구와 같아요." placeholder={"저장해 두고 살 때 꺼내 보세요"} />
          <Field {...bind("autoTone")} label="말투 · 분위기" help="내레이션과 캡션에 반영돼요." placeholder={"친구에게 알려 주듯 편한 존댓말, 짧게 끊어서."} />
          <Field
            {...bind("autoVideoStyle")}
            label="영상 생성 스타일"
            help="지금은 대본의 장면 설명에 반영돼요. 영상 자동 생성을 붙이면 모든 영상을 이 지시대로 만들어요."
            placeholder={"밝은 자연광, 나무 식탁 위 클로즈업, 카메라는 천천히. 사람 얼굴은 나오지 않게."}
          />
          <Field {...bind("autoConcept")} label="컨셉 · 자유 메모" help="상품을 고르고 대본을 쓸 때 AI가 읽어요." placeholder={"20대 후반 직장인이 보는 계정. 가격보다 맛 표현 위주로."} />
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Field {...bind("shootHooks")} label="후킹 문구" rows={3} max={2000} help={PHRASE_HELP + " 말하지 않는 계정은 화면 문구에만 들어가요."} placeholder={"{상품} 잘라 보면 이래요\n사장이 직접 고른 {상품}"} />
          <Field {...bind("shootEndings")} label="마지막 문구" rows={2} max={2000} help="마지막 컷에 나가요. 빈칸 쓰는 법은 후킹 문구와 같아요." placeholder={"궁금한 거 댓글로 물어보세요"} />
          <Field {...bind("shootTone")} label="말투 · 분위기" help="대사 · 화면 문구 · 캡션에 반영돼요." placeholder={"사장이 직접 말하듯 담백하게."} />
          <Field
            {...bind("shootEditStyle")}
            label="편집 스타일"
            help="컷 리스트에 반영하고, 저장할 때 AI가 편집 값으로 옮겨요. 컷 길이 · 화면 문구 위치 · 크기 · 색 · 띠 · 말 자막 · 영상 색을 바꿀 수 있어요."
            placeholder={"컷은 빠르게, 화면 문구는 가운데에 크고 노랗게, 색은 따뜻하게."}
          />
          {!editDirty && data.shootEditStyle.trim() && (
            <div className="space-y-1 rounded-md border bg-card px-3 py-2 text-xs">
              <p>
                <span className="font-semibold">지금 편집에 들어가는 값: </span>
                {data.editApplied.length ? data.editApplied.join(" · ") : "기본 편집과 같아요"}
              </p>
              {data.editUnsupported.length > 0 && (
                <p className="text-warn">
                  <span className="font-semibold">아직 따르지 못하는 것: </span>
                  {data.editUnsupported.join(" · ")}
                </p>
              )}
            </div>
          )}
          <Field {...bind("shootConcept")} label="컨셉 · 자유 메모" help="기획 목록과 컷 리스트를 쓸 때 AI가 읽어요." placeholder={"사장이 직접 과일을 잘라 보여 주는 계정. 손과 단면 위주로."} />
        </div>
      )}

      <footer className="flex flex-wrap items-center gap-3">
        {canManage && (
          <Button size="sm" disabled={isPending || !dirty} onClick={() => run(() => saveConceptAction({ accountId: data.accountId, ...form }))}>
            <Save className="size-4" /> {isPending && editDirty ? "편집 스타일 읽는 중…" : "저장"}
          </Button>
        )}
        {data.updatedAt && (
          <span className="text-xs text-muted-foreground">
            <RelativeTime iso={data.updatedAt} /> 저장
          </span>
        )}
        {error && <p className="text-xs text-risk">{error}</p>}
      </footer>
    </section>
  );
}
