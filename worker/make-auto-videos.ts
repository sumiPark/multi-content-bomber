// .env.local 로드는 다른 어떤 import보다 먼저 (dev 전용 — GitHub Actions에선 no-op).
import "./load-env";

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkScript } from "@/lib/agents/check";
import { loadAccountConcept } from "@/lib/agents/concept";
import { loadProductFacts } from "@/lib/agents/product-facts";
import { writeScript } from "@/lib/agents/script";
import { makeAutoVideo, StopError, type SavedScript } from "@/lib/auto-video/make";
import { scheduleAutoVideo, type AutoVideo } from "@/lib/auto-video/publish";
import { kstDate } from "@/lib/automation/time";
import type { ContentRule } from "@/lib/rules/check";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";

// ─────────────────────────────────────────────────────────────────────────────
// AI 자동 콘텐츠 영상 워커 — 대본까지 끝난(SCRIPTED) 칸의 소재를 만들고 편집 키트로 완성본을 만든다.
//   상세페이지 사진 찾기 → 소재 에이전트 → 사진 · 도식 · 스톡 컷 → 편집 키트(직접 촬영과 같은 코드) → 최종 점검.
//   참고 내용은 자동 콘텐츠 설정(auto_*)만 읽는다. 직접 촬영의 shoot_* 값은 읽지 않는다.
//   통과하면 RENDERED. AUTO_VIDEO_PUBLISH=1이고 사람이 볼 경고가 없을 때만 바로 발행 대기열로 간다.
//
// 옵션: --dry-run (DB에 안 쓰고 결과 파일 위치만 출력) · --plan <id> (그 칸만)
// ─────────────────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 2;
const STALE_MS = 70 * 60_000;

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const onlyPlan = arg(argv, "--plan");
  const autoPublish = process.env.AUTO_VIDEO_PUBLISH === "1";
  const service = createServiceClient();

  const { data: ruleRows } = await service.from("content_rules").select("id, scope, rule_type, phrase, match_type, reason, suggestion").eq("active", true);
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
    .select("id, organization_id, social_account_id, slot_date, slot_time, status, product_id, script, video, social_accounts(display_name)")
    .eq("track", "B")
    .order("slot_date")
    .order("slot_time");
  q = onlyPlan ? q.eq("id", onlyPlan) : q.eq("status", "SCRIPTED");
  const { data: plans, error } = await q;
  if (error) throw new Error(error.message);
  if (!plans?.length) {
    console.log("[auto-video] 만들 칸 없음");
    return;
  }

  for (const plan of plans) {
    if (!plan.product_id) continue;
    const acc = plan.social_accounts?.display_name ?? "";
    const label = `@${acc} ${plan.slot_date} ${plan.slot_time}`;
    const concept = await loadAccountConcept(service, plan.social_account_id);
    // 시험(--dry-run)에서만 말투를 바꿔 설정 반영을 본다. 저장하지 않는다
    if (dryRun && process.env.TEST_AUTO_TONE?.trim()) concept.autoTone = process.env.TEST_AUTO_TONE.trim();
    // 시험(--dry-run --plan): 대본 없는 칸은 임시 대본을 써서 돌린다. 저장하지 않는다
    if (!plan.script && dryRun && onlyPlan) {
      try {
        // 실제 대본 워커처럼 점검에 걸리면 한 번 다시 쓴다
        const facts = await loadProductFacts(service, plan.product_id);
        let fixRequests: string[] | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          const res = await writeScript(
            { service, planId: plan.id, accountName: acc, roleFocus: concept.autoRole, roleNote: null, slotTime: plan.slot_time as string, facts, rules, concept: concept.autoConcept, tone: concept.autoTone, videoStyle: concept.autoVideoStyle, fixRequests },
            { log: false },
          );
          plan.script = res.output as unknown as Json;
          const check = await checkScript(res.output, facts, rules, acc);
          console.log(`  임시 대본 ${attempt + 1}번째: ${check.passed ? "통과" : `걸림 ${check.issues.map((i) => i.detail).join(" / ").slice(0, 200)}`}`);
          if (check.passed) break;
          fixRequests = check.issues.map((i) => i.detail);
        }
      } catch (e) {
        process.exitCode = 1;
        console.error(`[auto-video] ${label} 임시 대본 실패: ${e instanceof Error ? e.message : e}`);
        continue;
      }
    }
    if (!plan.script) continue;
    const prev = (plan.video ?? {}) as AutoVideo;
    // 확인한 칸은 시각이 지나도 만든다(끝나는 즉시 올라간다). 그제 이전 칸은 사람이 다시 만들라고 했을 때만 만든다
    if (!onlyPlan && !prev.remake && (plan.slot_date as string) < kstDate(-1)) {
      if (!dryRun) await service.from("content_plans").update({ status: "BLOCKED", note: "올릴 시각이 오래 지나 만들지 않았어요. 필요하면 다시 만들어 주세요." }).eq("id", plan.id).eq("status", "SCRIPTED");
      continue;
    }
    // 다른 실행이 만드는 중이면 건너뛴다. 오래됐으면 끊긴 것으로 보고 다시 만든다
    if (!onlyPlan && prev.state === "making" && prev.startedAt && Date.now() - Date.parse(prev.startedAt) < STALE_MS) continue;
    const attempts = (prev.attempts ?? 0) + 1;
    if (!dryRun && plan.status !== "SCRIPTED") {
      console.log(`[auto-video] ${label} — 대본 완료 상태가 아니라 건너뜀 (${plan.status})`);
      continue;
    }
    if (!onlyPlan && attempts > MAX_ATTEMPTS) {
      // 만드는 도중 끊긴 칸이 "만드는 중"으로 남지 않게 사람에게 넘긴다
      if (!dryRun) await service.from("content_plans").update({ status: "BLOCKED", note: "영상을 만들다 여러 번 끊겼어요. 다시 만들어 주세요." }).eq("id", plan.id).eq("status", "SCRIPTED");
      continue;
    }
    if (!dryRun) await service.from("content_plans").update({ video: { state: "making", startedAt: new Date().toISOString(), attempts } as unknown as Json, error: null }).eq("id", plan.id).eq("status", "SCRIPTED");

    const workDir = join(tmpdir(), `auto-video-${plan.id}`);
    rmSync(workDir, { recursive: true, force: true });
    mkdirSync(workDir, { recursive: true });
    const t0 = Date.now();
    try {
      console.log(`[auto-video] ${label} 시작`);
      const made = await makeAutoVideo({
        service,
        planId: plan.id,
        account: acc,
        productId: plan.product_id,
        concept,
        script: plan.script as unknown as SavedScript,
        rules,
        dryRun,
        workDir,
      });
      const { kit, check, blocking } = made;
      const seconds = Math.round((Date.now() - t0) / 1000);
      console.log(`  완성 ${kit.seconds.toFixed(1)}초 · ${seconds}초 걸림 · 토큰 입력 ${made.tokens.input} 출력 ${made.tokens.output} · ${kit.loudness} LUFS · 음성 ${kit.usedVoice} · 글자 "${kit.plan.look?.reading ?? ""}"`);
      console.log(`  소재: ${JSON.stringify(made.sources.map((s) => { const x = s as { no: number; kind: string }; return `${x.no}:${x.kind}`; }))}`);
      for (const b of kit.plan.beats) console.log(`  · ${b.tts} | ${b.captions.join(" / ")} | ${b.cuts.map((c) => `${c.clip}:${c.in}-${c.out}`).join(",")}`);
      for (const w of made.warnings) console.log(`  ! ${w}`);
      for (const b of blocking) console.log(`  ✗ ${b}`);
      for (const i of check.issues) console.log(`  ✗ ${i.detail}`);

      if (dryRun) {
        const out = arg(argv, "--out");
        if (out) {
          mkdirSync(out, { recursive: true });
          copyFileSync(kit.final, join(out, `${plan.id}.mp4`));
          copyFileSync(kit.cover, join(out, `${plan.id}.jpg`));
          writeFileSync(join(out, `${plan.id}.json`), JSON.stringify({ plan: kit.plan, sources: made.sources, warnings: made.warnings, check, blocking }, null, 1));
          console.log(`  (dry-run) 결과: ${out}`);
        }
        continue;
      }

      const base = `${plan.organization_id}/auto/${plan.id}/video-${Date.now()}`;
      const up = async (path: string, file: string, contentType: string) => {
        const { error: e } = await service.storage.from("media").upload(path, readFileSync(file), { contentType, upsert: true });
        if (e) throw new Error(`완성본 올리기 실패: ${e.message}`);
      };
      await up(`${base}.mp4`, kit.final, "video/mp4");
      await up(`${base}.jpg`, kit.cover, "image/jpeg");

      const video: AutoVideo = {
        state: "done",
        attempts,
        path: `${base}.mp4`,
        thumbnail: `${base}.jpg`,
        seconds: kit.seconds,
        warnings: made.warnings,
        sources: made.sources,
        plan: kit.plan,
        sounds: kit.sounds,
        loudness: kit.loudness,
        madeAt: new Date().toISOString(),
      };
      const passed = check.passed && blocking.length === 0;
      const issues = [...check.issues, ...blocking.map((detail) => ({ kind: "rule" as const, detail })), ...made.warnings.map((detail) => ({ kind: "edit" as const, detail }))];
      const { data: saved } = await service
        .from("content_plans")
        .update({
          status: passed ? "RENDERED" : "BLOCKED",
          video: video as unknown as Json,
          check_result: { ...check, issues, passed, checkedAt: new Date().toISOString() } as unknown as Json,
          error: null,
          note: passed ? null : `완성본 점검에 걸림: ${issues[0]?.detail ?? ""}`.slice(0, 300),
        })
        .eq("id", plan.id)
        .eq("status", "SCRIPTED")
        .eq("product_id", plan.product_id)
        .select("id");
      if (!saved?.length) {
        console.log("  만드는 사이 칸이 바뀌어(건너뜀 · 다른 상품) 결과를 버림");
        await service.storage.from("media").remove([`${base}.mp4`, `${base}.jpg`]);
        continue;
      }
      await service.from("agent_runs").insert({
        organization_id: plan.organization_id,
        agent: "edit",
        plan_id: plan.id,
        status: "success",
        model: "auto-video",
        input: { product: made.facts.name, clips: made.sources.length } as Json,
        output: { seconds: kit.seconds, took: seconds, look: kit.plan.look ?? null, sources: made.sources, warnings: made.warnings, passed } as unknown as Json,
        tokens_input: made.tokens.input,
        tokens_output: made.tokens.output,
        finished_at: new Date().toISOString(),
      });
      // 사람이 볼 경고가 있으면 자동 발행하지 않고 확인 화면에 남긴다
      if (passed && autoPublish && made.warnings.length === 0) {
        const r = await scheduleAutoVideo(service, plan.id);
        console.log(r.ok ? `  발행 대기열에 넣음 (${r.scheduledFor})` : `  발행 대기열 실패: ${r.error}`);
      }
    } catch (err) {
      process.exitCode = 1;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[auto-video] ${label} 실패: ${message}`);
      if (!dryRun) {
        const stop = err instanceof StopError || attempts >= MAX_ATTEMPTS;
        await service
          .from("content_plans")
          .update({
            ...(stop ? { status: "BLOCKED", note: `영상을 만들지 못했어요: ${message}`.slice(0, 300) } : {}),
            error: message.slice(0, 500),
            video: { state: "done", attempts } as unknown as Json,
          })
          .eq("id", plan.id)
          .eq("status", "SCRIPTED");
      }
    } finally {
      if (!dryRun || !arg(argv, "--keep")) rmSync(workDir, { recursive: true, force: true });
    }
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("[auto-video] 치명적 오류:", err);
    process.exit(1);
  });
