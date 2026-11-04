// .env.local 로드는 다른 어떤 import보다 먼저 (dev 전용 — GitHub Actions에선 no-op).
import "./load-env";

import { createReadStream, createWriteStream, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { checkScript } from "@/lib/agents/check";
import { loadAccountConcept } from "@/lib/agents/concept";
import { loadProductFacts } from "@/lib/agents/product-facts";
import { agentModel } from "@/lib/agents/runner";
import { getOpenAI } from "@/lib/openai";
import type { ContentRule } from "@/lib/rules/check";
import { PACE, type EditStyle } from "@/lib/shoot/edit-style";
import { concatSegments, extractAudio, probe, renderSegment, snapshot, type SegmentSpec } from "@/lib/shoot/ffmpeg";
import { readClip, renderKitEdit, type KitClip, type KitResult } from "@/lib/shoot/video-kit/pipeline";
import { transcribeWords } from "@/lib/shoot/video-kit/tools";
import type { EditPlan } from "@/lib/agents/edit-plan";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";

// ─────────────────────────────────────────────────────────────────────────────
// 직접 촬영 편집 워커 — 편집 에이전트(3)의 촬영본 편집. 사람이 "다 올렸어요"를 누른(UPLOADED) 촬영 요청마다:
//   1. 컷마다 쓸 구간을 고른다 — 말하는 컷은 받아쓰기(whisper) 시각으로 말 앞뒤만, 아니면 앞 흔들림을 빼고 컷 길이만큼
//   2. 1080x1920으로 맞추고 화면 문구(위) · 말 자막(아래)을 입힌다 — 사람이 고친 문구가 있으면 그걸로
//   3. 이어 붙이고 소리 크기를 맞춘다.
//   편집 키트(lib/shoot/video-kit, 규칙은 .claude/skills/ig-edit-ko)가 먼저 돈다: 원본 분석 → 후킹 · 표지 → 컷 → 음성 · 자막 →
//   모션그래픽 · 효과음 · 음악. 키트가 실패하면 위 1~3의 기본 편집으로 만들고 이유를 화면에 남긴다(SHOOT_BASIC_EDIT=1이면 기본 편집만).
//   4. 실제로 들어간 문구 · 자막 · 캡션으로 점검(4)을 다시 돌린다 → 완성본 받기 화면에 보인다
//   끝나면 shoot_requests EDITED + content_plans RENDERED.
//
// FFmpeg가 필요해 GitHub Actions(.github/workflows/shoot-edit.yml)에서만 돈다.
// 옵션: --request <id> (그 요청만, 상태 무관) · --dry-run (편집만 하고 올리거나 저장하지 않음, 결과는 임시 폴더에)
// ─────────────────────────────────────────────────────────────────────────────

type Service = ReturnType<typeof createServiceClient>;

type Cut = {
  no: number;
  seconds: number;
  shot: string;
  how: string;
  on_screen: string;
  voice: string;
  narration?: string;
  // 완성본 받기에서 사람이 고친 문구 (있으면 이걸 쓴다)
  on_screen_override?: string | null;
  subtitle_override?: string | null;
  // 못 찍어서 뺀 컷 — 편집에서 건너뛴다
  skipped?: boolean;
};
type Clip = { cut: number; path: string; name: string; size: number; type: string; uploaded_by: string };
type Subtitle = { text: string; from: number; to: number };

// 촬영 버튼을 누를 때 흔들리는 앞부분
const LEAD_SKIP = 0.3;

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
}

async function download(service: Service, path: string, to: string): Promise<void> {
  const { data, error } = await service.storage.from("media").createSignedUrl(path, 3600);
  if (error || !data) throw new Error(`촬영본 링크 실패: ${error?.message}`);
  const res = await fetch(data.signedUrl);
  if (!res.ok || !res.body) throw new Error(`촬영본 받기 실패 (${res.status})`);
  await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), createWriteStream(to));
}

type Span = { text: string; start: number; end: number };

/** 말하는 컷 받아쓰기 — 문장(자막 글) + 낱말 시각(말 앞뒤 자르기). 문장 시각은 앞뒤 무음을 품어 부정확하다.
 *  대본 대사를 prompt로 줘 상품명 맞춤법을 잡는다. */
async function transcribe(file: string, hint: string): Promise<{ segments: Span[]; words: Span[] }> {
  const r = await getOpenAI().audio.transcriptions.create({
    file: createReadStream(file),
    model: "whisper-1",
    language: "ko",
    prompt: hint.slice(0, 200),
    response_format: "verbose_json",
    timestamp_granularities: ["word", "segment"],
  });
  return {
    segments: (r.segments ?? [])
      .filter((s) => (s.no_speech_prob ?? 0) < 0.6 && s.text.trim())
      .map((s) => ({ text: s.text.trim(), start: s.start, end: s.end })),
    words: (r.words ?? []).map((w) => ({ text: w.word, start: w.start, end: w.end })),
  };
}

