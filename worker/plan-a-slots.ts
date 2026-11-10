// .env.local 로드는 다른 어떤 import보다 먼저 (dev 전용 — GitHub Actions에선 no-op).
import "./load-env";

import { loadAccountConcept } from "@/lib/agents/concept";
import { planShootIdeas } from "@/lib/agents/plan-a";
import type { ProductScope } from "@/lib/agents/select";
import { kstDate } from "@/lib/automation/time";
import { mustOk } from "@/lib/supabase/result";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";

// ─────────────────────────────────────────────────────────────────────────────
// 직접 촬영 기획 워커 — 촬영 설정에서 켠 계정(track_settings.shoot_enabled)의 기획 목록을 계정당 5개로 유지한다.
// 날짜 · 시각은 없다. 사람은 찍을 수 있을 때 "촬영 기획 고르기"에서 고른다(2026-11-04 사용자 결정).
//
// 1. 정리: 판매 중이 아니거나 쓸 수 없게 된 상품의 기획, 14일 동안 안 고른 기획을 목록에서 뺀다(건너뜀으로 남긴다).
//    대본 초안이 없는 기획은 사람이 보고 고를 수 없어 지우고 새로 만든다(같은 상품을 다시 낼 수 있게 건너뜀으로 남기지 않는다)
// 2. 채우기: 계정마다 모자란 만큼만 AI가 기획한다. 5개가 다 있으면 AI를 부르지 않는다
//
// 옵션: --dry-run (DB에 안 씀) · --account <display_name>
// ─────────────────────────────────────────────────────────────────────────────

const LIST_SIZE = 5;
const KEEP_DAYS = 14;

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
}

type Service = ReturnType<typeof createServiceClient>;

