import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { CheckIssue } from "@/lib/agents/check";
import type { ProductFacts } from "@/lib/agents/product-facts";
import { agentModel } from "@/lib/agents/runner";
import type { ScriptOutput } from "@/lib/agents/script";
import type { ShotlistOutput } from "@/lib/agents/shotlist";
import { getOpenAI } from "@/lib/openai";
import { callOptions } from "@/lib/products/analysis/analyze";
import { checkText, type ContentRule } from "@/lib/rules/check";
import type { createServiceClient } from "@/lib/supabase/service";

// 저장한 후킹 · 마지막 문구(0039). {상품}처럼 중괄호 안만 칸마다 채우고 나머지 글자는 고정한다.
//   1. AI가 상품에 맞는 문구를 골라 빈칸 값만 낸다(근거가 없으면 못 쓴다고 답한다).
//   2. 글자는 코드가 조립하고 금지 표현을 걸러, 대본의 첫 · 마지막 문장에 코드가 덮어쓴다 — AI가 문구를 바꿀 수 없다.
//   3. 근거 점검에 걸리면 다음 문구로, 다 안 되면 AI가 쓴 문구로 간다. 왜 바뀌었는지 화면에 남긴다.
// 문구를 저장하지 않은 계정은 AI 호출 없이 예전과 똑같다.

type Service = ReturnType<typeof createServiceClient>;

export interface PickedPhrase {
  template: string;
  text: string;
}

type PhraseKind = "hook" | "ending";
const KIND_LABEL: Record<PhraseKind, string> = { hook: "후킹 문구", ending: "마지막 문구" };

export interface PhraseState {
  hooks: PickedPhrase[];
  endings: PickedPhrase[];
  // 못 쓴 문구와 이유. 쓸 문구가 남아 있으면 점검에서 떨어진 것만 화면에 보인다
  rejected: { kind: PhraseKind; template: string; why: string; afterCheck: boolean }[];
  tokens: { input: number; output: number };
}

const SLOT = /\{([^{}]+)\}/g;

/** 문구의 빈칸 이름들. */
export function slotNames(template: string): string[] {
  return [...template.matchAll(SLOT)].map((m) => m[1].trim());
}

/** 빈칸을 채워 글자를 조립한다. 하나라도 비면 null — 나머지 글자는 건드리지 않는다. */
export function renderTemplate(template: string, values: Map<string, string>): string | null {
  let missing = false;
  const text = template.replace(SLOT, (_, name: string) => {
    const v = values.get(name.trim())?.replace(/[{}]/g, "").trim();
    if (!v) missing = true;
    return v ?? "";
  });
  return missing ? null : text.replace(/\s+/g, " ").trim();
}

/** 저장 전 검사 — 잘못 쓴 문구면 이유를 돌려준다. */
export function templateProblem(template: string): string | null {
  const stray = template.replace(SLOT, "");
  if (stray.includes("{") || stray.includes("}")) return `중괄호를 확인해 주세요: "${template}"`;
  return null;
}

const itemSchema = z.object({
  index: z.number().int().describe("주어진 문구 번호"),
  fits: z.boolean().describe("이 상품에 쓸 수 있으면 true"),
  why: z.string().describe("못 쓰면 사람이 읽을 이유 한 문장. 쓸 수 있으면 빈 문자열"),
  values: z.array(z.object({ name: z.string(), value: z.string() })).describe("빈칸 이름과 넣을 말. 빈칸이 없으면 빈 배열"),
});
const pickSchema = z.object({
  hooks: z.array(itemSchema).describe("주어진 후킹 문구 전부, 이 상품에 잘 맞는 순서로"),
  endings: z.array(itemSchema).describe("주어진 마지막 문구 전부, 이 상품에 잘 맞는 순서로"),
});

const PROMPT = `너는 쇼핑몰 릴스 담당이다. 사람이 저장해 둔 문구 틀 중에서 이 상품에 맞는 것을 고르고 빈칸에 들어갈 말만 정한다.
- 틀의 글자는 바꾸지 않는다. 중괄호 빈칸에 넣을 말만 정한다. 빈칸 이름을 보고 무슨 말이 들어갈지 판단한다.
- 빈칸 값은 상품 사실에 있는 내용만, 그 자리에 자연스럽게 읽히도록 짧게 쓴다. 상품명은 긴 원래 이름 대신 사람이 부르는 짧은 이름으로 쓴다(예: [전경희] 고당도 제스프리 골드키위 → 골드키위).
- 근거가 없어 빈칸을 못 채우거나 상품과 안 맞는 틀(과일에 피부 고민 등)은 fits=false로 두고 why에 이유를 쓴다. 억지로 채우지 않는다.
- 근거 없는 효과 · 숫자 · 사람이 써 본 것 같은 체험을 빈칸에 넣지 않는다.`;

