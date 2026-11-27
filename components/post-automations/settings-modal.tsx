"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Bookmark,
  BookmarkPlus,
  ListOrdered,
  MessageSquare,
  MessagesSquare,
  MousePointerClick,
  Plus,
  Send,
  SlidersHorizontal,
  Tag,
  Trash2,
  TriangleAlert,
  Type,
} from "lucide-react";
import {
  saveAutomation,
  saveAutomationTemplate,
  type RecentPost,
  type SaveAutomationInput,
} from "@/app/(dashboard)/post-automations/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PlatformIcon } from "@/components/ui/platform-icon";
import { Segmented } from "@/components/ui/segmented";
import { toast } from "@/components/ui/toast";
import {
  BUTTON_LABEL_MAX,
  BUTTON_TEXT_MAX_CHARS,
  DM_TEXT_MAX_BYTES,
  FIRST_ALL,
  FIRST_KEYWORD,
  MAX_BUTTONS,
  MAX_KEYWORDS,
  MAX_REPLIES,
  PERIOD_PRESETS,
  QUICK_LABEL_MAX,
  applyPreset,
  charCount,
  defaultConfig,
  effectiveReplyWhen,
  isTriggerRelevant,
  renderText,
  utf8Bytes,
  validateConfig,
  withUtm,
  type AutomationConfig,
  type ConfigErrorKey,
  type ConfigErrors,
  type DmFormat,
  type LinkTarget,
  type Preset,
} from "@/lib/post-automations/config";
import { cn } from "@/lib/utils";
import { FieldError, FieldLabel, Hint, ProductField, Section, TagInput, TextField, selectClass } from "./settings-fields";
import { SettingsPreview } from "./settings-preview";
import { DAY_MS, DialogHeader, DialogShell, captionTitle, monthDay, triggerText } from "./shared";
import type { AutomationView, ProductView, TemplateView } from "./types";

// 설정 창 — 왼쪽 폼 · 오른쪽 미리보기 · 아래 한 줄 요약. 시안 9 renderModal 구조.

export type SettingsTarget =
  | { mode: "new"; post: RecentPost; product: ProductView | null }
  | { mode: "edit"; automation: AutomationView; product: ProductView | null };

type SectionKey = "first" | "trig" | "dm" | "reply" | "period";

const PRESETS: Array<{ key: Preset; Icon: typeof Send; title: string; desc: string }> = [
  { key: "link", Icon: Send, title: "상품 링크 보내기", desc: "키워드 댓글 → DM → 답글" },
  { key: "comment", Icon: MessageSquare, title: "안내 댓글만", desc: "올린 직후 첫 댓글 하나" },
  { key: "custom", Icon: SlidersHorizontal, title: "직접 설정", desc: "하나씩 켜고 정하기" },
];

const FORMATS: Array<{ key: DmFormat; Icon: typeof Send; title: string; desc: string }> = [
  { key: "button", Icon: MousePointerClick, title: "버튼 메시지", desc: "글 + 링크 버튼 1~3개" },
  { key: "twostep", Icon: ListOrdered, title: "두 단계로 보내기", desc: "버튼을 누르면 링크 보내기" },
  { key: "text", Icon: Type, title: "글자만", desc: "PC 인스타에서도 똑같이" },
];

const LINK_OPTIONS: Array<[LinkTarget, string]> = [
  ["product", "상품 페이지"],
  ["home", "몰 첫 화면"],
  ["custom", "직접 입력"],
];

