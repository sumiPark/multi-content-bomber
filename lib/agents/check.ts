import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { checkCaption, checkTone, scoreHooks, timeScript } from "@/lib/agents/ko-skills";
import type { ProductFacts } from "@/lib/agents/product-facts";
import { agentModel } from "@/lib/agents/runner";
import type { ScriptOutput } from "@/lib/agents/script";
import { getOpenAI } from "@/lib/openai";
import { callOptions } from "@/lib/products/analysis/analyze";
import { checkText, type ContentRule } from "@/lib/rules/check";

// 점검 에이전트(4) — AI 자동 업로드는 사람이 영상을 보지 않고 나가므로, 올리기 전에 여기서 걸러 멈춘다.
// AI 말투 점수만 멈추지 않고 경고로 남긴다(2026-11-05 사용자 결정). 짧은 문장이 이어지는 릴스 대본을 낮게 재서, 자연스러운 문장도 기준에 못 미쳤다.
// 점검 기준은 잠긴 항목: 피드백(자동 승인 포함)으로 바뀌지 않는다. 기준값은 이 파일 상수와 광고 문구 규칙(0026).
//   코드로 재는 것: 훅 점수 · 길이 · 광고 문구 규칙 · AI 말투 · 캡션 형식 · 판매 상태
//   AI가 판단하는 것: 문장마다 상세페이지 근거가 있는지, 1인칭 체험 · 후기를 지어냈는지

const MIN_HOOK_SCORE = 50;
const MIN_HUMAN_SCORE = 55;
const LENGTH_RANGE: [number, number] = [12, 40];

export interface CheckIssue {
  kind: "hook" | "length" | "rules" | "tone" | "caption" | "stock" | "grounding" | "fabrication" | "edit";
  detail: string;
}

/** 칸을 멈추는 항목만. 말투는 사람이 보고 판단할 경고다. */
export function blockingIssues<T extends { kind: string }>(issues: T[]): T[] {
  return issues.filter((i) => i.kind !== "tone");
}

export interface CheckResult {
  passed: boolean;
  issues: CheckIssue[];
  scores: { hook: number | null; humanScore: number | null; seconds: number | null; caption: string | null };
  tokens: { input: number; output: number };
}

const groundingSchema = z.object({
  unsupported: z
    .array(z.object({ sentence: z.string(), why: z.string() }))
    .describe("상품 사실 · 원문에 근거가 없는 사실 주장(숫자 · 성분 · 효과 · 산지 · 구성). 없으면 빈 배열"),
  fabricated: z
    .array(z.object({ sentence: z.string(), why: z.string() }))
    .describe("사람이 직접 써 본 것처럼 꾸민 1인칭 체험 · 지어낸 후기 · 가짜 고객 이야기. 없으면 빈 배열"),
});

// 직접 촬영 칸(A): 사람이 찍고 완성본을 보므로 컷에서 보여 주는 1인칭은 괜찮고, 길이는 컷 길이 합으로 잰다.
export interface CheckOptions {
  track?: "A" | "B";
  // A: 컷 길이 합(초) — 말하는 속도 대신 이걸로 길이를 잰다
  seconds?: number;
  // 첫 문장이 사람이 고정한 문구면 점수로 막지 않는다 — 다시 써도 글자가 그대로라 칸이 멈추기만 한다
  fixedHook?: boolean;
  // 사람이 고정한 문구 — AI 말투 점수에서 뺀다(사람이 쓴 글을 AI 티로 잡지 않는다)
  fixedTexts?: string[];
}

// 훅 채점 축 이름(.claude/skills/ig-reel-ko/hookscore_ko.py CHECK_KO와 같다)
const HOOK_AXIS_KO: Record<string, string> = { LENGTH: "길이", SPECIFICITY: "구체성", STAKES: "긴장", FRONTLOAD: "앞쪽 배치", ADDRESS: "호명" };