export async function preparePhrases(input: {
  facts: ProductFacts;
  rules: ContentRule[];
  hooks: string[];
  endings: string[];
  // 최근에 쓴 틀 — 같은 첫마디가 연달아 나가지 않게 뒤로 보낸다
  recent: string[];
}): Promise<PhraseState> {
  const state: PhraseState = { hooks: [], endings: [], rejected: [], tokens: { input: 0, output: 0 } };
  if (input.hooks.length === 0 && input.endings.length === 0) return state;
  const { facts } = input;

  let picked: z.infer<typeof pickSchema> | null | undefined;
  try {
    const model = agentModel();
    const completion = await getOpenAI().chat.completions.parse({
      model,
      ...callOptions(model, 1500),
      messages: [
        { role: "system", content: PROMPT },
        {
          role: "user",
          content: `상품 사실:\n${JSON.stringify({ name: facts.name, kind: facts.kindLabel, price: facts.price, oneLine: facts.oneLine, claims: facts.claims.map((c) => c.claim), details: facts.details, usage: facts.usage })}\n\n후킹 문구 틀:\n${input.hooks.map((t, i) => `${i}. ${t}`).join("\n") || "(없음)"}\n\n마지막 문구 틀:\n${input.endings.map((t, i) => `${i}. ${t}`).join("\n") || "(없음)"}`,
        },
      ],
      response_format: zodResponseFormat(pickSchema, "phrase_picks"),
    });
    picked = completion.choices[0]?.message?.parsed;
    state.tokens = { input: completion.usage?.prompt_tokens ?? 0, output: completion.usage?.completion_tokens ?? 0 };
  } catch (e) {
    console.warn("[fixed-phrases] 문구 고르기 실패:", e instanceof Error ? e.message : e);
  }
  if (!picked) {
    for (const template of input.hooks) state.rejected.push({ kind: "hook", template, why: "문구를 고르지 못했어요", afterCheck: false });
    for (const template of input.endings) state.rejected.push({ kind: "ending", template, why: "문구를 고르지 못했어요", afterCheck: false });
    return state;
  }

  const collect = (kind: PhraseKind, templates: string[], items: z.infer<typeof itemSchema>[]): PickedPhrase[] => {
    const out: PickedPhrase[] = [];
    for (const item of items) {
      const template = templates[item.index];
      if (!template || out.some((p) => p.template === template)) continue;
      const reject = (why: string) => state.rejected.push({ kind, template, why, afterCheck: false });
      if (!item.fits) {
        reject(item.why || "이 상품과 맞지 않아요");
        continue;
      }
      const text = renderTemplate(template, new Map(item.values.map((v) => [v.name.trim(), v.value])));
      if (!text) {
        reject("빈칸을 채울 근거가 없어요");
        continue;
      }
      // 광고 문구 규칙 — 금지 표현만 본다(꼭 넣을 문구는 캡션 등 전체에서 본다)
      const banned = checkText(text, facts.kind, input.rules, facts.approvedClaims, {
        healthFunctional: facts.healthFunctional,
        certifiedFunctions: facts.certifiedFunctions,
      }).find((h) => h.rule.ruleType === "BANNED");
      if (banned) {
        reject(`금지 표현 "${banned.matched}"이 들어 있어요`);
        continue;
      }
      out.push({ template, text });
    }
    // 잘 맞는 순서는 그대로 두고, 최근에 쓴 것만 뒤로 보낸다
    return [...out.filter((p) => !input.recent.includes(p.template)), ...out.filter((p) => input.recent.includes(p.template))];
  };
  state.hooks = collect("hook", input.hooks, picked.hooks);
  state.endings = collect("ending", input.endings, picked.endings);
  return state;
}

const squash = (s: string) => s.replace(/\s+/g, "");

/**
 * 점검에서 지금 쓰는 문구가 걸렸으면 그 문구를 빼고 다음으로 넘어간다. 뺐으면 true.
 * 사람이 고정한 글자는 다시 쓴다고 달라지지 않아, 같은 문구로 재시도하지 않는다.
 */
export function dropFailedPhrases(state: PhraseState, issues: CheckIssue[]): boolean {
  let dropped = false;
  for (const [kind, list] of [["hook", state.hooks], ["ending", state.endings]] as const) {
    const current = list[0];
    if (!current) continue;
    const hit = issues.find((i) => {
      if (i.kind !== "grounding" && i.kind !== "fabrication" && i.kind !== "rules") return false;
      const quoted = i.detail.match(/"([^"]+)"/)?.[1];
      if (!quoted) return false;
      const q = squash(quoted);
      const t = squash(current.text);
      return t.includes(q) || q.includes(t);
    });
    if (!hit) continue;
    state.rejected.push({ kind, template: current.template, why: hit.detail, afterCheck: true });
    list.shift();
    dropped = true;
  }
  return dropped;
}

