import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AccountConcept } from "@/lib/agents/concept";
import type { ProductFacts } from "@/lib/agents/product-facts";
import type { Storyboard } from "@/lib/agents/storyboard";
import type { ProductionChoice } from "@/lib/lemo/contract";
import { runLemoJob, type LemoSources } from "@/lib/lemo/run";
import { UsageLedger, type UsageSummary } from "@/lib/lemo/usage";
import type { ContentRule } from "@/lib/rules/check";
import type { KitInput, KitResult } from "@/lib/shoot/video-kit/pipeline";
import type { createServiceClient } from "@/lib/supabase/service";

// AI 자동 영상의 기본 제작 경로: 확정한 장면표의 말 · 후킹으로 lemo 코드 애니메이션을 만든다(lib/lemo/run.ts).
// 제작 방식 선택이 기존 방식(auto-video)을 고르거나 lemo가 실패하면 kit 없이 돌아오고, 호출자(make.ts)가 사진 · 스톡 컷으로 만든다.
// 러너 변수 AUTO_VIDEO_ENGINE=kit이면 이 경로를 아예 부르지 않는다(worker/make-auto-videos.ts).

type Service = ReturnType<typeof createServiceClient>;

export type AutoVideoEngine = "lemo" | "kit";

export interface LemoAttempt {
  /** 완성본. null이면 기존 컷 경로로 만든다 */
  kit: KitResult | null;
  /** 결과를 남길 짧은 기록(칸의 video · agent_runs) */
  record: {
    used: boolean;
    choice: ProductionChoice | null;
    characters: { reused: string[]; created: string[] };
    /** 기존 경로로 넘어간 이유(선택 · 실패) */
    fallback: string | null;
    usage: Pick<UsageSummary, "totals" | "cost">;
  };
  /** 사람이 확인할 경고(검수 문제 · 실패로 기존 경로로 넘어간 일). 경고가 있으면 자동 발행하지 않는다 */
  warnings: string[];
  /** make.ts 토큰 합계에 더할 값(편집 키트 합성까지 포함) */
  tokens: { input: number; output: number };
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
  board: Storyboard;
  /** 장면표를 쓸 때 정리한 소재 수 — 제작 방식 선택이 참고한다 */
  sources: LemoSources;
  workDir: string;
  reviewFinal: KitInput["reviewFinal"];
}): Promise<LemoAttempt> {
  const { service, board } = input;
  const out = join(input.workDir, "lemo");
  mkdirSync(out, { recursive: true });
  // 0055 전이면 칸이 없어 오류가 난다. 선호 스타일은 기본값일 뿐이라 비워 두고 이어 간다
  const prefs = await (service as unknown as SupabaseClient).from("account_concepts").select("lemo_preferred_styles").eq("social_account_id", input.accountId).maybeSingle();
  if (prefs.error) console.warn(`  [lemo] 선호 스타일을 읽지 못해 비워 둠: ${prefs.error.message}`);
  const preferred = (prefs.data as { lemo_preferred_styles?: string[] } | null)?.lemo_preferred_styles ?? [];
  const accountKey = input.account.replace(/^@/, "").toLowerCase();

  const ledger = new UsageLedger();
  const warnings: string[] = [];
  let fallback: string | null = null;
  let outcome: Awaited<ReturnType<typeof runLemoJob>> | null = null;
  try {
    outcome = await runLemoJob(
      {
        mode: "plan",
        out,
        account: { accountKey, accountName: input.account, notes: input.concept.autoNotes || null, voiceId: input.concept.autoVoiceId, preferredStyles: preferred },
        facts: input.facts,
        rules: input.rules,
        script: board.scenes.map((s) => s.say),
        // 사진 컷 경로와 같게 읽는 원고(tts)로 음성을 만든다
        speech: board.scenes.map((s) => s.tts || s.say),
        hook: { spoken: board.hook.spoken, on_screen: board.hook.on_screen },
        sources: input.sources,
        tone: input.concept.autoNotes || null,
        service: input.dryRun ? null : service,
        readService: service,
        planId: input.planId,
        reviewFinal: input.reviewFinal,
      },
      ledger,
    );
    if (!outcome.final || !outcome.kit) {
      fallback = `제작 방식 선택: ${outcome.choice?.backend ?? "?"} — ${outcome.choice?.reason ?? ""}`.slice(0, 300);
      console.log(`  [lemo] ${fallback} → 사진 · 스톡 컷으로 만든다`);
    } else {
      warnings.push(...outcome.review.map((r) => `lemo 검수: ${r}`.slice(0, 300)));
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    fallback = `lemo 실패: ${message}`.slice(0, 300);
    console.warn(`  [lemo] 실패 → 사진 · 스톡 컷으로 만든다: ${message}`);
    warnings.push(`lemo 코드 애니메이션으로 만들지 못해 사진 · 스톡 컷으로 만들었어요. (${message})`.slice(0, 300));
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
      fallback,
      usage: { totals: usage.totals, cost: usage.cost },
    },
    warnings,
    tokens,
  };
}
