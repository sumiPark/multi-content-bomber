// .env.local 로드는 다른 어떤 import보다 먼저 (dev 전용 — GitHub Actions에선 no-op).
import "./load-env";

import { loadAccountConcept } from "@/lib/agents/concept";
import { selectProducts, type ProductScope } from "@/lib/agents/select";
import { isPastDeadline } from "@/lib/automation/deadline";
import { kstDate } from "@/lib/automation/time";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";

// ─────────────────────────────────────────────────────────────────────────────
// B 트랙 기획 워커 — 내일(KST) B 칸마다 상품 선정 에이전트(1)가 상품을 제안해 content_plans에 남긴다.
// 사람은 AI 자동 업로드 화면에서 올리는 날 오전 7시(기본)까지 확인만 하면 된다. 계정이 B 완전 자동이면
// 제안을 곧바로 CONFIRMED로 둔다(처음엔 모든 계정 꺼짐).
//
// 계정은 하나씩 차례로 — 앞 계정이 고른 상품을 다음 계정 후보에서 빼서 같은 날 겹치지 않게.
//
// 옵션: --dry-run (DB에 안 씀, 제안만 출력) · --date YYYY-MM-DD (기본 내일) · --account <display_name>
// ─────────────────────────────────────────────────────────────────────────────

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const slotDate = arg(argv, "--date") ?? kstDate(1);
  const onlyAccount = arg(argv, "--account");
  const service = createServiceClient();

  const { data: settings, error } = await service
    .from("track_settings")
    .select("social_account_id, organization_id, product_scopes, b_full_auto, b_confirm_deadline, repeat_gap_days, social_accounts!inner(display_name, role_focus, role_note, is_active, disconnected_at)");
  if (error) throw new Error(`track_settings 조회 실패: ${error.message}`);

  // 컨펌 마감이 지난 제안은 건너뜀으로 (사람이 안 봤으면 B 영상을 만들지 않는다)
  if (!dryRun) {
    const { data: open } = await service
      .from("content_plans")
      .select("id, slot_date, social_account_id")
      .eq("track", "B")
      .eq("status", "PROPOSED");
    const deadlineOf = new Map((settings ?? []).map((s) => [s.social_account_id, s.b_confirm_deadline ?? "07:00"]));
    const expired = (open ?? []).filter((p) => isPastDeadline(p.slot_date, deadlineOf.get(p.social_account_id) ?? "07:00"));
    if (expired.length) {
      await service
        .from("content_plans")
        .update({ status: "SKIPPED", note: "확인 마감이 지나 건너뛰었어요" })
        .in("id", expired.map((p) => p.id));
      console.log(`[plan-b] 마감 지난 제안 ${expired.length}개 건너뜀`);
    }
  }

  const picked = new Set<string>();
  let created = 0;
  for (const st of settings ?? []) {
    const acc = st.social_accounts;
    if (!acc.is_active || acc.disconnected_at) continue;
    if (onlyAccount && acc.display_name !== onlyAccount) continue;
    const scopes = (st.product_scopes ?? []) as ProductScope[];
    if (scopes.length === 0) continue;

    const [{ data: slots }, { data: existing }] = await Promise.all([
      service.from("slot_rules").select("slot_time, topic").eq("social_account_id", st.social_account_id).eq("track", "B").eq("active", true),
      service.from("content_plans").select("slot_time, product_id").eq("social_account_id", st.social_account_id).eq("slot_date", slotDate),
    ]);
    for (const e of existing ?? []) if (e.product_id) picked.add(e.product_id);
    const taken = new Set((existing ?? []).map((e) => e.slot_time));
    const slotTimes = (slots ?? []).map((s) => s.slot_time).filter((t) => !taken.has(t)).sort();
    if (slotTimes.length === 0) {
      console.log(`[plan-b] @${acc.display_name}: ${slotDate} B 칸이 이미 다 기획됨`);
      continue;
    }

    try {
      const concept = await loadAccountConcept(service, st.social_account_id);
      const result = await selectProducts(
        {
          service,
          concept: [concept.autoConcept, concept.autoTone && `말투 · 분위기: ${concept.autoTone}`].filter(Boolean).join("\n"),
          accountId: st.social_account_id,
          accountName: acc.display_name ?? "",
          roleFocus: acc.role_focus,
          roleNote: acc.role_note,
          scopes,
          repeatGapDays: st.repeat_gap_days,
          slotDate,
          slotTimes,
          slotTopics: Object.fromEntries((slots ?? []).filter((s) => s.topic).map((s) => [s.slot_time, s.topic as string])),
          alsoBlocked: picked,
        },
        { log: !dryRun },
      );
      const { data: names } = await service
        .from("products")
        .select("id, name")
        .in("id", result.output.picks.flatMap((p) => [p.product_id, ...p.alternatives.map((a) => a.product_id)]));
      const nameOf = new Map((names ?? []).map((n) => [n.id, n.name]));

      console.log(
        `[plan-b] @${acc.display_name} ${slotDate} — 스킬 ${result.skillCalls.length}번 · 토큰 입력 ${result.tokens.input} · 출력 ${result.tokens.output}`,
      );
      for (const p of result.output.picks) {
        picked.add(p.product_id);
        console.log(`  ${p.slot_time} ${nameOf.get(p.product_id) ?? p.product_id}\n    이유: ${p.reason}`);
        for (const a of p.alternatives) console.log(`    대안: ${nameOf.get(a.product_id) ?? a.product_id} — ${a.reason}`);
      }
      const missing = slotTimes.filter((t) => !result.output.picks.some((p) => p.slot_time === t));
      if (missing.length) console.log(`  후보 부족으로 비운 칸: ${missing.join(", ")}`);

      if (!dryRun && result.output.picks.length) {
        const { error: insErr } = await service.from("content_plans").insert(
          result.output.picks.map((p) => ({
            organization_id: st.organization_id,
            social_account_id: st.social_account_id,
            slot_date: slotDate,
            slot_time: p.slot_time,
            track: "B",
            status: st.b_full_auto ? "CONFIRMED" : "PROPOSED",
            product_id: p.product_id,
            proposal: { reason: p.reason, alternatives: p.alternatives, agentRunId: result.runId } as unknown as Json,
            ...(st.b_full_auto ? { confirmed_at: new Date().toISOString(), note: "사람 확인 없이 AI가 상품까지 정했어요" } : {}),
          })),
        );
        if (insErr) throw new Error(`content_plans 저장 실패: ${insErr.message}`);
        created += result.output.picks.length;
      }
    } catch (err) {
      process.exitCode = 1;
      console.error(`[plan-b] @${acc.display_name} 실패:`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`[plan-b] 완료 ${slotDate}${dryRun ? " (dry-run, 저장 안 함)" : ` · 기획안 ${created}개`}`);
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("[plan-b] 치명적 오류:", err);
    process.exit(1);
  });