/** 화면에 남길 말 — 저장한 문구를 못 썼거나 다른 문구로 바뀐 이유. */
export function phraseNotes(state: PhraseState): string[] {
  const notes: string[] = [];
  for (const [kind, list] of [["hook", state.hooks], ["ending", state.endings]] as const) {
    const rejected = state.rejected.filter((r) => r.kind === kind);
    const shown = list.length > 0 ? rejected.filter((r) => r.afterCheck) : rejected;
    if (shown.length === 0) continue;
    const why = shown.map((r) => `"${r.template}" — ${r.why}`).join(" / ");
    notes.push(list.length > 0 ? `${KIND_LABEL[kind]}를 다른 문구로 바꿨어요. ${why}` : `저장한 ${KIND_LABEL[kind]}를 못 써서 AI가 썼어요. ${why}`);
  }
  return notes;
}

/** 대본에 고정 문구를 덮어쓴다 — 말과 화면 문구에 똑같이. */
export function applyToScript(script: ScriptOutput, state: PhraseState): ScriptOutput {
  const hook = state.hooks[0];
  const ending = state.endings[0];
  const beats = script.beats.map((b) => ({ ...b }));
  if (hook && beats[0]) beats[0] = { ...beats[0], spoken: hook.text, on_screen: hook.text };
  if (ending && beats.length > 1) beats[beats.length - 1] = { ...beats[beats.length - 1], spoken: ending.text, on_screen: ending.text };
  return {
    ...script,
    beats,
    hooks: hook ? script.hooks.map((h, i) => (i === script.chosen_hook ? { ...h, spoken: hook.text, on_screen: hook.text } : h)) : script.hooks,
  };
}

/** 컷 리스트에 고정 문구를 덮어쓴다. 말하지 않는 계정(대사 없는 컷)은 화면 문구에만 넣는다. */
export function applyToShotlist(shotlist: ShotlistOutput, state: PhraseState, speaks: boolean): ShotlistOutput {
  const hook = state.hooks[0];
  const ending = state.endings[0];
  const cuts = shotlist.cuts.map((c) => ({ ...c }));
  const put = (i: number, text: string) => {
    cuts[i] = { ...cuts[i], on_screen: text, voice: speaks || cuts[i].voice ? text : "" };
  };
  if (hook && cuts[0]) put(0, hook.text);
  if (ending && cuts.length > 1) put(cuts.length - 1, ending.text);
  return {
    ...shotlist,
    cuts,
    hooks: hook ? shotlist.hooks.map((h, i) => (i === shotlist.chosen_hook ? { ...h, spoken: hook.text, on_screen: hook.text } : h)) : shotlist.hooks,
  };
}

/** 지시문 끝에 붙일 고정 문구 안내. 문구가 없으면 빈 문자열. */
export function fixedPhraseBlock(state: PhraseState): string {
  const hook = state.hooks[0];
  const ending = state.endings[0];
  if (!hook && !ending) return "";
  return `

사람이 고정한 문구 (글자를 바꾸지 말고 그대로 쓴다. 저장할 때 이 글자로 덮어쓴다):${
    hook
      ? `
- 첫 문장: "${hook.text}" — 첫 비트(컷)의 말과 화면 문구에 그대로 쓴다. 훅을 새로 쓰고 채점하는 순서는 건너뛰고, hooks 첫 항목에 이 문구를 넣고 chosen_hook은 0, 나머지 두 개는 대안으로 채운다. 나머지 내용은 이 문장에서 자연스럽게 이어지게 쓴다.`
      : ""
  }${
    ending
      ? `
- 마지막 문장: "${ending.text}" — 마지막 비트(컷)의 말과 화면 문구에 그대로 쓴다. loop_word는 빈 문자열로 둔다. 캡션의 요청도 이 문장과 같은 요청으로 맞춘다.`
      : ""
  }`;
}

/** 이 계정 · 방식에서 최근에 쓴 틀 — 최근 것이 앞에 온다. */
export async function recentTemplates(service: Service, accountId: string, track: "A" | "B", since: string): Promise<string[]> {
  const { data } = await service
    .from("content_plans")
    .select("script")
    .eq("social_account_id", accountId)
    .eq("track", track)
    // 직접 촬영 기획은 날짜가 없어 만든 때로 본다
    .gte(track === "A" ? "created_at" : "slot_date", since)
    .not("script", "is", null)
    .order(track === "A" ? "created_at" : "slot_date", { ascending: false })
    .limit(30);
  const out: string[] = [];
  for (const p of data ?? []) {
    const fixed = (p.script as { fixed?: { hook?: { template?: string } | null; ending?: { template?: string } | null } } | null)?.fixed;
    if (fixed?.hook?.template) out.push(fixed.hook.template);
    if (fixed?.ending?.template) out.push(fixed.ending.template);
  }
  return out;
}

/** 대본과 함께 저장할 기록 — 다음 칸의 "최근에 쓴 문구"와 화면 안내에 쓴다. */
export function fixedRecord(state: PhraseState) {
  return { hook: state.hooks[0] ?? null, ending: state.endings[0] ?? null, notes: phraseNotes(state) };
}
