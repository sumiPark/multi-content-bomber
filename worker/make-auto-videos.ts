// .env.local 로드는 다른 어떤 import보다 먼저 (dev 전용 — GitHub Actions에선 no-op).
import "./load-env";

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markArchiveUsed } from "@/lib/auto-video/archive";
import type { AutoVideoEngine } from "@/lib/auto-video/lemo";
import { loadAccountConcept } from "@/lib/agents/concept";
import { scoreHooks } from "@/lib/agents/ko-skills";
import { BoardOnlyDone, makeAutoVideo, StopError, type RedoRequest, type SavedStoryboard } from "@/lib/auto-video/make";
import { scheduleAutoVideo, type AutoVideo } from "@/lib/auto-video/publish";
import { kstDate } from "@/lib/automation/time";
import type { ContentRule } from "@/lib/rules/check";
import { warnIfError } from "@/lib/supabase/result";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";

// ─────────────────────────────────────────────────────────────────────────────
// AI 자동 콘텐츠 영상 워커 — 상품을 확인한(CONFIRMED) 칸은 장면표(대본)를 먼저 쓰고 저장한 뒤(SCRIPTED, 0054 storyboard)
//   그 장면표로 완성본을 만든다. 장면표가 저장된 칸(SCRIPTED)은 장면표 단계를 건너뛰고 영상만 만든다(끊긴 실행 이어 만들기).
//   상세페이지 사진 찾기 → 장면표 → 사진 · 도식 · 스톡 컷 → 편집 키트(직접 촬영과 같은 코드) → 최종 점검.
//   같은 칸은 making_since 조건부 UPDATE로 한 실행만 집는다.
//   참고 내용은 자동 콘텐츠 설정(auto_*)만 읽는다. 직접 촬영의 shoot_* 값은 읽지 않는다.
//   통과하면 RENDERED. AUTO_VIDEO_PUBLISH=1이고 사람이 볼 경고가 없을 때만 바로 발행 대기열로 간다.
//   영상 단계는 기본이 lemo 코드 애니메이션(lib/auto-video/lemo.ts, 2026-11-11). 제작 방식 선택이 기존 방식을 고르거나 lemo가 실패하면
//   사진 · 스톡 컷으로 만든다. 러너 변수 AUTO_VIDEO_ENGINE=kit이면 lemo를 부르지 않고 사진 · 스톡 컷만 쓴다.
//
// 옵션: --dry-run (DB에 안 쓰고 결과 파일 위치만 출력) · --plan <id> (그 칸만)
//       --board-only (--dry-run과 함께: 대본 · 장면표까지만 만들고 영상은 만들지 않는다. --out에 storyboard-review.json)
//       --saved-board (--dry-run과 함께: 칸에 저장된 장면표로 영상만 만든다. 없으면 장면표부터)
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
  const engine: AutoVideoEngine = process.env.AUTO_VIDEO_ENGINE === "kit" ? "kit" : "lemo";
  console.log(`[auto-video] 영상 제작 방식: ${engine === "lemo" ? "lemo 우선(안 되면 사진 · 스톡 컷)" : "사진 · 스톡 컷"}`);
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
    .select("id, organization_id, social_account_id, slot_date, slot_time, status, product_id, script, video, storyboard, redo, making_since, social_accounts(display_name)")
    .eq("track", "B")
    .order("slot_date")
    .order("slot_time");
  // 확인한 칸(장면표부터)과 장면표가 저장된 칸(영상만). 장면표가 없는 옛 SCRIPTED 칸은 예전처럼 처음부터 만든다
  q = onlyPlan ? q.eq("id", onlyPlan) : q.in("status", ["CONFIRMED", "SCRIPTED"]);
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
    // 시험(--dry-run)도 저장된 자동 콘텐츠 설정 그대로 만든다. 실제 생성과 같은 결과를 봐야 해서 덮어쓰기 입력을 두지 않는다(2026-11-10)
    const concept = await loadAccountConcept(service, plan.social_account_id);
    const prev = (plan.video ?? {}) as AutoVideo;
    const redo = (plan.redo ?? null) as RedoRequest | null;
    const storedBoard = (plan.storyboard as { version?: number } | null)?.version === 1 ? (plan.storyboard as unknown as SavedStoryboard) : null;
    const status = plan.status as "CONFIRMED" | "SCRIPTED";
    // 확인한 칸은 시각이 지나도 만든다(끝나는 즉시 올라간다). 그제 이전 칸은 사람이 다시 만들라고 했을 때만 만든다
    if (!onlyPlan && !prev.remake && !redo && (plan.slot_date as string) < kstDate(-1)) {
      // 실패해도 다음 실행이 같은 조건으로 다시 막는다 — 실행 전체를 멈추지 않게 경고만
      if (!dryRun) warnIfError(await service.from("content_plans").update({ status: "BLOCKED", note: "올릴 시각이 오래 지나 만들지 않았어요. 필요하면 다시 만들어 주세요." }).eq("id", plan.id).eq("status", status), `칸 막기 (plan=${plan.id})`);
      continue;
    }
    // 다른 실행이 만드는 중이면 건너뛴다. 오래됐으면 끊긴 것으로 보고 다시 만든다
    if (!onlyPlan && prev.state === "making" && prev.startedAt && Date.now() - Date.parse(prev.startedAt) < STALE_MS) continue;
    const attempts = (prev.attempts ?? 0) + 1;
    if (!dryRun && status !== "SCRIPTED" && status !== "CONFIRMED") {
      console.log(`[auto-video] ${label} — 확인 · 대본 완료 상태가 아니라 건너뜀 (${plan.status})`);
      continue;
    }
    if (!onlyPlan && attempts > MAX_ATTEMPTS) {
      // 만드는 도중 끊긴 칸이 "만드는 중"으로 남지 않게 사람에게 넘긴다
      if (!dryRun) warnIfError(await service.from("content_plans").update({ status: "BLOCKED", note: "영상을 만들다 여러 번 끊겼어요. 다시 만들어 주세요.", making_since: null }).eq("id", plan.id).eq("status", status), `칸 막기 (plan=${plan.id})`);
      continue;
    }
    // 이 칸을 집는다. 다른 실행(확인 버튼 · 정기 실행 · 다시 만들기)이 먼저 집었으면 0행이라 건너뛴다.
    // "만드는 중" · 시도 횟수를 못 남기면 유료 생성이 횟수 제한 없이 반복될 수 있어 이 칸은 건너뛴다
    if (!dryRun) {
      const startedAt = new Date().toISOString();
      const claim = await service
        .from("content_plans")
        .update({ making_since: startedAt, video: { ...(prev.remake ? { remake: true } : {}), state: "making", startedAt, attempts } as unknown as Json, error: null })
        .eq("id", plan.id)
        .eq("status", status)
        .or(`making_since.is.null,making_since.lt.${new Date(Date.now() - STALE_MS).toISOString()}`)
        .select("id");
      if (!warnIfError(claim, `만드는 중 표시 (plan=${plan.id})`)) {
        process.exitCode = 1;
        continue;
      }
      if (!claim.data?.length) {
        console.log(`[auto-video] ${label} — 다른 실행이 만드는 중이라 건너뜀`);
        continue;
      }
    }

    const workDir = join(tmpdir(), `auto-video-${plan.id}`);
    rmSync(workDir, { recursive: true, force: true });
    mkdirSync(workDir, { recursive: true });
    const t0 = Date.now();
    try {
      console.log(`[auto-video] ${label} 시작`);
      const made = await makeAutoVideo({
        service,
        planId: plan.id,
        organizationId: plan.organization_id,
        accountId: plan.social_account_id,
        account: acc,
        productId: plan.product_id,
        concept,
        rules,
        dryRun,
        workDir,
        engine,
        // 시험에서만: --board <storyboard-review.json> 으로 저장된 장면표부터 영상을 만든다
        savedBoard: dryRun && arg(argv, "--board") ? JSON.parse(readFileSync(arg(argv, "--board")!, "utf8")).board : undefined,
        boardOnly: dryRun && argv.includes("--board-only"),
        // 시험은 장면표 품질을 보려고 돌리는 경우가 많아 저장된 장면표를 쓰지 않는다. --saved-board면 실제처럼 이어 만든다
        saved: dryRun && !argv.includes("--saved-board") ? null : storedBoard,
        redo,
        // 새로 확정한 장면표를 영상보다 먼저 저장한다(SCRIPTED). 확인 화면에 대본이 바로 보이고, 끊기면 다음 실행이 이어 만든다
        onBoard: async (board, script) => {
          if (dryRun) return;
          const hookScores = scoreHooks(script.hooks.map((h) => h.spoken));
          const withScores = { ...script, hooks: script.hooks.map((h, i) => ({ ...h, score: hookScores[i]?.score ?? null })) };
          const { data: rows, error: e } = await service
            .from("content_plans")
            .update({ status: "SCRIPTED", storyboard: board as unknown as Json, script: withScores as unknown as Json, redo: null, check_result: null, note: null })
            .eq("id", plan.id)
            .in("status", ["CONFIRMED", "SCRIPTED"])
            .eq("product_id", plan.product_id!)
            .select("id");
          if (e) throw new Error(`장면표 저장 실패: ${e.message}`);
          if (!rows?.length) throw new PlanChanged();
          console.log("  장면표 저장 (SCRIPTED)");
        },
      });
      const { kit, check, blocking } = made;
      const seconds = Math.round((Date.now() - t0) / 1000);
      console.log(`  제작 방식: ${made.engine}${made.lemo?.choice?.style ? ` (${made.lemo.choice.style})` : ""}${made.lemo?.fallback ? ` — ${made.lemo.fallback}` : ""}`);
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
          // 다음 자막 보정은 음성/소재를 다시 생성하지 않고 재현할 수 있게 남긴다. 구매한 글꼴 파일은 포함하지 않는다.
          copyFileSync(join(made.kitDir, "project", "assets", "base.mp4"), join(out, `${plan.id}-base.mp4`));
          copyFileSync(join(made.kitDir, "project", "assets", "mix.wav"), join(out, `${plan.id}-mix.wav`));
          writeFileSync(join(out, `${plan.id}.json`), JSON.stringify({ engine: made.engine, lemo: made.lemo, knowledge: made.knowledge, firstViewer: made.firstViewer?.answer ?? null, firstViewerGaps: made.firstViewer?.gaps ?? null, speechRate: made.speechRate, board: made.board, plan: kit.plan, timeline: kit.timeline, sources: made.sources, warnings: made.warnings, check, blocking, quality: kit.quality, captionMode: kit.captionMode, storyboardReviews: made.storyboardReviews, phraseNotes: made.phraseNotes, voice: { used: kit.usedVoice, id: concept.autoVoiceId, model: "s2.1-pro-free" } }, null, 1));
          console.log(`  (dry-run) 결과: ${out}`);
        }
        if (!check.passed || blocking.length || !kit.quality?.passed) process.exitCode = 1;
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
        engine: made.engine,
        ...(made.lemo ? { lemo: made.lemo } : {}),
        madeAt: new Date().toISOString(),
      };
      const passed = check.passed && blocking.length === 0;
      const issues = [...check.issues, ...blocking.map((detail) => ({ kind: "rule" as const, detail })), ...made.warnings.map((detail) => ({ kind: "edit" as const, detail }))];
      const { data: saved, error: saveErr } = await service
        .from("content_plans")
        .update({
          status: passed ? "RENDERED" : "BLOCKED",
          video: video as unknown as Json,
          script: made.script as unknown as Json,
          making_since: null,
          redo: null,
          check_result: { ...check, issues, passed, checkedAt: new Date().toISOString() } as unknown as Json,
          error: null,
          note: passed ? null : `완성본 점검에 걸림: ${check.issues.find((i) => i.kind !== "tone")?.detail ?? blocking[0] ?? ""}`.slice(0, 300),
        })
        .eq("id", plan.id)
        .eq("status", "SCRIPTED")
        .eq("product_id", plan.product_id)
        .select("id");
      if (saveErr) {
        // 유료로 만든 완성본이라 throw하지 않는다(다시 만들게 될 수 있음) — 칸이 가리키지 않는 파일은 아래처럼 지운다
        process.exitCode = 1;
        console.error(`[auto-video] ${label} 완성본 저장 실패 — 칸은 대본 완료 상태로 남고 만든 영상은 버림 (plan=${plan.id}): ${saveErr.message}`);
      }
      if (!saved?.length) {
        if (!saveErr) console.log("  만드는 사이 칸이 바뀌어(건너뜀 · 다른 상품) 결과를 버림");
        await service.storage.from("media").remove([`${base}.mp4`, `${base}.jpg`]);
        continue;
      }
      await markArchiveUsed(service, (made.sources as { kind?: string; id?: string }[]).filter((s) => s.kind === "archive" && s.id).map((s) => s.id as string));
      warnIfError(
        await service.from("agent_runs").insert({
          organization_id: plan.organization_id,
          agent: "edit",
          plan_id: plan.id,
          status: "success",
          model: made.engine === "lemo" ? "auto-video:lemo" : "auto-video",
          input: { product: made.facts.name, clips: made.sources.length } as Json,
          output: { engine: made.engine, lemo: made.lemo ?? null, seconds: kit.seconds, took: seconds, look: kit.plan.look ?? null, sources: made.sources, warnings: made.warnings, passed } as unknown as Json,
          tokens_input: made.tokens.input,
          tokens_output: made.tokens.output,
          finished_at: new Date().toISOString(),
        }),
        `agent_runs 자동 영상 기록 (plan=${plan.id})`,
      );
      // 사람이 볼 경고가 있으면 자동 발행하지 않고 확인 화면에 남긴다
      if (passed && autoPublish && issues.length === 0) {
        const r = await scheduleAutoVideo(service, plan.id);
        console.log(r.ok ? `  발행 대기열에 넣음 (${r.scheduledFor})` : `  발행 대기열 실패: ${r.error}`);
      }
    } catch (err) {
      // 장면표를 쓰는 사이 사람이 건너뛰었거나 다른 상품으로 바꿨으면 아무것도 저장하지 않는다
      if (err instanceof PlanChanged) {
        console.log(`[auto-video] ${label} 쓰는 사이 칸이 바뀌어(건너뜀 · 다른 상품) 저장하지 않음`);
        if (!dryRun) warnIfError(await service.from("content_plans").update({ making_since: null }).eq("id", plan.id), `집은 표시 풀기 (plan=${plan.id})`);
        continue;
      }
      // 대본만 시험: 장면표까지 만들고 멈춘 건 실패가 아니다. 남은 문제가 있을 때만 실패로 본다
      if (err instanceof BoardOnlyDone) {
        console.log(`[auto-video] ${label} ${err.message} · ${Math.round((Date.now() - t0) / 1000)}초`);
        const out = arg(argv, "--out");
        if (out) {
          mkdirSync(out, { recursive: true });
          try { copyFileSync(join(workDir, "storyboard-review.json"), join(out, `${plan.id}-storyboard-review.json`)); } catch { /* 기록 없음 */ }
        }
        if (err.left.length) process.exitCode = 1;
        continue;
      }
      process.exitCode = 1;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[auto-video] ${label} 실패: ${message}`);
      if (dryRun && arg(argv, "--out")) {
        const out = arg(argv, "--out")!;
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, `${plan.id}-failure.json`), JSON.stringify({ error: message }, null, 2));
        for (const [name, file] of [["storyboard-review", join(workDir, "storyboard-review.json")], ["quality", join(workDir, "kit", "quality.json")]]) {
          try { copyFileSync(file, join(out, `${plan.id}-${name}.json`)); } catch { /* 이 단계 전 실패면 기록 없음 */ }
        }
      }
      if (!dryRun) {
        const stop = err instanceof StopError || attempts >= MAX_ATTEMPTS;
        warnIfError(
          await service
            .from("content_plans")
            .update({
              ...(stop ? { status: "BLOCKED", note: `영상을 만들지 못했어요: ${message}`.slice(0, 300) } : {}),
              error: message.slice(0, 500),
              making_since: null,
              video: { ...(prev.remake ? { remake: true } : {}), state: "done", attempts } as unknown as Json,
            })
            .eq("id", plan.id)
            .in("status", ["CONFIRMED", "SCRIPTED"]),
          `칸 실패 기록 (plan=${plan.id})`,
        );
      }
    } finally {
      if (!dryRun || !arg(argv, "--keep")) rmSync(workDir, { recursive: true, force: true });
    }
  }
}

/** 장면표를 쓰는 사이 칸이 건너뛰어졌거나 다른 상품으로 바뀌었다 */
class PlanChanged extends Error {}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("[auto-video] 치명적 오류:", err);
    process.exit(1);
  });
