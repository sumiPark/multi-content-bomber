// .env.local 로드는 다른 어떤 import보다 먼저 (dev 전용 — GitHub Actions에선 no-op).
import "./load-env";

import { loadAccountConcept } from "@/lib/agents/concept";
import { applyToShotlist, dropFailedPhrases, fixedPhraseBlock, fixedRecord, preparePhrases, recentTemplates } from "@/lib/agents/fixed-phrases";
import { checkScript, type CheckResult } from "@/lib/agents/check";
import { scoreHooks } from "@/lib/agents/ko-skills";
import { loadProductFacts } from "@/lib/agents/product-facts";
import type { PlanAIdea } from "@/lib/agents/plan-a";
import { shotlistAsScript, writeShotlist, type ShotlistOutput } from "@/lib/agents/shotlist";
import { kstDate } from "@/lib/automation/time";
import type { ContentRule } from "@/lib/rules/check";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";

// ─────────────────────────────────────────────────────────────────────────────
// 직접 촬영 컷 리스트 워커 — 사람이 기획을 고르거나 상품을 직접 추가한(CONFIRMED) 기획마다
//   기획 · 글 에이전트(2)가 컷 리스트 · 화면 문구 · 대사 · 캡션을 쓰고 → 점검 에이전트(4)가 검사한다.
//   걸리면 한 번 다시 쓴다. 그래도 걸린 항목은 막지 않고 촬영 화면에 "고칠 것"으로 보여 준다
//   (사람이 찍고 완성본을 받는 기획이라 — 받기 전에 다시 검사해 걸린 내용을 사람이 확인한다).
//   끝나면 SCRIPTED + shoot_requests(촬영 요청) 생성.
//
// 옵션: --dry-run (DB에 안 씀) · --plan <id> (그 기획만, dry-run이면 상태 무관)
// ─────────────────────────────────────────────────────────────────────────────

