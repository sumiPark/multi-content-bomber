import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AccountConcept } from "@/lib/agents/concept";
import type { ProductFacts } from "@/lib/agents/product-facts";
import type { BoardBrief } from "@/lib/lemo/board-brief";
import type { ProductionChoice } from "@/lib/lemo/contract";
import { screenWords } from "@/lib/lemo/direct";
import { LemoCastError, LemoNoExplainStyleError, runLemoJob, type LemoJob, type LemoOutcome, type LemoSources } from "@/lib/lemo/run";
import { UsageLedger, type UsageSummary } from "@/lib/lemo/usage";
import type { ContentRule } from "@/lib/rules/check";
import type { KitInput, KitResult } from "@/lib/shoot/video-kit/pipeline";
import type { createServiceClient } from "@/lib/supabase/service";

// AI 자동 영상의 기본 제작 경로: 확정한 장면표에서 추린 값(lib/lemo/board-brief.ts — 말 · 후킹 · 화면 지시 · 화면 글자 · 자막 줄 · 강조어 · 글자 디자인 · 글꼴 · 끝 화면)으로
// lemo 코드 애니메이션을 만든다(lib/lemo/run.ts).
// 제작 방식 선택은 기존 방식(auto-video)을 고르지 않는다(lemo로 정해 둠).
// lemo가 끝내 실패하면 사진 · 스톡 컷으로 만들지 않는다(2026-11-13 사용자 결정): kit 없이 blocked(이유)를 돌려주고,
// 호출자(make.ts)가 LemoBlocked로 멈춰 워커가 그 칸을 "다시 만들기 필요"(BLOCKED)로 둔다.
//   캐릭터 준비 실패(LemoCastError)면 그 전에 캐릭터 없는 방식(픽토그램 모션 · 수채 붓)으로 영상 전체를 처음부터 다시 만들어 본다(remakeWithoutCharacters).
//   다시 만든 영상은 경고(사람 확인 · 자동 발행 멈춤)를 남기고, 그것도 실패하면 두 실패 이유를 함께 남기고 멈춘다.
// 러너 변수 AUTO_VIDEO_ENGINE=kit이면 이 경로를 아예 부르지 않는다(worker/make-auto-videos.ts).

type Service = ReturnType<typeof createServiceClient>;

export type AutoVideoEngine = "lemo" | "kit";

export interface LemoAttempt {
  /** 완성본. null이면 record.blocked에 이유가 있다 */
  kit: KitResult | null;
  /** 결과를 남길 짧은 기록(칸의 video · agent_runs) */
  record: {
    used: boolean;
    choice: ProductionChoice | null;
    characters: { reused: string[]; created: string[] };
    /** lemo로 만들지 못한 이유. 있으면 이 칸은 영상 없이 "다시 만들기 필요"로 멈춘다(사진 · 스톡 컷으로 넘어가지 않는다) */
    blocked: string | null;
    usage: Pick<UsageSummary, "totals" | "cost">;
  };
  /** 사람이 확인할 경고(검수 문제 · 배역을 다시 정한 일). 경고가 있으면 자동 발행하지 않는다 */
  warnings: string[];
  /** make.ts 토큰 합계에 더할 값(편집 키트 합성까지 포함) */
  tokens: { input: number; output: number };
  /** lemo 화면에 그린 글자(word 소품)와 그 장면이 시작하는 장면 번호. 완성본의 화면 글자 점검에 넣는다. lemo로 못 만들었으면 빈 배열 */
  screenTexts: { beat: number; text: string }[];
}

/**
 * 캐릭터 준비가 끝내 실패한 영상(LemoCastError)을 캐릭터 없이 그림 · 도형 · 글자로 설명하는 lemo 스타일로 처음부터 다시 만든다.
 * 스타일은 AI를 다시 부르지 않고 규칙 점수로 고른다(select.ts chooseNoCharacterStyle). 같은 장면표 · 음성 원고 · 편집 키트 · 자막 스킬을 쓴다.
 * 작업 폴더는 <out>/no-characters(실패한 캐릭터 시트 기록은 그대로 둔다). 고를 수 있는 캐릭터 없는 스타일이 없으면 null(호출자가 원래 실패로 멈춘다).
 * 다시 만들다 실패하면 throw — 호출자가 처음 실패와 함께 남긴다.
 */
async function remakeWithoutCharacters(job: LemoJob, failure: LemoCastError, ledger: UsageLedger): Promise<LemoOutcome | null> {
  const why = `캐릭터 준비 실패(${failure.failed.join(" / ")})`.slice(0, 240);
  const out = join(job.out, "no-characters");
  mkdirSync(out, { recursive: true });
  console.log(`  [lemo] ${why} → 캐릭터 없는 방식으로 처음부터 다시 만들어요`);
  try {
    return await runLemoJob({ ...job, out, noCharacters: { why } }, ledger);
  } catch (e) {
    // 고를 수 있는 캐릭터 없는 스타일이 없을 때만 null — 그 밖의 실패는 이유를 남기도록 던진다
    if (e instanceof LemoNoExplainStyleError) return null;
    throw e;
  }
}