/** 긴 문장은 32자 안팎으로 나눠 그 구간 안에서 차례로 보여 준다. */
function chunkSubtitle(text: string, from: number, to: number): Subtitle[] {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return [];
  if (t.length <= 32) return [{ text: t, from, to }];
  const words = t.split(" ");
  const parts: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > 28) {
      parts.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) parts.push(cur);
  const total = parts.reduce((s, p) => s + p.length, 0);
  let at = from;
  return parts.map((p) => {
    const d = ((to - from) * p.length) / total;
    const sub = { text: p, from: at, to: at + d };
    at += d;
    return sub;
  });
}

interface Plan {
  cutNo: number;
  input: string;
  start: number;
  duration: number;
  hasAudio: boolean;
  onScreen: string;
  subtitles: Subtitle[];
  hdrTransfer: string | null;
  // 자막 글은 점검을 위해 늘 남기고, 영상에 입힐지만 따로 — 사람이 그 컷 자막을 직접 썼으면 스타일과 상관없이 입힌다
  showSubtitles: boolean;
}

async function planCut(cut: Cut, file: string, workDir: string, speaks: boolean, style: EditStyle): Promise<Plan> {
  const info = probe(file);
  if (info.duration < 0.5) throw new Error(`${cut.no}번 컷 촬영본이 너무 짧아요 (${info.duration.toFixed(1)}초)`);
  const onScreen = (cut.on_screen_override ?? cut.on_screen ?? "").trim();
  const pace = PACE[style.pace];
  const showSubtitles = style.subtitles || !!cut.subtitle_override?.trim();

  // 말하는 컷: 받아쓰기 시각으로 말 앞뒤만 남긴다(대본 길이보다 말이 길면 말을 살린다)
  if (speaks && info.hasAudio && cut.voice.trim()) {
    const audio = join(workDir, `cut${cut.no}.mp3`);
    extractAudio(file, audio);
    const { segments: segs, words } = await transcribe(audio, cut.voice);
    if (segs.length) {
      const first = words[0]?.start ?? segs[0].start;
      const last = words[words.length - 1]?.end ?? segs[segs.length - 1].end;
      const start = Math.max(0, first - pace.lead);
      const end = Math.min(info.duration, last + pace.tail);
      // 사람이 고친 자막이 있으면 그걸로(빈 문자열 = 이 컷 자막 빼기)
      const subtitles = cut.subtitle_override != null
        ? chunkSubtitle(cut.subtitle_override, 0, end - start)
        : segs.flatMap((s) => chunkSubtitle(s.text, Math.max(first, s.start) - start, Math.min(end, s.end) - start));
      return { cutNo: cut.no, input: file, start, duration: end - start, hasAudio: true, onScreen, subtitles, hdrTransfer: info.hdrTransfer, showSubtitles };
    }
  }

  // 말 없는 컷: 앞 흔들림을 빼고 컷 길이만큼. 짧게 찍었으면 있는 만큼.
  const start = info.duration > cut.seconds + LEAD_SKIP * 2 ? LEAD_SKIP : Math.min(0.1, info.duration * 0.05);
  const duration = Math.min(cut.seconds * pace.length, info.duration - start - 0.05);
  return {
    cutNo: cut.no,
    input: file,
    start,
    duration,
    hasAudio: info.hasAudio,
    onScreen,
    subtitles: cut.subtitle_override ? chunkSubtitle(cut.subtitle_override, 0, duration) : [],
    hdrTransfer: info.hdrTransfer,
    showSubtitles,
  };
}

async function loadRules(service: Service): Promise<ContentRule[]> {
  const { data } = await service.from("content_rules").select("id, scope, rule_type, phrase, match_type, reason, suggestion").eq("active", true);
  return (data ?? []).map((r) => ({
    id: r.id,
    scope: r.scope as ContentRule["scope"],
    ruleType: r.rule_type as ContentRule["ruleType"],
    phrase: r.phrase,
    matchType: r.match_type as ContentRule["matchType"],
    reason: r.reason,
    suggestion: r.suggestion,
  }));
}

