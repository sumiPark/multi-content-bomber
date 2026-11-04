// .env.local 로드는 다른 어떤 import보다 먼저 (dev 전용 — GitHub Actions에선 no-op).
import "./load-env";

import { planShootIdeas } from "@/lib/agents/plan-a";
import type { ProductScope } from "@/lib/agents/select";
import { isPastSlot } from "@/lib/automation/deadline";
import { kstDate, kstToIso } from "@/lib/automation/time";
import { SHOOT_LEAD_HOURS } from "@/lib/schedule/slot-admin";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";

// ─────────────────────────────────────────────────────────────────────────────
// 직접 촬영 기획 워커 — 직접 촬영 칸(편성표)마다 기획안 후보 2~3개를 content_plans(track A)에 남긴다.
// 사람은 "촬영 기획 고르기" 화면에서 고르거나 상품을 직접 지정한다. 비어 있는 칸만 채우므로,
// 화면의 "다시 만들기"는 그 칸의 제안을 지우고 이 워커를 다시 부른다.
//
// 날짜를 안 주면 오늘 ~ 모레의 빈 칸을 채운다(2026-11-04). 예전엔 늘 "내일"만 채워서, "다시 만들기" 실행이
// 같은 워크플로 대기열에서 다른 실행(컷 리스트)에 밀려 취소되면 지운 칸이 다시 채워지지 않았다. 이제 어느 실행이든
// 빈 칸을 채운다. 촬영할 시간이 없는 칸(올리기 SHOOT_LEAD_HOURS + 1시간 안)은 채우지 않는다.
//
// 먼저 올릴 시각이 지났는데 확인까지 못 간 칸을 건너뜀으로 정리한다(사람이 안 찍었으면 그 칸은 비운다).
//
// 옵션: --dry-run (DB에 안 씀) · --date YYYY-MM-DD (기본 오늘 ~ 모레 빈 칸) · --account <display_name>
// ─────────────────────────────────────────────────────────────────────────────

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
}

// 이 상태에서 올릴 시각이 지나면 건너뜀 — 아직 사람 확인(완성본)까지 못 간 칸
const UNFINISHED = ["PROPOSED", "CONFIRMED", "SCRIPTED", "SHOT", "RENDERED", "BLOCKED"];

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const onlyDate = arg(argv, "--date");
  const dates = onlyDate ? [onlyDate] : [kstDate(0), kstDate(1), kstDate(2)];
  // 촬영 · 편집 · 확인할 시간이 남은 칸만 — 올리기 SHOOT_LEAD_HOURS + 1시간 전까지
  const leadMs = (SHOOT_LEAD_HOURS + 1) * 3_600_000;
  const plannable = (date: string, time: string) => Date.parse(kstToIso(date, time)) - Date.now() > leadMs;
  const onlyAccount = arg(argv, "--account");
  const service = createServiceClient();

  if (!dryRun) {
    const { data: open } = await service
      .from("content_plans")
      .select("id, slot_date, slot_time")
      .eq("track", "A")
      .in("status", UNFINISHED)
      .lte("slot_date", kstDate(0));
    const expired = (open ?? []).filter((p) => isPastSlot(p.slot_date, p.slot_time));
    if (expired.length) {
      const ids = expired.map((p) => p.id);
      await service.from("content_plans").update({ status: "SKIPPED", note: "올릴 시각까지 완성본 확인이 안 돼 건너뜀" }).in("id", ids);
      await service
        .from("shoot_requests")
        .update({ status: "CANCELLED" })
        .in("plan_id", ids)
        .in("status", ["OPEN", "UPLOADED", "EDITING", "EDITED", "FAILED"]);
      console.log(`[plan-a] 올릴 시각 지난 칸 ${expired.length}개 건너뜀`);
    }
  }

  const { data: settings, error } = await service
    .from("track_settings")
    .select("social_account_id, organization_id, product_scopes, repeat_gap_days, social_accounts!inner(display_name, role_focus, role_note, is_active, disconnected_at)");
  if (error) throw new Error(`track_settings 조회 실패: ${error.message}`);

  let created = 0;
  for (const slotDate of dates) {
  const picked = new Set<string>();
  for (const st of settings ?? []) {
    const acc = st.social_accounts;
    if (!acc.is_active || acc.disconnected_at) continue;
    if (onlyAccount && acc.display_name !== onlyAccount) continue;
    const scopes = (st.product_scopes ?? []) as ProductScope[];
    if (scopes.length === 0) continue;

    const [{ data: slots }, { data: existing }] = await Promise.all([
      service.from("slot_rules").select("slot_time, topic").eq("social_account_id", st.social_account_id).eq("track", "A").eq("active", true),
      service.from("content_plans").select("slot_time, product_id").eq("social_account_id", st.social_account_id).eq("slot_date", slotDate),
    ]);
    for (const e of existing ?? []) if (e.product_id) picked.add(e.product_id);
    const taken = new Set((existing ?? []).map((e) => e.slot_time));
    const slotTimes = (slots ?? [])
      .map((s) => s.slot_time)
      .filter((t) => !taken.has(t) && plannable(slotDate, t))
      .sort();
    if (slotTimes.length === 0) {
      if (onlyDate) console.log(`[plan-a] @${acc.display_name}: ${slotDate} 채울 직접 촬영 칸 없음`);
      continue;
    }

    try {
      const result = await planShootIdeas(
        {
          service,
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
        .in("id", result.output.slots.flatMap((s) => s.ideas.map((i) => i.product_id)));
      const nameOf = new Map((names ?? []).map((n) => [n.id, n.name]));

      console.log(`[plan-a] @${acc.display_name} ${slotDate} — 스킬 ${result.skillCalls.length}번 · 토큰 입력 ${result.tokens.input} · 출력 ${result.tokens.output}`);
      for (const s of result.output.slots) {
        console.log(`  ${s.slot_time}`);
        for (const i of s.ideas) {
          picked.add(i.product_id);
          console.log(`    · [${i.format}] ${i.title} — ${nameOf.get(i.product_id) ?? i.product_id}\n      ${i.concept}\n      이유: ${i.why}`);
        }
      }
      const missing = slotTimes.filter((t) => !result.output.slots.some((s) => s.slot_time === t));
      if (missing.length) console.log(`  후보 부족으로 비운 칸: ${missing.join(", ")}`);

      if (!dryRun && result.output.slots.length) {
        const { error: insErr } = await service.from("content_plans").insert(
          result.output.slots.map((s) => ({
            organization_id: st.organization_id,
            social_account_id: st.social_account_id,
            slot_date: slotDate,
            slot_time: s.slot_time,
            track: "A",
            status: "PROPOSED",
            // 첫 후보를 기본값으로 — 같은 날 다른 계정 후보에서 빠지게(사람이 고르면 바뀐다)
            product_id: s.ideas[0].product_id,
            proposal: { ideas: s.ideas, agentRunId: result.runId } as unknown as Json,
          })),
        );
        if (insErr) throw new Error(`content_plans 저장 실패: ${insErr.message}`);
        created += result.output.slots.length;
      }
    } catch (err) {
      process.exitCode = 1;
      console.error(`[plan-a] @${acc.display_name} 실패:`, err instanceof Error ? err.message : err);
    }
  }
  }
  console.log(`[plan-a] 완료 ${dates.join(", ")}${dryRun ? " (dry-run, 저장 안 함)" : ` · 칸 ${created}개 기획`}`);
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("[plan-a] 치명적 오류:", err);
    process.exit(1);
  });