export async function checkScript(
  script: ScriptOutput,
  facts: ProductFacts,
  rules: ContentRule[],
  handle: string,
  opts: CheckOptions = {},
): Promise<CheckResult> {
  const track = opts.track ?? "B";
  const issues: CheckIssue[] = [];
  const spoken = script.beats.map((b) => b.spoken).filter(Boolean);
  const onScreen = script.beats.map((b) => b.on_screen).filter(Boolean);

  // 1. 훅 — 고른 훅을 다시 채점한다(작가 에이전트의 자기 채점을 믿지 않음).
  //    B는 첫 비트, A는 고른 훅 문장(말하지 않는 계정은 첫 컷이 짧은 화면 문구뿐이라).
  const hookText = track === "A" ? (script.hooks[script.chosen_hook]?.spoken ?? spoken[0]) : spoken[0];
  const hook = opts.fixedHook ? null : scoreHooks([hookText ?? ""])[0];
  if (!opts.fixedHook && (!hook || hook.score < MIN_HOOK_SCORE)) {
    const weak = hook ? (HOOK_AXIS_KO[hook.weakest] ?? hook.weakest) : "?";
    issues.push({ kind: "hook", detail: `첫 문장 점수 ${hook?.score ?? 0}점 (기준 ${MIN_HOOK_SCORE}점) — 가장 약한 부분: ${weak}` });
  }

  // 2. 길이 · 비트
  const timing = timeScript(spoken.length >= 2 ? spoken : [...spoken, ""], 20);
  const seconds = opts.seconds ?? timing.totalSeconds;
  if (seconds < LENGTH_RANGE[0] || seconds > LENGTH_RANGE[1]) {
    issues.push({ kind: "length", detail: `길이 ${seconds.toFixed(1)}초 (기준 ${LENGTH_RANGE[0]}~${LENGTH_RANGE[1]}초)` });
  }
  const longBeats = track === "B" ? timing.beats.filter((b) => b.dur > 4.5) : [];
  if (longBeats.length) issues.push({ kind: "length", detail: `4초 넘는 비트 ${longBeats.length}개: "${longBeats[0].text.slice(0, 30)}…"` });

  // 3. 광고 문구 규칙 — 내레이션 · 화면 문구 · 캡션 전부
  const allText = [...spoken, ...onScreen, script.caption.text].join("\n");
  for (const h of checkText(allText, facts.kind, rules, facts.approvedClaims, { healthFunctional: facts.healthFunctional, certifiedFunctions: facts.certifiedFunctions })) {
    issues.push({
      kind: "rules",
      detail: h.rule.ruleType === "BANNED" ? `금지 표현 "${h.matched}" — ${h.rule.reason ?? ""}` : `필수 문구 빠짐 "${h.rule.phrase}" — ${h.rule.reason ?? ""}`,
    });
  }

  // 4. AI 말투 — 내레이션과 캡션 각각
  const toneSpoken = checkTone(spoken.filter((l) => !opts.fixedTexts?.includes(l)).join("\n"));
  const toneCaption = checkTone(script.caption.text);
  const human = Math.min(toneSpoken.humanScore, toneCaption.humanScore);
  if (human < MIN_HUMAN_SCORE) {
    const worst = toneSpoken.humanScore <= toneCaption.humanScore ? "내레이션" : "캡션";
    issues.push({ kind: "tone", detail: `${worst}이 AI가 쓴 말투 같아요 (사람 말투 점수 ${human}점, 기준 ${MIN_HUMAN_SCORE}점). 들어 보고 판단해 주세요` });
  }

  // 5. 캡션 형식
  const cap = checkCaption(script.caption.text, script.caption.keywords, handle);
  if (cap.verdict !== "READY") {
    // 무엇을 고칠지 보이게 — 예전엔 "캡션 점검 FIX"만 나왔다
    const bad = ((cap.checks ?? []) as { check: string; status: string; detail: string }[]).filter((c) => c.status !== "PASS");
    const why = bad.length ? bad.map((c) => `${c.check}: ${c.detail}`).join(" · ") : "형식을 확인해 주세요";
    issues.push({ kind: "caption", detail: `캡션 — ${why}`.slice(0, 300) });
  }

  // 6. 판매 상태 — 판매 중이 아닌 상품을 판매 중처럼 올리지 않는다
  if (facts.stockStatus !== "available") issues.push({ kind: "stock", detail: "지금 판매 중이 아닌 상품이에요" });

  // 7. 근거 · 지어낸 체험 (AI 판단)
  const model = agentModel();
  const completion = await getOpenAI().chat.completions.parse({
    model,
    ...callOptions(model, 3000),
    messages: [
      {
        role: "system",
        content: `너는 쇼핑몰 릴스의 광고 심의 담당이다. 대본 · 화면 문구 · 캡션의 문장을 하나씩 상품 사실과 원문에 대조한다.
- 사실 주장(숫자 · 성분 · 효과 · 산지 · 구성 · 가격)이 상품 사실이나 원문에 없으면 unsupported.
- 말투 · 감탄 · 권유(예: "가볍게 써 보세요")는 사실 주장이 아니니 괜찮다.
- 판매처 이름(shop)을 말하거나 태그로 쓰는 것은 사실 주장이 아니니 괜찮다.
- 상품 종류에 대한 상식 수준의 말(예: "각질 케어 크림은 자극이 걱정되죠")은 괜찮다. 다만 수치 · 효과 단정, 특정 회사나 제품과의 비교, 우열 단정은 unsupported.
${
          track === "A"
            ? `- 이 영상은 사람이 직접 찍는다. 그 장면에서 실제로 보여 주는 것에 대한 1인칭("덜어 보면 묽어요", "잘라 보니 속이 노래요")은 괜찮다.
  촬영으로 확인할 수 없는 체험(장기간 사용 결과 · 효과 체감 · "먹고 나서 속이 편해졌어요")과 지어낸 고객 후기는 fabricated.`
            : `- 실제 사람이 써 본 것처럼 꾸민 1인칭 체험("써 봤는데", "제 피부가"), 지어낸 고객 후기는 fabricated. 이 영상은 AI가 만들고 사람이 써 본 적이 없다.`
        }
- 애매하면 통과시키지 말고 적는다.`,
      },
      {
        role: "user",
        content: `상품 사실:\n${JSON.stringify({ name: facts.name, listingName: facts.rawName, shop: facts.shop, price: facts.price, oneLine: facts.oneLine, claims: facts.claims, details: facts.details, usage: facts.usage, cautions: facts.cautions, approvedClaims: facts.approvedClaims })}\n\n상세페이지 원문(일부):\n${facts.sourceText}\n\n점검할 글:\n[내레이션]\n${spoken.join("\n")}\n[화면 문구]\n${onScreen.join("\n")}\n[캡션]\n${script.caption.text}`,
      },
    ],
    response_format: zodResponseFormat(groundingSchema, "grounding"),
  });
  const g = completion.choices[0]?.message?.parsed;
  if (!g) throw new Error("근거 점검 응답이 비어 있음");
  for (const u of g.unsupported) issues.push({ kind: "grounding", detail: `근거 없음: "${u.sentence}" — ${u.why}` });
  for (const fb of g.fabricated) issues.push({ kind: "fabrication", detail: `지어낸 체험: "${fb.sentence}" — ${fb.why}` });

  return {
    passed: blockingIssues(issues).length === 0,
    issues,
    scores: { hook: hook?.score ?? null, humanScore: human, seconds, caption: cap.verdict },
    tokens: { input: completion.usage?.prompt_tokens ?? 0, output: completion.usage?.completion_tokens ?? 0 },
  };
}