export function SettingsModal({
  target,
  accountId,
  accountName,
  templates,
  onClose,
  onSaved,
}: {
  target: SettingsTarget;
  accountId: string;
  accountName: string | null;
  templates: TemplateView[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const router = useRouter();
  const isEdit = target.mode === "edit";
  const automation = isEdit ? target.automation : null;
  const waiting = automation?.status === "WAITING";

  const [cfg, setCfg] = useState<AutomationConfig>(() =>
    target.mode === "edit" ? structuredClone(target.automation.config) : defaultConfig("INSTAGRAM", { hasProduct: !!target.product }),
  );
  const [product, setProduct] = useState<ProductView | null>(target.product);
  const [open, setOpen] = useState<Set<SectionKey>>(() => new Set(cfg.preset === "custom" ? ["first"] : []));
  const [errors, setErrors] = useState<ConfigErrors>({});
  // 모달이 떠 있는 동안 토스트는 모달 뒤에 가려져서, 창 안 알림은 아래 줄에 보여 준다
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pv, setPv] = useState<"comment" | "dm">("comment");
  const [replyIdx, setReplyIdx] = useState(0);
  const [tplName, setTplName] = useState<string | null>(null);
  // 켜는 날 — 새로 켜면 지금, 수정이면 처음 켠 날(발행 기다림이면 없음)
  const [start] = useState<Date | null>(() =>
    automation ? (automation.startsAt ? new Date(automation.startsAt) : null) : new Date(),
  );
  const [saving, startSaving] = useTransition();
  const [tplSaving, startTplSaving] = useTransition();
  const formRef = useRef<HTMLDivElement>(null);

  const c = cfg;
  const end = start ? new Date(start.getTime() + c.period.days * DAY_MS) : null;
  const periodText = start && end ? `${monthDay(start)} ~ ${monthDay(end)}` : `발행되면 ${c.period.days}일 동안`;

  function update(fn: (d: AutomationConfig) => void, clear: ConfigErrorKey[] = []) {
    setCfg((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
    if (clear.length) {
      setErrors((prev) => {
        const next = { ...prev };
        for (const k of clear) delete next[k];
        return next;
      });
    }
  }

  function toggleOpen(k: SectionKey) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  function switchSection(k: "first" | "dm" | "reply", on: boolean) {
    update((d) => {
      d[k].on = on;
      d.preset = "custom";
    }, [k, "first"]);
    if (on) setOpen((prev) => new Set(prev).add(k));
    if (k === "dm") setPv(on ? "dm" : "comment");
  }

  function pickProduct(p: ProductView | null) {
    // 상품 없이 만든 기본 버튼(몰 첫 화면)은 상품을 고르면 상품 페이지로
    if (p && !product) {
      update((d) => {
        for (const b of d.dm.buttons) if (b.link === "home" && b.label === "구매하러 가기") b.link = "product";
      });
    }
    setProduct(p);
    setErrors((prev) => {
      const next = { ...prev };
      delete next.product;
      delete next.dm;
      return next;
    });
  }

  // 글자 수 — 서버 검사와 같은 견본(sample_user)으로 채운 뒤 센다
  const sampleCtx = { productName: product?.name ?? "상품", productUrl: product ? withUtm(product.url, "INSTAGRAM", "dm") : "", username: "sample_user" };
  const bytesCounter = (text: string) => {
    const b = utf8Bytes(renderText(c, text, sampleCtx));
    const over = b > DM_TEXT_MAX_BYTES;
    return { over, text: over ? `${(b - DM_TEXT_MAX_BYTES).toLocaleString("ko-KR")}바이트 넘었어요` : `약 ${Math.floor((DM_TEXT_MAX_BYTES - b) / 3)}자 남음` };
  };
  const charsCounter = (text: string) => {
    const n = charCount(renderText(c, text, sampleCtx));
    return { over: n > BUTTON_TEXT_MAX_CHARS, text: `${n} / ${BUTTON_TEXT_MAX_CHARS}자` };
  };

  const R = (t: string) => renderText(c, t, { productName: product?.name ?? null, productUrl: product ? withUtm(product.url, "INSTAGRAM", "dm") : null });

  function summary(k: SectionKey): string {
    if (k === "first") return c.first.on ? R(c.first.text) : "꺼짐";
    if (k === "trig") {
      if (!isTriggerRelevant(c)) return "답글 · DM이 꺼져 있어 쓰지 않아요";
      if (c.trig.mode === "all") return `모든 댓글${c.trig.exclude.length ? ` · 제외 단어 ${c.trig.exclude.length}개` : ""}${c.trig.emojiOnly ? " · 이모지만 있는 댓글 제외" : ""}`;
      return triggerText(c);
    }
    if (k === "dm") {
      if (!c.dm.on) return "꺼짐";
      if (c.dm.format === "text") {
        const r = bytesCounter(c.dm.text);
        return r.over ? "글자 수가 넘었어요" : `글자만 · ${r.text}`;
      }
      if (c.dm.format === "button") return `버튼 메시지 · 버튼 ${c.dm.buttons.length}개`;
      return `두 단계 · '${c.dm.quick}' 누르면 버튼 메시지`;
    }
    if (k === "reply") {
      if (!c.reply.on) return "꺼짐";
      return `${effectiveReplyWhen(c) === "dm" ? "DM 받은 사람에게" : "반응한 댓글 모두에"} · 문구 ${c.reply.texts.filter((t) => t.trim()).length}개 돌려 쓰기`;
    }
    return `${periodText}${start ? ` (${c.period.days}일)` : ""}${c.period.backfill ? " · 이미 달린 댓글 포함" : ""}`;
  }

  // 아래 한 줄 요약
  function sentence(): string | null {
    const tgt = c.trig.mode === "all" ? "모든 댓글" : c.trig.keywords.length ? `${c.trig.keywords.map((k) => `'${k}'`).join(" · ")} 키워드 댓글` : "키워드 댓글";
    const n = c.reply.texts.filter((t) => t.trim()).length;
    const name = product ? `${product.name} ` : "";
    const out: string[] = [];
    if (c.first.on) {
      out.push(waiting ? "발행되면 첫 댓글을 달아요." : automation?.firstStatus === "SENT" ? "첫 댓글은 이미 달았어요." : automation?.firstStatus === "FAILED" ? "첫 댓글은 목록에서 다시 시도할 수 있어요." : isEdit ? "저장하면 바로 첫 댓글을 달아요." : "켜면 바로 첫 댓글을 달아요.");
    }
    if (c.dm.on) {
      out.push(
        c.dm.format === "twostep"
          ? `${tgt}에 DM을 보내고, '${c.dm.quick}' 버튼을 누른 사람에게 ${name}링크 버튼을 보내요.`
          : `${tgt}에 DM으로 ${name}링크${c.dm.format === "button" ? " 버튼" : ""}을 보내요.`,
      );
    }
    if (c.reply.on) {
      out.push(c.dm.on && c.reply.when === "dm" ? `DM 받은 사람 댓글에는 답글 ${n}개를 돌려 가며 달아요.` : `${tgt}에 답글 ${n}개를 돌려 가며 달아요.`);
    }
    return out.length ? out.join(" ") : null;
  }

  function applyTemplate(t: TemplateView) {
    setCfg(structuredClone(t.config));
    setErrors({});
    setFormError(null);
    setNotice(`'${t.name}' 템플릿을 불러왔어요. 필요하면 고쳐 주세요.`);
  }

  function showErrors(E: ConfigErrors) {
    setErrors(E);
    setOpen((prev) => {
      const next = new Set(prev);
      for (const k of Object.keys(E)) if (k !== "product") next.add(k as SectionKey);
      return next;
    });
    requestAnimationFrame(() => {
      const el = formRef.current?.querySelector('[data-err="true"]');
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  function save() {
    const E = validateConfig(c, { platform: "INSTAGRAM", product: product ? { name: product.name, url: product.url, soldOut: product.soldOut } : null });
    if (Object.keys(E).length) {
      showErrors(E);
      return;
    }
    setFormError(null);
    setNotice(null);
    const input: SaveAutomationInput =
      target.mode === "edit"
        ? {
            id: target.automation.id,
            socialAccountId: accountId,
            platformPostId: target.automation.platformPostId,
            postPermalink: target.automation.permalink,
            postCaption: target.automation.caption,
            postPostedAt: target.automation.postedAt,
            productId: product?.id ?? null,
            source: target.automation.source,
            publishJobId: target.automation.publishJobId,
            contentId: target.automation.contentId,
            config: c,
          }
        : {
            id: null,
            socialAccountId: accountId,
            platformPostId: target.post.id,
            postPermalink: target.post.permalink,
            postCaption: target.post.caption,
            postPostedAt: target.post.timestamp,
            productId: product?.id ?? null,
            source: "MENU",
            publishJobId: null,
            contentId: null,
            config: c,
          };
    startSaving(async () => {
      const r = await saveAutomation(input);
      if (!r.ok) {
        if (r.fieldErrors && Object.keys(r.fieldErrors).length) showErrors(r.fieldErrors);
        setFormError(r.error);
        return;
      }
      const firstFailed = r.firstComment?.startsWith("첫 댓글 실패");
      const head = isEdit ? "저장했어요. 이미 보낸 사람에게는 다시 보내지 않아요." : c.period.backfill ? "켰어요. 이미 달린 댓글부터 보내요." : r.firstComment === "첫 댓글 등록" ? "켰어요. 첫 댓글을 달았고, 새 댓글부터 처리해요." : "켰어요. 새 댓글부터 처리해요.";
      if (firstFailed) toast(`${head} 첫 댓글은 달지 못했어요(${r.firstComment!.replace(/^첫 댓글 실패:\s*/, "")}). 목록에서 다시 시도할 수 있어요.`, "risk");
      else toast(head);
      onSaved();
    });
  }

  function saveTemplate() {
    const name = (tplName ?? "").trim();
    if (!name) return;
    startTplSaving(async () => {
      const r = await saveAutomationTemplate(name, c);
      if (!r.ok) {
        setFormError(r.error);
        return;
      }
      setTplName(null);
      setFormError(null);
      setNotice('템플릿으로 저장했어요. 다음에 "무엇을 할까요?" 아래에 나와요.');
      router.refresh();
    });
  }

  const anyOn = c.first.on || c.dm.on || c.reply.on;
  const presetDays = (PERIOD_PRESETS as readonly number[]).includes(c.period.days);
  const filledReplies = c.reply.texts.filter((t) => t.trim()).length;
  const sentenceText = sentence();
  const postTitle = automation ? captionTitle(automation.caption) : target.mode === "new" ? captionTitle(target.post.caption) : "";
  const postedAt = automation ? automation.postedAt : target.mode === "new" ? target.post.timestamp : null;
  const sub = waiting ? "발행되면 시작해요" : `${postedAt ? `${monthDay(new Date(postedAt))} 게시 · ` : ""}${postTitle}`;
  const mediaUrl = target.mode === "new" ? target.post.previewUrl : null;

  // ── 칸 내용 ──
  const buttonEditor = (title: string) => (
    <>
      <TextField
        label={title}
        value={c.dm.btnText}
        onChange={(v) => update((d) => void (d.dm.btnText = v), ["dm"])}
        vars={["상품명", "아이디"]}
        counter={charsCounter(c.dm.btnText)}
      />
      <div className="flex flex-col gap-1.5">
        <FieldLabel sub={`최대 ${MAX_BUTTONS}개 · 누르면 링크가 열려요`}>버튼</FieldLabel>
        <div className="flex flex-col gap-1.5">
          {c.dm.buttons.map((b, i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <div className="grid grid-cols-[22px_minmax(0,1fr)_150px_36px] items-center gap-1.5">
                <span className="text-right text-xs text-faint">{i + 1}</span>
                <Input
                  value={b.label}
                  maxLength={BUTTON_LABEL_MAX}
                  placeholder="버튼 이름"
                  onChange={(e) => update((d) => void (d.dm.buttons[i].label = e.target.value), ["dm"])}
                  className="placeholder:text-faint"
                />
                <select
                  value={b.link}
                  onChange={(e) => update((d) => void (d.dm.buttons[i].link = e.target.value as LinkTarget), ["dm", "product"])}
                  className={selectClass}
                  aria-label={`${i + 1}번 버튼 연결`}
                >
                  {LINK_OPTIONS.map(([k, l]) => (
                    <option key={k} value={k} disabled={k !== "custom" && !product}>
                      {l}
                    </option>
                  ))}
                </select>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`${i + 1}번 버튼 빼기`}
                  disabled={c.dm.buttons.length <= 1}
                  onClick={() => update((d) => void d.dm.buttons.splice(i, 1), ["dm"])}
                >
                  <Trash2 />
                </Button>
              </div>
              {b.link === "custom" && (
                <div className="pl-7">
                  <Input
                    value={b.url}
                    placeholder="https://"
                    onChange={(e) => update((d) => void (d.dm.buttons[i].url = e.target.value), ["dm"])}
                    className="placeholder:text-faint"
                  />
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={c.dm.buttons.length >= MAX_BUTTONS}
            onClick={() => update((d) => void d.dm.buttons.push({ label: "", link: product ? "home" : "custom", url: "" }), ["dm"])}
          >
            <Plus />
            버튼 추가
          </Button>
          <Hint>버튼 이름은 {BUTTON_LABEL_MAX}자 안으로 써 주세요.</Hint>
        </div>
        <Hint>버튼 링크는 MCB 주소(mcb.cuma.co.kr/r/…)를 거쳐 상품 페이지로 넘어가요. 인스타가 버튼 클릭을 알려 주지 않아서 MCB가 직접 클릭 수를 집계해요.</Hint>
      </div>
    </>
  );

  const fmtNote: Record<DmFormat, string> = {
    button: "첫 DM에 버튼을 넣을 수 있는지는 공식 문서에 나와 있지 않아요. 거절되면 같은 내용을 글자 + 링크로 다시 보내고 활동 기록에 경고를 남겨요.",
    twostep: `첫 DM의 '${c.dm.quick}' 버튼을 누르면 대화가 열려 24시간 동안 이어서 보낼 수 있어요. 한 번 더 눌러야 해서 받는 사람이 조금 줄 수 있고, 빠른 답장은 PC 인스타에서 보이지 않아요.`,
    text: "글자만 보내요. 상품 링크에는 클릭을 집계하는 표시(utm)를 붙여요.",
  };

  return (
    <DialogShell open onClose={onClose} label="댓글 · DM 자동화 설정" widthClass="w-[min(1100px,calc(100vw-24px))]">
      <DialogHeader
        icon={<PlatformIcon platform="INSTAGRAM" size={20} />}
        title={
          <>
            댓글 · DM 자동화 <span className="text-xs font-medium text-muted-foreground">· @{(accountName ?? "").replace(/^@/, "")}</span>
          </>
        }
        sub={sub}
        onClose={onClose}
      />

      <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_340px] lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden">
        <div ref={formRef} className="flex flex-col gap-4 p-5 lg:overflow-y-auto">
          {/* 무엇을 할까요? */}
          <div className="flex flex-col gap-1.5">
            <FieldLabel>무엇을 할까요?</FieldLabel>
            <div className="grid gap-2 sm:grid-cols-3">
              {PRESETS.map((p) => (
                <ChoiceCard
                  key={p.key}
                  on={c.preset === p.key}
                  Icon={p.Icon}
                  title={p.title}
                  desc={p.desc}
                  onClick={() => {
                    setCfg((prev) => applyPreset(prev, p.key, "INSTAGRAM"));
                    setErrors({});
                    if (p.key === "custom") setOpen((prev) => new Set(prev).add("first"));
                  }}
                />
              ))}
            </div>
            {templates.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
                <Bookmark className="size-3.5" />
                저장한 템플릿:
                {templates.map((t, i) => (
                  <span key={t.id}>
                    {i > 0 && " · "}
                    <button type="button" onClick={() => applyTemplate(t)} className="font-semibold text-primary hover:underline">
                      {t.name}
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <ProductField product={product} onChange={pickProduct} error={errors.product} />

          {/* 1. 첫 댓글 */}
          <Section
            no={1}
            title="첫 댓글"
            summary={summary("first")}
            on={c.first.on}
            onSwitch={(v) => switchSection("first", v)}
            open={open.has("first")}
            onToggleOpen={() => toggleOpen("first")}
            error={errors.first}
          >
            <TextField
              label="댓글 문구"
              value={c.first.text}
              onChange={(v) => update((d) => void (d.first.text = v), ["first"])}
              vars={c.trig.mode === "keyword" ? ["키워드", "상품명"] : ["상품명"]}
            />
            {c.trig.mode === "all" && c.first.text.includes("{키워드}") && (
              <div className="flex items-center gap-2 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2">
                <TriangleAlert className="size-4 shrink-0 text-warn" />
                <span className="min-w-0 flex-1 text-xs text-ink-2">모든 댓글에 반응할 땐 {"{키워드}"}가 빈칸이 돼요.</span>
                <Button variant="outline" size="sm" onClick={() => update((d) => void (d.first.text = FIRST_ALL))}>
                  문구 바꾸기
                </Button>
              </div>
            )}
            <Hint>{"{키워드}"}는 2번 반응할 댓글의 첫 키워드로 바뀌어요. 키워드를 고치면 문구도 같이 바뀌어요. 댓글 고정은 인스타에서 직접 해 주세요.</Hint>
          </Section>

          {/* 2. 반응할 댓글 */}
          <Section no={2} title="반응할 댓글" summary={summary("trig")} open={open.has("trig")} onToggleOpen={() => toggleOpen("trig")} error={errors.trig}>
            {!isTriggerRelevant(c) ? (
              <Hint>답글이나 DM을 켜면 어떤 댓글에 반응할지 정해요.</Hint>
            ) : (
              <>
                <Segmented
                  ariaLabel="반응할 댓글"
                  value={c.trig.mode}
                  onChange={(m) =>
                    update((d) => {
                      d.trig.mode = m;
                      if (m === "all" && d.first.text === FIRST_KEYWORD) d.first.text = FIRST_ALL;
                      if (m === "keyword" && d.first.text === FIRST_ALL) d.first.text = FIRST_KEYWORD;
                    }, ["trig"])
                  }
                  options={[
                    { value: "keyword", label: (<><Tag />키워드 댓글만</>) },
                    { value: "all", label: (<><MessagesSquare />모든 댓글</>) },
                  ]}
                />
                {c.trig.mode === "keyword" ? (
                  <>
                    <div className="flex flex-col gap-1.5">
                      <FieldLabel>키워드</FieldLabel>
                      <TagInput
                        tone="brand"
                        values={c.trig.keywords}
                        max={MAX_KEYWORDS}
                        placeholder="예: 단감, 링크, 주문"
                        onChange={(v) => update((d) => void (d.trig.keywords = v), ["trig", "first"])}
                      />
                      <Hint>Enter 또는 쉼표로 넣어요. 띄어쓰기 · 이모지 · 대소문자는 무시하고 비교해요.</Hint>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <FieldLabel>비교 방식</FieldLabel>
                      <Segmented
                        ariaLabel="비교 방식"
                        value={c.trig.match}
                        onChange={(m) => update((d) => void (d.trig.match = m))}
                        options={[
                          { value: "contains", label: "포함" },
                          { value: "exact", label: "정확히 일치" },
                        ]}
                      />
                      <Hint>
                        {c.trig.match === "contains"
                          ? "'단감 주세요', '단감!!'처럼 키워드가 들어가면 반응해요."
                          : "댓글이 키워드와 똑같을 때만 반응해요. '단감 주세요'에는 반응하지 않아요."}
                      </Hint>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2">
                      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
                      <span className="text-xs text-ink-2">악플 · 광고 댓글에도 반응할 수 있어요. 제외 단어를 넣어 두고, 답글은 여러 문구를 돌려 쓰게 했어요.</span>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <FieldLabel>제외 단어</FieldLabel>
                      <TagInput
                        tone="gray"
                        values={c.trig.exclude}
                        max={MAX_KEYWORDS}
                        placeholder="예: 광고, 협찬"
                        onChange={(v) => update((d) => void (d.trig.exclude = v))}
                      />
                    </div>
                    <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        checked={c.trig.emojiOnly}
                        onChange={(e) => update((d) => void (d.trig.emojiOnly = e.target.checked))}
                      />
                      이모지만 있는 댓글은 빼기
                    </label>
                  </>
                )}
                <Hint>우리 계정 댓글과 자동 답글은 항상 빼요. 같은 사람이 여러 번 달아도 DM은 한 번만 보내요.</Hint>
              </>
            )}
          </Section>

          {/* 3. DM 보내기 */}
          <Section
            no={3}
            title="DM 보내기"
            summary={summary("dm")}
            on={c.dm.on}
            onSwitch={(v) => switchSection("dm", v)}
            open={open.has("dm")}
            onToggleOpen={() => toggleOpen("dm")}
            error={errors.dm}
          >
            <div className="flex flex-col gap-1.5">
              <FieldLabel>보내는 형태</FieldLabel>
              <div className="grid gap-2 sm:grid-cols-3">
                {FORMATS.map((f) => (
                  <ChoiceCard
                    key={f.key}
                    on={c.dm.format === f.key}
                    Icon={f.Icon}
                    title={f.title}
                    desc={f.desc}
                    onClick={() => {
                      update((d) => void (d.dm.format = f.key), ["dm"]);
                      setPv("dm");
                    }}
                  />
                ))}
              </div>
              <Hint>{fmtNote[c.dm.format]}</Hint>
            </div>

            {c.dm.format === "text" && (
              <TextField
                label="DM 문구"
                rows={4}
                value={c.dm.text}
                onChange={(v) => update((d) => void (d.dm.text = v), ["dm"])}
                vars={["상품명", "상품링크", "아이디"]}
                counter={bytesCounter(c.dm.text)}
              />
            )}
            {c.dm.format === "button" && buttonEditor("버튼 위에 보일 글")}
            {c.dm.format === "twostep" && (
              <>
                <StepHead n={1}>첫 DM</StepHead>
                <TextField
                  label="글"
                  value={c.dm.step1}
                  onChange={(v) => update((d) => void (d.dm.step1 = v), ["dm"])}
                  vars={["상품명", "아이디"]}
                  counter={bytesCounter(c.dm.step1)}
                />
                <div className="flex flex-col gap-1.5">
                  <FieldLabel>빠른 답장 버튼</FieldLabel>
                  <Input
                    value={c.dm.quick}
                    maxLength={QUICK_LABEL_MAX}
                    onChange={(e) => update((d) => void (d.dm.quick = e.target.value), ["dm"])}
                    className="max-w-[240px]"
                  />
                  <Hint>{QUICK_LABEL_MAX}자에서 잘려요. 누른 사람에게만 두 번째 DM을 보내요.</Hint>
                </div>
                <StepHead n={2}>버튼을 누르면 보내는 DM</StepHead>
                {buttonEditor("글")}
              </>
            )}

            <Hint>댓글이 달린 지 7일이 지나면 DM을 보낼 수 없어요.</Hint>

            {product?.soldOut && (
              <TextField
                label="품절 안내 문구"
                rows={2}
                value={c.dm.soldout}
                onChange={(v) => update((d) => void (d.dm.soldout = v), ["dm"])}
                vars={["상품명", "아이디"]}
                placeholder="비워 두면 품절인 동안 멈춰요"
              />
            )}
            {product?.soldOut && <Hint className="-mt-2">상품이 품절인 동안 위 DM 대신 이 문구를 보내요. 비워 두면 자동화를 멈추고 알려요.</Hint>}
          </Section>

          {/* 4. 댓글에 답글 */}
          <Section
            no={4}
            title="댓글에 답글"
            summary={summary("reply")}
            on={c.reply.on}
            onSwitch={(v) => switchSection("reply", v)}
            open={open.has("reply")}
            onToggleOpen={() => toggleOpen("reply")}
            error={errors.reply}
          >
            {c.dm.on && (
              <div className="flex flex-col gap-1.5">
                <FieldLabel>누구에게 달까요?</FieldLabel>
                <Segmented
                  ariaLabel="답글 대상"
                  value={c.reply.when}
                  onChange={(w) => update((d) => void (d.reply.when = w))}
                  options={[
                    { value: "dm", label: "DM 받은 사람에게만" },
                    { value: "all", label: "반응한 댓글 모두에" },
                  ]}
                />
                <Hint>{c.reply.when === "dm" ? "DM이 실패하거나 확인되지 않으면 답글을 달지 않아요." : "DM 결과와 상관없이 반응한 댓글에 답글을 달아요."}</Hint>
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <FieldLabel sub="돌려 가며 하나씩 골라요">답글 문구</FieldLabel>
              <div className="flex flex-col gap-1.5">
                {c.reply.texts.map((t, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <span className="w-[22px] shrink-0 text-right text-xs text-faint">{i + 1}</span>
                    <Input value={t} maxLength={300} onChange={(e) => update((d) => void (d.reply.texts[i] = e.target.value), ["reply"])} />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${i + 1}번 문구 빼기`}
                      disabled={c.reply.texts.length <= 1}
                      onClick={() => update((d) => void d.reply.texts.splice(i, 1), ["reply"])}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" disabled={c.reply.texts.length >= MAX_REPLIES} onClick={() => update((d) => void d.reply.texts.push(""))}>
                  <Plus />
                  문구 추가
                </Button>
                <Hint>{filledReplies < 3 ? "같은 답글이 반복되면 스팸으로 보일 수 있어요. 3개 이상을 권장해요." : "시리즈 댓글 자동화와 같은 방식으로 돌려 써요."}</Hint>
              </div>
            </div>
          </Section>

          {/* 5. 기간 */}
          <Section no={5} title="기간" summary={summary("period")} open={open.has("period")} onToggleOpen={() => toggleOpen("period")} error={errors.period}>
            <div className="flex flex-col gap-1.5">
              <FieldLabel>켜 둘 기간</FieldLabel>
              <div className="flex flex-wrap items-center gap-2">
                <Segmented
                  ariaLabel="기간"
                  value={presetDays ? String(c.period.days) : "custom"}
                  onChange={(v) =>
                    update((d) => {
                      if (v === "custom") {
                        if ((PERIOD_PRESETS as readonly number[]).includes(d.period.days)) d.period.days = 21;
                      } else d.period.days = Number(v);
                    }, ["period"])
                  }
                  options={[...PERIOD_PRESETS.map((d) => ({ value: String(d), label: `${d}일` })), { value: "custom", label: "직접" }]}
                />
                {!presetDays && (
                  <>
                    <Input
                      type="number"
                      min={1}
                      max={90}
                      value={c.period.days}
                      onChange={(e) => update((d) => void (d.period.days = Math.max(1, Math.min(90, Number(e.target.value) || 1))), ["period"])}
                      className="w-[90px] tabular-nums"
                      aria-label="기간(일)"
                    />
                    <span className="text-sm text-muted-foreground">일</span>
                  </>
                )}
              </div>
              <Hint>
                {start && end
                  ? `${monthDay(start)}부터 ${monthDay(end)}까지 켜 두고, 끝나면 저절로 멈춰요. 기록은 남아요.`
                  : `발행되면 그날부터 ${c.period.days}일 동안 켜 두고, 끝나면 저절로 멈춰요. 기록은 남아요.`}
              </Hint>
            </div>
            {!waiting && (
              <div className="flex flex-col gap-1">
                <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={c.period.backfill}
                    onChange={(e) => update((d) => void (d.period.backfill = e.target.checked))}
                  />
                  이미 달린 댓글에도 보내기
                </label>
                <Hint>
                  {c.period.backfill
                    ? "7일 안에 달린 댓글 중 조건에 맞는 댓글에 먼저 보내요. 7일이 지난 댓글에는 DM을 보낼 수 없어요."
                    : "기본은 켠 뒤에 달린 새 댓글부터 처리해요."}
                </Hint>
              </div>
            )}
          </Section>
        </div>

        <div className="flex flex-col items-center gap-3 border-t bg-surface-2 p-5 lg:overflow-y-auto lg:border-t-0 lg:border-l">
          <SettingsPreview
            c={c}
            product={product}
            accountName={accountName ?? ""}
            mediaUrl={mediaUrl}
            tab={pv}
            onTab={setPv}
            replyIdx={replyIdx}
            onNextReply={() => setReplyIdx((n) => n + 1)}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t px-5 py-3.5">
        {tplName !== null ? (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <Input
              autoFocus
              value={tplName}
              maxLength={40}
              onChange={(e) => setTplName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) saveTemplate();
              }}
              placeholder="템플릿 이름"
              aria-label="템플릿 이름"
              className="max-w-[280px] placeholder:text-faint"
            />
            <Button variant="outline" disabled={tplSaving || !tplName.trim()} onClick={saveTemplate}>
              이름으로 저장
            </Button>
            <Button variant="ghost" onClick={() => setTplName(null)}>
              그만두기
            </Button>
            {formError && <FieldError>{formError}</FieldError>}
          </div>
        ) : (
          <div className="min-w-0 flex-1 text-sm text-ink-2">
            {formError && <FieldError>{formError}</FieldError>}
            {notice && !formError && <p className="text-xs font-medium text-ok">{notice}</p>}
            {sentenceText ? (
              <>
                {sentenceText} <span className="text-muted-foreground">{periodText}</span>
              </>
            ) : (
              <span className="text-muted-foreground">켜진 기능이 없어요. 하나 이상 켜 주세요.</span>
            )}
          </div>
        )}
        {tplName === null && (
          <Button variant="outline" onClick={() => {
              setNotice(null);
              setTplName(`${product?.name ?? "내"} 템플릿`.slice(0, 40));
            }}>
            <BookmarkPlus />
            템플릿으로 저장
          </Button>
        )}
        <Button onClick={save} disabled={!anyOn || saving}>
          {saving ? "저장 중…" : isEdit ? "저장" : "켜기"}
        </Button>
      </div>
    </DialogShell>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function ChoiceCard({ on, Icon, title, desc, onClick }: { on: boolean; Icon: typeof Send; title: string; desc: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "flex flex-col gap-0.5 rounded-lg border bg-card px-3.5 py-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
        on ? "border-primary bg-brand-soft ring-1 ring-primary" : "border-input hover:bg-surface-2",
      )}
    >
      <b className={cn("flex items-center gap-1.5 text-sm", on && "text-primary")}>
        <Icon className="size-4" />
        {title}
      </b>
      <span className="text-xs text-muted-foreground">{desc}</span>
    </button>
  );
}

function StepHead({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-t border-dashed pt-1 text-sm font-semibold text-ink-2">
      <span className="grid size-[22px] place-items-center rounded-full bg-brand-soft text-xs text-primary">{n}</span>
      {children}
    </div>
  );
}

