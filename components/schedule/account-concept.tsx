"use client";

import { VOICE_CHOICES } from "@/lib/shoot/voices";
import { useState } from "react";
import { Save } from "lucide-react";
import { saveAutoConceptAction, saveShootConceptAction } from "@/app/(dashboard)/schedule/actions";
import { useScheduleRun } from "@/components/schedule/slot-rule-cell";
import { Button } from "@/components/ui/button";
import { RelativeTime } from "@/components/ui/relative-time";
import { Textarea } from "@/components/ui/textarea";

// 영상 만들 때 참고할 내용 — AI 자동(자동 콘텐츠 설정)과 직접 촬영(촬영 설정)은 서로 섞이지 않는다.
// 각 화면은 자기 값만 읽고 저장하고, 각 생성 과정도 자기 값만 읽는다(0038 · 0039 · 0043). 쓸 상품만 함께 쓴다.
// 문구는 {상품}처럼 중괄호 안만 AI가 채우고 나머지 글자는 고정된다. 편집 스타일은 저장할 때 AI가 편집 값으로 옮기고 결과를 여기 보여 준다.

export interface ConceptCardData {
  accountId: string;
  name: string;
  autoRole: string;
  autoConcept: string;
  autoHooks: string;
  autoEndings: string;
  autoTone: string;
  autoVideoStyle: string;
  // 목소리 — 방식별로 따로. 빈 값은 기본 목소리
  autoVoiceId: string;
  shootVoiceId: string;
  shootRole: string;
  // AI = AI 음성(기본), LIVE = 찍을 때 말한 소리
  shootVoice: string;
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

type Role = "" | "PRODUCT" | "PERSON";
type AutoKey = "autoRole" | "autoConcept" | "autoHooks" | "autoEndings" | "autoTone" | "autoVideoStyle" | "autoVoiceId";
type ShootKey = "shootRole" | "shootVoice" | "shootVoiceId" | "shootConcept" | "shootHooks" | "shootEndings" | "shootTone" | "shootEditStyle";
const AUTO_KEYS: AutoKey[] = ["autoRole", "autoConcept", "autoHooks", "autoEndings", "autoTone", "autoVideoStyle", "autoVoiceId"];
const SHOOT_KEYS: ShootKey[] = ["shootRole", "shootVoice", "shootVoiceId", "shootConcept", "shootHooks", "shootEndings", "shootTone", "shootEditStyle"];

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
        <span className="text-sm font-semibold text-ink-2">{label}</span>
        <span className="text-xs tabular-nums text-faint">
          {value.length.toLocaleString("ko-KR")} / {max.toLocaleString("ko-KR")}
        </span>
      </span>
      {/* 예시가 저장된 값처럼 보이지 않게 "예시:"를 붙이고 글자를 더 연하게 한다 */}
      <Textarea value={value} onChange={(e) => onChange(e.target.value)} rows={rows} maxLength={max} placeholder={`예시: ${placeholder}`} disabled={disabled} className="bg-card text-sm leading-relaxed placeholder:text-faint" />
      <span className="block text-xs text-muted-foreground">{help}</span>
    </label>
  );
}

function VoiceField({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled: boolean }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-semibold text-ink-2">음성</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="block h-9 w-full rounded-md border border-input bg-card px-2.5 text-sm focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-60"
      >
        <option value="AI">AI 음성</option>
        <option value="LIVE">찍을 때 말한 소리</option>
      </select>
      <span className="block text-xs text-muted-foreground">AI 음성은 찍을 때 말하지 않아도 돼요. 찍은 소리를 빼고 AI가 읽어요. 찍을 때 말한 소리를 고르면 컷 목록에 말할 대사가 들어가요.</span>
    </label>
  );
}

function VoicePickField({ value, help, onChange, disabled }: { value: string; help: string; onChange: (v: string) => void; disabled: boolean }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-semibold text-ink-2">AI 목소리</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="block h-9 w-full rounded-md border border-input bg-card px-2.5 text-sm focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-60"
      >
        <option value="">기본 목소리</option>
        {VOICE_CHOICES.map((v) => (
          <option key={v.id} value={v.id}>
            {v.title}
          </option>
        ))}
      </select>
      <span className="block text-xs text-muted-foreground">{help}</span>
    </label>
  );
}

function RoleField({ value, help, onChange, disabled }: { value: string; help: string; onChange: (v: string) => void; disabled: boolean }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-semibold text-ink-2">영상 방향</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="block h-9 w-full rounded-md border border-input bg-card px-2.5 text-sm focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-60"
      >
        <option value="">정하지 않음</option>
        <option value="PRODUCT">상품 중심</option>
        <option value="PERSON">사람 중심</option>
      </select>
      <span className="block text-xs text-muted-foreground">{help}</span>
    </label>
  );
}

const PHRASE_HELP = "한 줄에 문구 하나, 10개까지. {상품}처럼 중괄호 안은 AI가 채우고 나머지 글자는 그대로 나가요. 음성과 화면 문구에 똑같이 들어가요.";