export async function makeWithLemo(input: {
  service: Service;
  dryRun: boolean;
  planId: string;
  accountId: string;
  /** 계정 표시 이름(@ 없이). lemo 캐릭터 라이브러리 폴더 이름이 된다 */
  account: string;
  concept: AccountConcept;
  facts: ProductFacts;
  rules: ContentRule[];
  /** 장면표에서 lemo가 쓸 것만 추린 값. 글꼴 · 글자 디자인은 사진 경로와 같은 방식으로 고른 값이 들어 있다 */
  brief: BoardBrief;
  /** 장면표를 쓸 때 정리한 소재 수 — 제작 방식 선택이 참고한다 */
  sources: LemoSources;
  workDir: string;
  reviewFinal: KitInput["reviewFinal"];
}): Promise<LemoAttempt> {
  const { service, brief } = input;
  const out = join(input.workDir, "lemo");
  mkdirSync(out, { recursive: true });
  // 0055 전이면 칸이 없어 오류가 난다. 선호 스타일은 기본값일 뿐이라 비워 두고 이어 간다
  const prefs = await (service as unknown as SupabaseClient).from("account_concepts").select("lemo_preferred_styles").eq("social_account_id", input.accountId).maybeSingle();
  if (prefs.error) console.warn(`  [lemo] 선호 스타일을 읽지 못해 비워 둠: ${prefs.error.message}`);
  const preferred = (prefs.data as { lemo_preferred_styles?: string[] } | null)?.lemo_preferred_styles ?? [];
  const accountKey = input.account.replace(/^@/, "").toLowerCase();

  const ledger = new UsageLedger();
  const warnings: string[] = [];
  let blocked: string | null = null;
  let outcome: LemoOutcome | null = null;
  const job: LemoJob = {
    mode: "plan",
    out,
    account: { accountKey, accountName: input.account, notes: input.concept.autoNotes || null, voiceId: input.concept.autoVoiceId, preferredStyles: preferred },
    facts: input.facts,
    rules: input.rules,
    script: brief.scenes.map((s) => s.say),
    // 사진 컷 경로와 같게 읽는 원고(tts)로 음성을 만든다
    speech: brief.scenes.map((s) => s.speech),
    hook: { spoken: brief.hook.spoken, on_screen: brief.hook.on_screen },
    // 장면별 화면 지시 · 화면 글자 · 자막 줄 · 강조어 · 글자 디자인 · 글꼴 · 끝 화면
    brief,
    sources: input.sources,
    tone: input.concept.autoNotes || null,
    service: input.dryRun ? null : service,
    readService: service,
    planId: input.planId,
    reviewFinal: input.reviewFinal,
  };
  try {
    try {
      outcome = await runLemoJob(job, ledger);
    } catch (e) {
      // 캐릭터 준비 실패만 캐릭터 없는 방식으로 다시 만들어 본다. 못 하면 원래 실패로 멈춘다
      if (!(e instanceof LemoCastError)) throw e;
      let remade: LemoOutcome | null;
      try {
        remade = await remakeWithoutCharacters(job, e, ledger);
      } catch (e2) {
        throw new Error(`${e.message} → 캐릭터 없는 방식으로 다시 만들기도 실패: ${e2 instanceof Error ? e2.message : String(e2)}`);
      }
      if (!remade) throw e;
      outcome = remade;
      // 사람이 확인하게 남긴다(경고가 있으면 자동 발행하지 않는다)
      if (remade.final) warnings.push(`캐릭터 그림이 검수를 통과하지 못해 캐릭터 없는 방식(${remade.choice?.style ?? "?"})으로 다시 만들었어요 — ${e.failed.join(" / ")}`.slice(0, 300));
    }
    if (!outcome.final || !outcome.kit) {
      blocked = `제작 방식 선택에서 lemo로 만들지 않기로 했어요: ${outcome.choice?.backend ?? "?"} — ${outcome.choice?.reason ?? ""}`.slice(0, 300);
      console.warn(`  [lemo] ${blocked} → 다시 만들기 필요로 둔다`);
    } else {
      warnings.push(...outcome.review.map((r) => `lemo 검수: ${r}`.slice(0, 300)));
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // 사진 · 스톡 컷으로 넘어가지 않는다. 이유는 칸에 남아 확인 화면에 보인다
    blocked = message.slice(0, 300);
    console.warn(`  [lemo] 실패 → 다시 만들기 필요로 둔다: ${message}`);
  }

  const usage = ledger.summarize();
  // OpenAI 글 모델 토큰만 합친다(받아쓰기 · 음성은 토큰이 아니다). 편집 키트 합성 토큰도 장부에 들어 있다
  const tokens = Object.entries(usage.totals.by_provider)
    .filter(([k]) => k.startsWith("openai:") && !k.includes("whisper"))
    .reduce((t, [, v]) => ({ input: t.input + v.input + v.cached_input, output: t.output + v.output }), { input: 0, output: 0 });
  const used = !!outcome?.kit && !!outcome.final;
  return {
    kit: used ? outcome!.kit : null,
    record: {
      used,
      choice: outcome?.choice ?? null,
      characters: { reused: outcome?.characters.reused ?? [], created: outcome?.characters.created.map((c) => c.id) ?? [] },
      blocked,
      usage: { totals: usage.totals, cost: usage.cost },
    },
    warnings,
    tokens,
    screenTexts: used && outcome?.production ? screenWords(outcome.production) : [],
  };
}