const MAX_REWRITES = 1;

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
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
    .select("id, organization_id, social_account_id, status, product_id, proposal, human_brief, social_accounts(display_name, role_focus, role_note)")
    .eq("track", "A")
    .order("confirmed_at");
  q = onlyPlan ? q.eq("id", onlyPlan) : q.eq("status", "CONFIRMED");
  const { data: plans, error } = await q;
  if (error) throw new Error(error.message);
  if (!plans?.length) {
    console.log("[a-shotlist] 컷 리스트를 쓸 기획 없음");
    return;
  }

  for (const plan of plans) {
    if (!plan.product_id) continue;
    const acc = plan.social_accounts;
    const label = `@${acc?.display_name} ${plan.id.slice(0, 8)}`;
    try {
      const facts = await loadProductFacts(service, plan.product_id);
      if (facts.stockStatus !== "available") {
        console.log(`[a-shotlist] ${label} ${facts.name} — 판매 중이 아니라 멈춤 (${facts.stockStatus})`);
        if (!dryRun) {
          await service
            .from("content_plans")
            .update({
              status: "BLOCKED",
              check_result: { passed: false, issues: [{ kind: "stock", detail: "지금 판매 중이 아닌 상품이에요" }] } as unknown as Json,
              note: "고른 뒤 판매 중이 아니게 돼서 촬영 목록을 만들지 않았어요. 이 기획을 빼고 다른 기획을 골라 주세요.",
            })
            .eq("id", plan.id)
            .eq("status", "CONFIRMED")
            .eq("product_id", plan.product_id!);
        }
        continue;
      }

      const proposal = (plan.proposal ?? {}) as { ideas?: PlanAIdea[]; chosen?: number | null };
      const chosen = proposal.chosen != null ? proposal.ideas?.[proposal.chosen] : undefined;
      // 사람이 초안을 읽고 골랐으니 컷 리스트도 그 흐름을 따른다
      const draftText = chosen?.draft
        ? `\n사람이 읽고 고른 대본 초안 — 이 흐름과 첫 문장을 유지하고, 규칙에 걸리는 표현과 근거 없는 내용만 고친다.\n첫 문장: ${chosen.draft.hook}\n${chosen.draft.beats.map((b) => `- ${b.scene}: ${b.line}`).join("\n")}`
        : "";
      const idea = chosen && chosen.product_id === plan.product_id ? { title: chosen.title, format: chosen.format, concept: `${chosen.concept}${draftText}` } : null;

      const concept = await loadAccountConcept(service, plan.social_account_id);
      const hasPhrases = concept.shootHooks.length > 0 || concept.shootEndings.length > 0;
      const phrases = await preparePhrases({
        facts,
        rules,
        hooks: concept.shootHooks,
        endings: concept.shootEndings,
        recent: hasPhrases ? await recentTemplates(service, plan.social_account_id, "A", kstDate(-14)) : [],
      });
      let shotlist: ShotlistOutput | null = null;
      let check: CheckResult | null = null;
      let fixRequests: string[] | undefined;
      let tokens = phrases.tokens.input + phrases.tokens.output;
      let maxAttempts = MAX_REWRITES;
      for (let attempt = 0; attempt <= maxAttempts; attempt++) {
        const res = await writeShotlist(
          {
            service,
            planId: plan.id,
            accountName: acc?.display_name ?? "",
            roleFocus: acc?.role_focus ?? null,
            roleNote: acc?.role_note ?? null,
            facts,
            rules,
            idea,
            brief: plan.human_brief,
            concept: concept.shootConcept,
            tone: concept.shootTone,
            editStyle: concept.shootEditStyle,
            phraseBlock: fixedPhraseBlock(phrases),
            fixRequests,
          },
          { log: !dryRun },
        );
        shotlist = applyToShotlist(res.output, phrases, acc?.role_focus === "PERSON");
        tokens += res.tokens.input + res.tokens.output;
        const seconds = shotlist.cuts.reduce((sum, c) => sum + c.seconds, 0);
        check = await checkScript(shotlistAsScript(shotlist), facts, rules, acc?.display_name ?? "", { track: "A", seconds, fixedHook: phrases.hooks.length > 0, fixedTexts: [phrases.hooks[0]?.text, phrases.endings[0]?.text].filter((t): t is string => !!t) });
        tokens += check.tokens.input + check.tokens.output;
        console.log(`[a-shotlist] ${label} ${facts.name} — ${attempt + 1}번째: ${check.passed ? "통과" : `걸림 ${check.issues.length}건`} (스킬 ${res.skillCalls.length}번)`);
        if (check.passed) break;
        // 고정 문구가 걸렸으면 글자를 고칠 수 없으니 다음 문구로 한 번 더 쓴다(최대 3번 더)
        if (dropFailedPhrases(phrases, check.issues) && maxAttempts < MAX_REWRITES + 3) maxAttempts++;
        fixRequests = check.issues.map((i) => i.detail);
      }
      if (!shotlist || !check) continue;

      const hookScores = scoreHooks(shotlist.hooks.map((h) => h.spoken));
      const saved = {
        ...shotlist,
        hooks: shotlist.hooks.map((h, i) => ({ ...h, score: hookScores[i]?.score ?? null })),
        ...(hasPhrases ? { fixed: fixedRecord(phrases) } : {}),
      };

      console.log(`  훅: ${shotlist.hooks[shotlist.chosen_hook]?.spoken}`);
      for (const [i, c] of shotlist.cuts.entries()) {
        console.log(`  ${i + 1}. ${c.seconds}초 ${c.shot} — ${c.how}${c.on_screen ? `  [${c.on_screen}]` : ""}${c.voice ? `  "${c.voice}"` : ""}`);
      }
      console.log(`  캡션: ${shotlist.caption.text.replace(/\n+/g, " / ").slice(0, 160)}`);
      console.log(`  점수: 훅 ${check.scores.hook} · 말투 ${check.scores.humanScore} · ${check.scores.seconds?.toFixed(1)}초 · 캡션 ${check.scores.caption} · 토큰 ${tokens}`);
      for (const i of check.issues) console.log(`  ✗ ${i.detail}`);

      if (!dryRun) {
        // 쓰는 사이 사람이 다른 기획 · 상품으로 바꿨거나 건너뛰었으면 저장하지 않는다(2026-11-04, 예전엔 덮어썼다)
        const { data: savedRows, error: upErr } = await service
          .from("content_plans")
          .update({
            status: "SCRIPTED",
            script: saved as unknown as Json,
            check_result: { ...check, checkedAt: new Date().toISOString() } as unknown as Json,
            error: null,
            note: check.passed ? null : "컷 리스트 점검에서 걸린 게 있어요. 찍을 때 화면 문구 · 대사를 고쳐 주세요.",
          })
          .eq("id", plan.id)
          .eq("status", "CONFIRMED")
          .eq("product_id", plan.product_id!)
          .select("id");
        if (upErr) throw new Error(upErr.message);
        if (!savedRows?.length) {
          console.log(`  쓰는 사이 기획이 바뀌어 저장하지 않음 — 다음 실행이 새 기획으로 다시 써요`);
          continue;
        }
        const { error: srErr } = await service.from("shoot_requests").upsert(
          {
            organization_id: plan.organization_id,
            plan_id: plan.id,
            status: "OPEN",
            cuts: shotlist.cuts.map((c, i) => ({ no: i + 1, ...c, done: false })) as unknown as Json,
            clips: [] as unknown as Json,
            due_at: null,
            edit: null,
            rendered_path: null,
            error: null,
          },
          { onConflict: "plan_id" },
        );
        if (srErr) throw new Error(`촬영 요청 저장 실패: ${srErr.message}`);
      }
    } catch (err) {
      process.exitCode = 1;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[a-shotlist] ${label} 실패: ${message}`);
      if (!dryRun) await service.from("content_plans").update({ error: message.slice(0, 500) }).eq("id", plan.id);
    }
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("[a-shotlist] 치명적 오류:", err);
    process.exit(1);
  });