export function AccountConceptCard({ data, canManage, mode, top, hideName }: { data: ConceptCardData; canManage: boolean; mode: "auto" | "shoot"; top?: React.ReactNode; hideName?: boolean }) {
  const { isPending, error, run } = useScheduleRun();
  const keys: (AutoKey | ShootKey)[] = mode === "auto" ? AUTO_KEYS : SHOOT_KEYS;
  const [form, setForm] = useState<Record<string, string>>(() => Object.fromEntries(keys.map((k) => [k, data[k]])));
  const bind = (key: AutoKey | ShootKey) => ({ value: form[key], onChange: (v: string) => setForm((f) => ({ ...f, [key]: v })), disabled: !canManage || isPending });
  const dirty = keys.some((k) => form[k] !== data[k]);
  const editDirty = mode === "shoot" && form.shootEditStyle !== data.shootEditStyle;

  const save = () =>
    run(() =>
      mode === "auto"
        ? saveAutoConceptAction({
            accountId: data.accountId,
            autoRole: form.autoRole as Role,
            autoConcept: form.autoConcept,
            autoHooks: form.autoHooks,
            autoEndings: form.autoEndings,
            autoTone: form.autoTone,
            autoVideoStyle: form.autoVideoStyle,
            autoVoiceId: form.autoVoiceId,
          })
        : saveShootConceptAction({
            accountId: data.accountId,
            shootRole: form.shootRole as Role,
            shootVoice: form.shootVoice as "AI" | "LIVE",
            shootConcept: form.shootConcept,
            shootHooks: form.shootHooks,
            shootEndings: form.shootEndings,
            shootTone: form.shootTone,
            shootEditStyle: form.shootEditStyle,
            shootVoiceId: form.shootVoiceId,
          }),
    );

  return (
    <section className="space-y-4 rounded-lg border bg-card p-4" aria-label={`@${data.name} ${mode === "auto" ? "자동 콘텐츠" : "직접 촬영"} 설정`}>
      {!hideName && <h3 className="text-[15px] font-semibold">@{data.name}</h3>}
      {top}

      {mode === "auto" ? (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <RoleField {...bind("autoRole")} help="AI가 만드는 영상의 장면과 말투 방향이에요. 직접 촬영과는 따로 정해요." />
            <VoicePickField {...bind("autoVoiceId")} help="AI 자동 콘텐츠의 내레이션 목소리예요. 직접 촬영과는 따로 정해요." />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Field {...bind("autoHooks")} label="후킹 문구" rows={3} max={2000} help={PHRASE_HELP} placeholder={"{상품} 고를 때 이것만 보세요\n이거 모르고 사면 손해예요"} />
            <Field {...bind("autoEndings")} label="마지막 문구" rows={3} max={2000} help="영상 끝에 나가요. 빈칸 쓰는 법은 후킹 문구와 같아요." placeholder={"저장해 두고 살 때 꺼내 보세요"} />
            <Field {...bind("autoTone")} label="말투 · 분위기" help="내레이션 · 캡션과 자막 디자인 · 음악 분위기에 반영돼요." placeholder={"친구에게 알려 주듯 편한 존댓말, 짧게 끊어서."} />
            <Field
              {...bind("autoVideoStyle")}
              label="영상 생성 스타일"
              help="대본의 장면 설명, 소재 선택, 자막 디자인, 음악에 반영돼요."
              placeholder={"밝은 자연광, 나무 식탁 위 클로즈업, 카메라는 천천히. 사람 얼굴은 나오지 않게."}
            />
            <Field {...bind("autoConcept")} label="컨셉 · 자유 메모" help="상품을 고르고 대본을 쓸 때 AI가 참고해요." placeholder={"20대 후반 직장인이 보는 계정. 가격보다 맛 표현 위주로."} />
          </div>
        </>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <RoleField {...bind("shootRole")} help="어떤 장면으로 찍을지예요. 사람 중심은 사람이 나오는 컷, 상품 중심은 손 · 제품 위주로 기획해요." />
            <VoiceField {...bind("shootVoice")} />
            {form.shootVoice === "LIVE" ? (
              <p className="self-center rounded-md border px-3 py-2 text-xs text-muted-foreground">찍을 때 말한 소리를 쓰는 동안에는 AI 목소리를 쓰지 않아요.</p>
            ) : (
              <VoicePickField {...bind("shootVoiceId")} help="직접 촬영 영상의 내레이션 목소리예요. AI 자동 콘텐츠와는 따로 정해요." />
            )}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Field {...bind("shootHooks")} label="후킹 문구" rows={3} max={2000} help={PHRASE_HELP} placeholder={"{상품} 잘라 보면 이래요\n사장이 직접 고른 {상품}"} />
            <Field {...bind("shootEndings")} label="마지막 문구" rows={3} max={2000} help="마지막 컷에 나가요. 빈칸 쓰는 법은 후킹 문구와 같아요." placeholder={"궁금한 거 댓글로 물어보세요"} />
            <Field {...bind("shootTone")} label="말투 · 분위기" help="기획 초안 · 대사 · 화면 문구 · 캡션에 반영돼요." placeholder={"사장이 직접 말하듯 담백하게."} />
            <div className="space-y-2">
              <Field
                {...bind("shootEditStyle")}
                label="편집 스타일"
                help="컷 리스트에 반영하고, AI가 컷 속도 · 자막 디자인 · 음악을 정할 때 읽어요. 영상 색은 아래 값으로 들어가요."
                placeholder={"컷은 빠르게, 화면 문구는 가운데에 크고 노랗게, 색은 따뜻하게."}
              />
              {!editDirty && data.shootEditStyle.trim() && (
                <div className="space-y-1 rounded-md border px-3 py-2 text-xs">
                  <p>
                    <span className="font-semibold">영상 색과 기본 편집에 들어가는 값: </span>
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
            </div>
            <Field {...bind("shootConcept")} label="컨셉 · 자유 메모" help="기획 목록과 컷 리스트를 쓸 때 AI가 참고해요." placeholder={"사장이 직접 과일을 잘라 보여 주는 계정. 손과 단면 위주로."} />
          </div>
        </>
      )}

      <footer className="flex flex-wrap items-center gap-3">
        {canManage && (
          <Button size="sm" disabled={isPending || !dirty} onClick={save}>
            <Save className="size-4" /> {isPending && editDirty ? "편집 스타일 반영 중…" : "저장"}
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