// 이 시간 넘게 EDITING이면 멈춘 것으로 보고 다시 집는다 — shoot-edit.yml timeout-minutes(30)보다 길게
const STALE_EDIT_MS = 55 * 60_000;

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const onlyRequest = arg(argv, "--request");
  const service = createServiceClient();
  const rules = await loadRules(service);

  let q = service
    .from("shoot_requests")
    .select(
      "id, organization_id, plan_id, status, updated_at, cuts, clips, edit, content_plans!inner(id, social_account_id, product_id, script, social_accounts(display_name, role_focus))",
    )
    .order("uploaded_at");
  // 편집 중(EDITING)인 채 STALE_EDIT_MS 넘게 멈춘 건 — 러너가 시간 제한 · 장애로 죽은 것 — 도 다시 집는다(2026-11-04).
  // 예전엔 다시 집을 길이 없어 "편집 중"에 영원히 남았다. 워크플로 시간 제한(30분)보다 길게 잡는다.
  const staleBefore = new Date(Date.now() - STALE_EDIT_MS).toISOString();
  q = onlyRequest ? q.eq("id", onlyRequest) : q.or(`status.eq.UPLOADED,and(status.eq.EDITING,updated_at.lt.${staleBefore})`);
  const { data: requests, error } = await q;
  if (error) throw new Error(error.message);
  if (!requests?.length) {
    console.log("[shoot-edit] 편집할 촬영 요청 없음");
    return;
  }

  for (const req of requests) {
    const plan = req.content_plans;
    const acc = plan.social_accounts;
    const label = `@${acc?.display_name} (${req.id.slice(0, 8)})`;
    // 선점 — 동시에 두 run이 같은 요청을 편집하지 않게
    if (!dryRun) {
      let claim = service.from("shoot_requests").update({ status: "EDITING", error: null }).eq("id", req.id);
      claim =
        req.status === "EDITING"
          ? claim.eq("status", "EDITING").lt("updated_at", staleBefore)
          : claim.in("status", onlyRequest ? ["UPLOADED", "EDITED", "FAILED"] : ["UPLOADED"]);
      const { data: claimed } = await claim.select("id");
      if (!claimed?.length) continue;
    }

    const workDir = join(tmpdir(), `shoot-${req.id}`);
    rmSync(workDir, { recursive: true, force: true });
    mkdirSync(workDir, { recursive: true });
    const startedAt = Date.now();
    try {
      const cuts = ((req.cuts ?? []) as Cut[]).filter((c) => !c.skipped).sort((a, b) => a.no - b.no);
      if (!cuts.length) throw new Error("편집할 컷이 없어요");
      const clips = (req.clips ?? []) as Clip[];
      const concept = await loadAccountConcept(service, plan.social_account_id);
      // 말한 소리를 고른 계정만 촬영본의 말을 쓰고, 기본은 AI 음성이다(0044). 영상 방향과 별개다
      const liveVoice = concept.shootLiveVoice;
      const speaks = liveVoice;
      const style = concept.editStyle;

      const fileOf = new Map<number, string>();
      for (const cut of cuts) {
        const clip = clips.find((c) => c.cut === cut.no);
        if (!clip) throw new Error(`${cut.no}번 컷 촬영본이 없어요`);
        const ext = clip.path.split(".").pop() ?? "mp4";
        const file = join(workDir, `in${cut.no}.${ext}`);
        await download(service, clip.path, file);
        fileOf.set(cut.no, file);
      }

      const script = (plan.script ?? {}) as {
        hooks?: { formula_id: number; spoken: string; on_screen: string }[];
        chosen_hook?: number;
        caption?: { text: string; keywords: string[] };
        loop_word?: string;
        thumbnail?: { title: string; sub?: string };
        fixed?: { hook?: { text?: string } | null; ending?: { text?: string } | null };
        human?: { hook?: string | null; thumbnail?: string | null };
      };
      const facts = await loadProductFacts(service, plan.product_id!);

      // 편집 키트 — 실패하면 아래 기본 편집으로 넘어간다
      const clipsSig = cuts.map((c) => clips.find((k) => k.cut === c.no)?.path ?? "").join("|");
      const prevKit = (req.edit as { kit?: { plan?: EditPlan; clipsSig?: string } } | null)?.kit;
      let kit: KitResult | null = null;
      let kitError: string | null = null;
      if (process.env.SHOOT_BASIC_EDIT !== "1") {
        try {
          const kitClips: KitClip[] = [];
          for (const cut of cuts) {
            const file = fileOf.get(cut.no)!;
            const k = readClip(cut.no, file, {
              shot: cut.shot,
              how: cut.how,
              onScreen: cut.on_screen_override ?? cut.on_screen,
              // 말한 소리를 안 쓰면 예전 컷 목록의 대사도 AI가 읽을 글로 넘긴다
              voice: liveVoice ? cut.voice : "",
              narration: liveVoice ? cut.narration : cut.narration || cut.voice,
            });
            // 말한 소리를 쓰는 계정만 원본의 말을 받아 적는다
            if (liveVoice && k.hasAudio) k.transcript = (await transcribeWords(file, workDir, cut.voice)).segments;
            kitClips.push(k);
          }
          const hook = script.hooks?.[script.chosen_hook ?? 0];
          kit = await renderKitEdit({
            workDir: join(workDir, "kit"),
            service: dryRun ? null : service,
            readService: service,
            planId: plan.id,
            accountName: acc?.display_name ?? "",
            liveVoice,
            facts,
            rules,
            clips: kitClips,
            humanHook: script.human?.hook,
            humanThumbnail: script.human?.thumbnail,
            shotlistHook: hook ? { spoken: hook.spoken, on_screen: hook.on_screen } : null,
            shotlistThumbnail: script.thumbnail ?? null,
            fixedHook: script.fixed?.hook?.text,
            fixedEnding: script.fixed?.ending?.text,
            tone: concept.shootTone,
            editStyleText: concept.shootEditStyle,
            style,
            reusePlan: prevKit?.clipsSig === clipsSig ? prevKit.plan : null,
            overrides: cuts
              .filter((c) => c.on_screen_override != null || c.subtitle_override != null)
              .map((c) => ({ no: c.no, onScreen: c.on_screen_override, subtitle: c.subtitle_override })),
          });
        } catch (e) {
          kitError = e instanceof Error ? e.message : String(e);
          console.error(`[shoot-edit] ${label} 편집 키트 실패, 기본 편집으로 만듭니다: ${kitError}`);
        }
      }

      const plans: Plan[] = [];
      if (!kit) for (const cut of cuts) plans.push(await planCut(cut, fileOf.get(cut.no)!, workDir, speaks, style));

      const segments: string[] = [];
      for (const p of plans) {
        const out = join(workDir, `seg${p.cutNo}.mp4`);
        const spec: SegmentSpec = {
          input: p.input,
          start: p.start,
          duration: p.duration,
          hasAudio: p.hasAudio,
          onScreen: p.onScreen,
          subtitles: p.showSubtitles ? p.subtitles : [],
          hdrTransfer: p.hdrTransfer,
          style,
        };
        renderSegment(spec, out, workDir, `c${p.cutNo}`);
        segments.push(out);
      }
      const final = kit?.final ?? join(workDir, "final.mp4");
      if (!kit) concatSegments(segments, final, workDir);
      const thumb = kit?.cover ?? join(workDir, "thumb.jpg");
      if (!kit) snapshot(final, Math.min(1, plans[0].duration / 2), thumb);
      const seconds = probe(final).duration;
      console.log(`[shoot-edit] ${label} — ${kit ? `편집 키트, 컷 ${kit.timeline.cuts.length}개, 후킹 "${kit.hook.text}"` : `기본 편집, 컷 ${plans.length}개`} · ${seconds.toFixed(1)}초 · ${Math.round((Date.now() - startedAt) / 1000)}초 걸림`);
      for (const p of plans) {
        console.log(`  ${p.cutNo}. ${p.start.toFixed(1)}~${(p.start + p.duration).toFixed(1)}초 [${p.onScreen}]${p.subtitles.length ? ` 자막: ${p.subtitles.map((s) => s.text).join(" / ")}` : ""}`);
      }

      // 실제로 들어간 글로 다시 점검 — 사람이 말한 내용(자막)에 근거 없는 효과가 섞일 수 있다
      const check = await checkScript(
        {
          hooks: kit ? [{ formula_id: 0, spoken: kit.plan.hook.spoken, on_screen: kit.plan.hook.on_screen }] : (script.hooks ?? []),
          chosen_hook: kit ? 0 : (script.chosen_hook ?? 0),
          beats: kit
            ? kit.plan.beats.map((b, i) => ({ spoken: b.tts || b.captions.join(" "), on_screen: i === 0 ? kit!.plan.hook.on_screen : b.graphics.map((g) => g.text).filter(Boolean).join(" "), visual: b.cuts.map((c) => c.what).join(" / ") }))
            : plans.map((p) => ({ spoken: p.subtitles.map((s) => s.text).join(" ") || p.onScreen, on_screen: p.onScreen, visual: "" })),
          loop_word: script.loop_word ?? "",
          caption: script.caption ?? { text: "", keywords: [] },
        },
        facts,
        rules,
        acc?.display_name ?? "",
        { track: "A", seconds, fixedHook: kit ? kit.hook.source !== "ai" : false },
      );
      // 사람이 확인할 것 — 완성본 받기 화면에 함께 보인다
      for (const w of kit?.warnings ?? []) check.issues.push({ kind: "edit", detail: w });
      if (kitError) check.issues.push({ kind: "edit", detail: `후킹 · 음성 · 그래픽 편집이 실패해 컷과 자막만 넣은 기본 편집으로 만들었어요. 다시 편집해 보세요. (${kitError.slice(0, 160)})` });
      for (const i of check.issues) console.log(`  ✗ ${i.detail}`);

      if (dryRun) {
        console.log(`  (dry-run) 결과: ${final}`);
        continue;
      }

      const uploader = clips[0]?.uploaded_by;
      const base = `${req.organization_id}/${uploader}/shoot/${req.id}/edit-${Date.now()}`;
      const up = async (path: string, file: string, contentType: string) => {
        const { error: e } = await service.storage.from("media").upload(path, readFileSync(file), { contentType, upsert: true });
        if (e) throw new Error(`완성본 올리기 실패: ${e.message}`);
      };
      await up(`${base}.mp4`, final, "video/mp4");
      await up(`${base}.jpg`, thumb, "image/jpeg");

      const edit = {
        seconds,
        thumbnail: `${base}.jpg`,
        segments: kit ? kit.segments : plans.map((p) => ({ cut: p.cutNo, start: p.start, duration: p.duration, onScreen: p.onScreen, subtitles: p.subtitles })),
        check: { ...check, checkedAt: new Date().toISOString() },
        music: kit?.sounds.music ?? null,
        style,
        // 다시 편집 때 같은 촬영본이면 이 계획을 다시 쓴다
        kit: kit ? { plan: kit.plan, clipsSig, hook: kit.hook, thumbnail: kit.plan.thumbnail, sounds: kit.sounds, loudness: kit.loudness, usedVoice: kit.usedVoice } : null,
        editedAt: new Date().toISOString(),
      };
      const { data: prev } = await service.from("shoot_requests").select("rendered_path, edit").eq("id", req.id).maybeSingle();
      // 편집하는 사이 건너뛰기 · 취소된 요청은 되살리지 않는다(2026-11-04, 예전엔 EDITED로 덮어썼다) — 새 파일만 지운다
      const { data: doneRows, error: upErr } = await service
        .from("shoot_requests")
        .update({ status: "EDITED", rendered_path: `${base}.mp4`, edit: edit as unknown as Json, error: null })
        .eq("id", req.id)
        .eq("status", "EDITING")
        .select("id");
      if (upErr) throw new Error(upErr.message);
      if (!doneRows?.length) {
        console.log(`  편집하는 사이 요청 상태가 바뀌어(건너뜀 · 취소) 결과를 버림`);
        await service.storage.from("media").remove([`${base}.mp4`, `${base}.jpg`]);
        continue;
      }
      await service
        .from("content_plans")
        .update({ status: "RENDERED", check_result: edit.check as unknown as Json, error: null })
        .eq("id", plan.id)
        .in("status", ["SHOT", "RENDERED"]);
      // 다시 편집이면 예전 완성본은 지운다
      const oldThumb = (prev?.edit as { thumbnail?: string } | null)?.thumbnail;
      const old = [prev?.rendered_path, oldThumb].filter((p): p is string => !!p && !p.startsWith(base));
      if (old.length) await service.storage.from("media").remove(old);

      await service.from("agent_runs").insert({
        organization_id: req.organization_id,
        agent: "edit",
        plan_id: plan.id,
        status: "success",
        model: kit ? "video-kit" : speaks ? "whisper-1 + ffmpeg" : "ffmpeg",
        input: { requestId: req.id, cuts: cuts.length } as Json,
        output: { seconds, segments: edit.segments.length, checkModel: agentModel(), issues: check.issues.length, kit: !!kit, kitError, hook: kit?.hook ?? null } as Json,
        tokens_input: check.tokens.input,
        tokens_output: check.tokens.output,
        finished_at: new Date().toISOString(),
      });
    } catch (err) {
      process.exitCode = 1;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[shoot-edit] ${label} 실패: ${message}`);
      if (!dryRun) await service.from("shoot_requests").update({ status: "FAILED", error: message.slice(0, 500) }).eq("id", req.id).eq("status", "EDITING");
    } finally {
      if (!dryRun) rmSync(workDir, { recursive: true, force: true });
    }
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("[shoot-edit] 치명적 오류:", err);
    process.exit(1);
  });
