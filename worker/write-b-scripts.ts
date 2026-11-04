// .env.local 로드는 다른 어떤 import보다 먼저 (dev 전용 — GitHub Actions에선 no-op).
import "./load-env";

import { loadAccountConcept } from "@/lib/agents/concept";
import { applyToScript, dropFailedPhrases, fixedPhraseBlock, fixedRecord, preparePhrases, recentTemplates } from "@/lib/agents/fixed-phrases";
import { checkScript, type CheckResult } from "@/lib/agents/check";
import { scoreHooks } from "@/lib/agents/ko-skills";
import { loadProductFacts } from "@/lib/agents/product-facts";
import { writeScript, type ScriptOutput } from "@/lib/agents/script";
import { kstDate } from "@/lib/automation/time";
import type { ContentRule } from "@/lib/rules/check";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";

// ─────────────────────────────────────────────────────────────────────────────
// AI 자동 업로드 대본 워커 — 사람이 상품을 확인한(CONFIRMED) 칸마다
//   기획 · 글 에이전트(2)가 대본 · 화면 문구 · 캡션을 쓰고 → 점검 에이전트(4)가 검사한다.
//   걸리면 지적 사항을 넘겨 한 번 다시 쓰고, 또 걸리면 BLOCKED로 멈춘다(알림은 3-5).
//   통과하면 SCRIPTED — 영상 만들기(3-2)를 기다린다.
//
// 옵션: --dry-run (DB에 안 씀) · --plan <id> (그 칸만, dry-run이면 상태 무관)
// ─────────────────────────────────────────────────────────────────────────────

