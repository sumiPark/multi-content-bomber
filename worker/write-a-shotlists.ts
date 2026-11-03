// .env.local 로드는 다른 어떤 import보다 먼저 (dev 전용 — GitHub Actions에선 no-op).
import "./load-env";

import { checkScript, type CheckResult } from "@/lib/agents/check";
import { scoreHooks } from "@/lib/agents/ko-skills";
import { loadProductFacts } from "@/lib/agents/product-facts";
import type { PlanAIdea } from "@/lib/agents/plan-a";
import { shotlistAsScript, writeShotlist, type ShotlistOutput } from "@/lib/agents/shotlist";
import { kstDate } from "@/lib/automation/time";
import { shootDueIso } from "@/lib/schedule/slot-admin";
import type { ContentRule } from "@/lib/rules/check";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";

// ─────────────────────────────────────────────────────────────────────────────
// 직접 촬영 컷 리스트 워커 — 사람이 기획을 고르거나 상품을 직접 지정한(CONFIRMED) A 칸마다
//   기획 · 글 에이전트(2)가 컷 리스트 · 화면 문구 · 대사 · 캡션을 쓰고 → 점검 에이전트(4)가 검사한다.
//   걸리면 한 번 다시 쓴다. 그래도 걸린 항목은 막지 않고 촬영 화면에 "고칠 것"으로 보여 준다
//   (사람이 찍고 완성본을 확인하는 칸이라 — 완성본 확인 때 다시 검사해 걸리면 확인이 잠긴다).
//   끝나면 SCRIPTED + shoot_requests(촬영 요청) 생성.
//
// 옵션: --dry-run (DB에 안 씀) · --plan <id> (그 칸만, dry-run이면 상태 무관)
// ─────────────────────────────────────────────────────────────────────────────

const MAX_REWRITES = 1;

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
}

/** 촬영 마감(안내용) — 올리기 3시간 전(편성표에서 시각을 바꿀 수 있어 칸 시각 기준). 이미 지났으면 없음. */
function shootDue(slotDate: string, slotTime: string): string | null {
  const due = shootDueIso(slotDate, slotTime);
  return Date.parse(due) > Date.now() ? due : null;
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
    .select("id, organization_id, social_account_id, slot_date, slot_time, status, product_id, proposal, human_brief, social_accounts(display_name, role_focus, role_note)")
    .eq("track", "A")
    .order("slot_date")
    .order("slot_time");
  q = onlyPlan ? q.eq("id", onlyPlan) : q.eq("status", "CONFIRMED").gte("slot_date", kstDate(0));
  const { data: plans, error } = await q;
  if (error) throw new Error(error.message);
  if (!plans?.length) {
    console.log("[a-shotlist] 컷 리스트를 쓸 칸 없음");
    return;
  }

  for (const plan of plans) {
    if (!plan.product_id) continue;
    const acc = plan.social_accounts;
    const label = `@${acc?.display_name} ${plan.slot_date} ${plan.slot_time}`;
    try {
      const facts = await loadProductFacts(service, plan.product_id);
      if (facts.stockStatus !== "available") {
        console.log(`[a-shotlist] ${label} ${facts.name} — 판매 중이 아니라 멈춤 (${facts.stockStatus})`);
        if (!dryRun) {
          await service
            .from("content_plans")
            .update({
              status: "BLOCKED",
              check_result: { passed: false, issues: [{ kind: "stock", detail: `지금 판매 중이 아님 (${facts.stockStatus})` }] } as unknown as Json,
              note: "고른 뒤 판매 중이 아니게 돼서 촬영 목록을 만들지 않았어요. 다른 기획을 고르거나 건너뛰세요.",
            })
            .eq("id", plan.id);
        }
        continue;
      }

      const proposal = (plan.proposal ?? {}) as { ideas?: PlanAIdea[]; chosen?: number | null };
      const chosen = proposal.chosen != null ? proposal.ideas?.[proposal.chosen] : undefined;
      const idea = chosen && chosen.product_id === plan.product_id ? { title: chosen.title, format: chosen.format, concept: chosen.concept } : null;

      let shotlist: ShotlistOutput | null = null;
      let check: CheckResult | null = null;
      let fixRequests: string[] | undefined;
      let tokens = 0;
      for (let attempt = 0; attempt <= MAX_REWRITES; attempt++) {
        const res = await writeShotlist(
          {
            service,
            planId: plan.id,
            accountName: acc?.display_name ?? "",
            roleFocus: acc?.role_focus ?? null,
            roleNote: acc?.role_note ?? null,
            slotTime: plan.slot_time,
            facts,
            rules,
            idea,
            brief: plan.human_brief,
            fixRequests,
          },
          { log: !dryRun },
        );
        shotlist = res.output;
        tokens += res.tokens.input + res.tokens.output;
        const seconds = shotlist.cuts.reduce((sum, c) => sum + c.seconds, 0);
        check = await checkScript(shotlistAsScript(shotlist), facts, rules, acc?.display_name ?? "", { track: "A", seconds });
        tokens += check.tokens.input + check.tokens.output;
        console.log(`[a-shotlist] ${label} ${facts.name} — ${attempt + 1}번째: ${check.passed ? "통과" : `걸림 ${check.issues.length}건`} (스킬 ${res.skillCalls.length}번)`);
        if (check.passed) break;
        fixRequests = check.issues.map((i) => i.detail);
      }
      if (!shotlist || !check) continue;

      const hookScores = scoreHooks(shotlist.hooks.map((h) => h.spoken));
      const saved = { ...shotlist, hooks: shotlist.hooks.map((h, i) => ({ ...h, score: hookScores[i]?.score ?? null })) };

      console.log(`  훅: ${shotlist.hooks[shotlist.chosen_hook]?.spoken}`);
      for (const [i, c] of shotlist.cuts.entries()) {
        console.log(`  ${i + 1}. ${c.seconds}초 ${c.shot} — ${c.how}${c.on_screen ? `  [${c.on_screen}]` : ""}${c.voice ? `  "${c.voice}"` : ""}`);
      }
      console.log(`  캡션: ${shotlist.caption.text.replace(/\n+/g, " / ").slice(0, 160)}`);
      console.log(`  점수: 훅 ${check.scores.hook} · 말투 ${check.scores.humanScore} · ${check.scores.seconds?.toFixed(1)}초 · 캡션 ${check.scores.caption} · 토큰 ${tokens}`);
      for (const i of check.issues) console.log(`  ✗ ${i.detail}`);

      if (!dryRun) {
        const { error: upErr } = await service
          .from("content_plans")
          .update({
            status: "SCRIPTED",
            script: saved as unknown as Json,
            check_result: { ...check, checkedAt: new Date().toISOString() } as unknown as Json,
            error: null,
            note: check.passed ? null : "컷 리스트 점검에서 걸린 게 있어요. 찍을 때 화면 문구 · 대사를 고쳐 주세요.",
          })
          .eq("id", plan.id);
        if (upErr) throw new Error(upErr.message);
        const { error: srErr } = await service.from("shoot_requests").upsert(
          {
            organization_id: plan.organization_id,
            plan_id: plan.id,
            status: "OPEN",
            cuts: shotlist.cuts.map((c, i) => ({ no: i + 1, ...c, done: false })) as unknown as Json,
            clips: [] as unknown as Json,
            due_at: shootDue(plan.slot_date, plan.slot_time),
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