/** 목록 정리 — 뺀 개수를 돌려준다. */
async function tidyList(service: Service, accountId: string, dryRun: boolean): Promise<number> {
  const { data, error } = await service
    .from("content_plans")
    .select("id, created_at, proposal, products(stock_status, excluded, analysis_state)")
    .eq("social_account_id", accountId)
    .eq("track", "A")
    .eq("status", "PROPOSED");
  if (error) throw new Error(`기획 목록 조회 실패: ${error.message}`);

  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  const notSelling: string[] = [];
  const old: string[] = [];
  const noDraft: string[] = [];
  for (const p of data ?? []) {
    const product = p.products;
    if (!(p.proposal as { ideas?: { draft?: unknown }[] } | null)?.ideas?.[0]?.draft) {
      noDraft.push(p.id);
      continue;
    }
    if (!product || product.stock_status !== "available" || product.excluded || product.analysis_state !== "ready") notSelling.push(p.id);
    else if (Date.parse(p.created_at) < cutoff) old.push(p.id);
  }
  if (!dryRun) {
    // 뒤의 "모자란 개수"가 이 정리에 기댄다 — 실패하면 그 계정만 실패로 남는다(main의 계정별 catch)
    if (noDraft.length) mustOk(await service.from("content_plans").delete().in("id", noDraft).eq("status", "PROPOSED"), `초안 없는 기획 삭제 (account=${accountId})`);
    if (notSelling.length) mustOk(await service.from("content_plans").update({ status: "SKIPPED", note: "판매 중이 아니게 돼 목록에서 뺐어요" }).in("id", notSelling).eq("status", "PROPOSED"), `판매 중 아닌 기획 빼기 (account=${accountId})`);
    if (old.length) mustOk(await service.from("content_plans").update({ status: "SKIPPED", note: `${KEEP_DAYS}일 동안 고르지 않아 새 기획으로 바꿨어요` }).in("id", old).eq("status", "PROPOSED"), `오래된 기획 빼기 (account=${accountId})`);
  }
  return notSelling.length + old.length + noDraft.length;
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const onlyAccount = arg(argv, "--account");
  const service = createServiceClient();

  const { data: settings, error } = await service
    .from("track_settings")
    .select("social_account_id, organization_id, product_scopes, repeat_gap_days, social_accounts!inner(display_name, role_focus, role_note, is_active, disconnected_at)")
    .eq("shoot_enabled", true)
    .order("social_account_id");
  if (error) throw new Error(`track_settings 조회 실패: ${error.message}`);

  let created = 0;
  // 앞 계정이 이번 실행에서 고른 상품 — 다음 계정 후보에서 뺀다
  const picked = new Set<string>();
  for (const st of settings ?? []) {
    const acc = st.social_accounts;
    if (!acc.is_active || acc.disconnected_at) continue;
    if (onlyAccount && acc.display_name !== onlyAccount) continue;
    const scopes = (st.product_scopes ?? []) as ProductScope[];
    if (scopes.length === 0) {
      console.log(`[plan-a] @${acc.display_name}: 쓸 상품이 없어 건너뜀`);
      continue;
    }

    try {
      const removed = await tidyList(service, st.social_account_id, dryRun);
      if (removed) console.log(`[plan-a] @${acc.display_name}: 목록에서 ${removed}개 뺌`);

      const { count, error: countErr } = await service
        .from("content_plans")
        .select("id", { count: "exact", head: true })
        .eq("social_account_id", st.social_account_id)
        .eq("track", "A")
        .eq("status", "PROPOSED");
      if (countErr) throw new Error(countErr.message);
      const need = LIST_SIZE - (count ?? 0);
      if (need <= 0) {
        console.log(`[plan-a] @${acc.display_name}: 목록 ${count}개, 채울 것 없음`);
        continue;
      }

      const concept = await loadAccountConcept(service, st.social_account_id);
      const result = await planShootIdeas(
        {
          service,
          concept: [
            concept.shootConcept,
            concept.shootTone && `말투 · 분위기: ${concept.shootTone}`,
            // 사람이 저장한 후킹 문구 — 초안 첫 문장도 이 틀을 따라야 고른 뒤 컷 리스트와 어긋나지 않는다
            concept.shootHooks.length > 0 && `저장한 후킹 문구(draft.hook은 이 중 하나의 틀을 쓰고 중괄호만 채운다): ${concept.shootHooks.join(" / ")}`,
          ]
            .filter(Boolean)
            .join("\n"),
          accountId: st.social_account_id,
          accountName: acc.display_name ?? "",
          roleFocus: concept.shootRole,
          roleNote: acc.role_note,
          scopes,
          repeatGapDays: st.repeat_gap_days,
          slotDate: kstDate(0),
          slotTimes: [],
          alsoBlocked: picked,
          shootPlanning: true,
          count: need,
        },
        { log: !dryRun },
      );

      const { data: names } = await service.from("products").select("id, name").in("id", result.output.ideas.map((i) => i.product_id));
      const nameOf = new Map((names ?? []).map((n) => [n.id, n.name]));
      console.log(`[plan-a] @${acc.display_name} ${need}개 요청 → ${result.output.ideas.length}개 — 스킬 ${result.skillCalls.length}번 · 토큰 입력 ${result.tokens.input} · 출력 ${result.tokens.output}`);
      for (const i of result.output.ideas) {
        picked.add(i.product_id);
        console.log(`  · [${i.format}] ${i.title} — ${nameOf.get(i.product_id) ?? i.product_id}\n    ${i.concept}\n    이유: ${i.why}\n    첫 문장: ${i.draft.hook}`);
        for (const b of i.draft.beats) console.log(`      - ${b.scene}: ${b.line}`);
      }

      if (!dryRun && result.output.ideas.length) {
        const { error: insErr } = await service.from("content_plans").insert(
          result.output.ideas.map((idea) => ({
            organization_id: st.organization_id,
            social_account_id: st.social_account_id,
            track: "A",
            status: "PROPOSED",
            product_id: idea.product_id,
            proposal: { ideas: [idea], chosen: null, agentRunId: result.runId } as unknown as Json,
          })),
        );
        if (insErr) throw new Error(`content_plans 저장 실패: ${insErr.message}`);
        created += result.output.ideas.length;
      }
    } catch (err) {
      process.exitCode = 1;
      console.error(`[plan-a] @${acc.display_name} 실패:`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`[plan-a] 완료${dryRun ? " (dry-run, 저장 안 함)" : ` · 기획 ${created}개 추가`}`);
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("[plan-a] 치명적 오류:", err);
    process.exit(1);
  });