const MAX_REWRITES = 1;

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const onlyPlan = arg(argv, "--plan");
  const service = createServiceClient();

  const { data: ruleRows } = await service
    .from("content_rules")
    .select("id, scope, rule_type, phrase, match_type, reason, suggestion")
    .eq("active", true);
  const rules: ContentRule[] = (ruleRows ?? []).map((r) => ({
    id: r.id,
    scope: r.scope as ContentRule["scope"],
    ruleType: r.rule_type as ContentRule["ruleType"],
    phrase: r.phrase,
    matchType: r.match_type as ContentRule["matchType"],
    reason: r.reason,
    suggestion: r.suggestion,
  }));

  let q = service
    .from("content_plans")
    .select("id, social_account_id, slot_date, slot_time, status, product_id, social_accounts(display_name, role_focus, role_note)")
    .eq("track", "B")
    .order("slot_date")
    .order("slot_time");
  q = onlyPlan ? q.eq("id", onlyPlan) : q.eq("status", "CONFIRMED").gte("slot_date", kstDate(0));
  const { data: plans, error } = await q;
  if (error) throw new Error(error.message);
  if (!plans?.length) {
    console.log("[b-script] 대본을 쓸 칸 없음 (확인된 칸이 없다)");
    return;
  }

  for (const plan of plans) {
    if (!plan.product_id) continue;
    const acc = plan.social_accounts;
    const label = `@${acc?.display_name} ${plan.slot_date} ${plan.slot_time}`;
    try {
      const facts = await loadProductFacts(service, plan.product_id);
      // 판매 중이 아니면 대본을 쓰지 않고 멈춘다(확인한 뒤 품절로 바뀔 수 있다 — AI 비용을 아낀다).
      if (facts.stockStatus !== "available") {
        console.log(`[b-script] ${label} ${facts.name} — 판매 중이 아니라 멈춤 (${facts.stockStatus})`);
        if (!dryRun) {
          await service
            .from("content_plans")
            .update({
              status: "BLOCKED",
              check_result: { passed: false, issues: [{ kind: "stock", detail: "지금 판매 중이 아닌 상품이에요" }] } as unknown as Json,
              note: "확인한 뒤 판매 중이 아니게 돼서 만들지 않았어요. 다른 상품으로 바꾸거나 건너뛰세요.",
            })
            .eq("id", plan.id)
            .eq("status", "CONFIRMED")
            .eq("product_id", plan.product_id);
        }
        continue;
      }
      const concept = await loadAccountConcept(service, plan.social_account_id);
      const hasPhrases = concept.autoHooks.length > 0 || concept.autoEndings.length > 0;
      const phrases = await preparePhrases({
        facts,
        rules,
        hooks: concept.autoHooks,
        endings: concept.autoEndings,
        recent: hasPhrases ? await recentTemplates(service, plan.social_account_id, "B", kstDate(-14)) : [],
      });
      let script: ScriptOutput | null = null;
      let check: CheckResult | null = null;
      let fixRequests: string[] | undefined;
      let tokens = phrases.tokens.input + phrases.tokens.output;
      let maxAttempts = MAX_REWRITES;

      for (let attempt = 0; attempt <= maxAttempts; attempt++) {
        const res = await writeScript(
          {
            service,
            planId: plan.id,
            accountName: acc?.display_name ?? "",
            roleFocus: acc?.role_focus ?? null,
            roleNote: acc?.role_note ?? null,
            slotTime: plan.slot_time as string,
            facts,
            rules,
            concept: concept.autoConcept,
            tone: concept.autoTone,
            videoStyle: concept.autoVideoStyle,
            phraseBlock: fixedPhraseBlock(phrases),
            fixRequests,
          },
          { log: !dryRun },
        );
        script = applyToScript(res.output, phrases);
        tokens += res.tokens.input + res.tokens.output;
        check = await checkScript(script, facts, rules, acc?.display_name ?? "", { fixedHook: phrases.hooks.length > 0, fixedTexts: [phrases.hooks[0]?.text, phrases.endings[0]?.text].filter((t): t is string => !!t) });
        tokens += check.tokens.input + check.tokens.output;
        console.log(`[b-script] ${label} ${facts.name} — ${attempt + 1}번째: ${check.passed ? "통과" : `걸림 ${check.issues.length}건`} (스킬 ${res.skillCalls.length}번)`);
        if (check.passed) break;
        // 고정 문구가 걸렸으면 글자를 고칠 수 없으니 다음 문구로 한 번 더 쓴다(최대 3번 더)
        if (dropFailedPhrases(phrases, check.issues) && maxAttempts < MAX_REWRITES + 3) maxAttempts++;
        fixRequests = check.issues.map((i) => i.detail);
      }
      if (!script || !check) continue;

      // 저장할 때 훅 점수를 다시 붙인다 (화면에서 보여 줄 근거)
      const hookScores = scoreHooks(script.hooks.map((h) => h.spoken));
      const saved = {
        ...script,
        hooks: script.hooks.map((h, i) => ({ ...h, score: hookScores[i]?.score ?? null })),
        ...(hasPhrases ? { fixed: fixedRecord(phrases) } : {}),
      };

      console.log(`  훅: ${script.beats[0]?.spoken}`);
      for (const b of script.beats.slice(1)) console.log(`  · ${b.spoken}${b.on_screen ? `  [${b.on_screen}]` : ""}`);
      console.log(`  캡션: ${script.caption.text.replace(/\n+/g, " / ").slice(0, 160)}`);
      console.log(`  점수: 훅 ${check.scores.hook} · 말투 ${check.scores.humanScore} · ${check.scores.seconds?.toFixed(1)}초 · 캡션 ${check.scores.caption} · 토큰 ${tokens}`);
      for (const i of check.issues) console.log(`  ✗ ${i.detail}`);

      if (!dryRun) {
        // 쓰는 사이 사람이 건너뛰었거나 다른 상품으로 바꿨으면 저장하지 않는다(2026-11-04, 예전엔 덮어썼다)
        const { data: savedRows, error: upErr } = await service
          .from("content_plans")
          .update({
            status: check.passed ? "SCRIPTED" : "BLOCKED",
            script: saved as unknown as Json,
            check_result: { ...check, checkedAt: new Date().toISOString() } as unknown as Json,
            error: null,
            note: check.passed ? null : `점검에 걸림: ${check.issues[0]?.detail ?? ""}`.slice(0, 300),
          })
          .eq("id", plan.id)
          .eq("status", "CONFIRMED")
          .eq("product_id", plan.product_id)
          .select("id");
        if (upErr) throw new Error(upErr.message);
        if (!savedRows?.length) console.log(`  쓰는 사이 칸이 바뀌어(건너뜀 · 다른 상품) 저장하지 않음`);
      }
    } catch (err) {
      process.exitCode = 1;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[b-script] ${label} 실패: ${message}`);
      if (!dryRun) await service.from("content_plans").update({ error: message.slice(0, 500) }).eq("id", plan.id);
    }
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("[b-script] 치명적 오류:", err);
    process.exit(1);
  });
