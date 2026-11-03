// .env.local 로드는 다른 어떤 import보다 먼저 (dev 전용 — GitHub Actions에선 no-op).
import "./load-env";

import { createReadStream, createWriteStream, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { checkScript } from "@/lib/agents/check";
import { loadProductFacts } from "@/lib/agents/product-facts";
import { agentModel } from "@/lib/agents/runner";
import { getOpenAI } from "@/lib/openai";
import type { ContentRule } from "@/lib/rules/check";
import { concatSegments, extractAudio, probe, renderSegment, snapshot, type SegmentSpec } from "@/lib/shoot/ffmpeg";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";

// ─────────────────────────────────────────────────────────────────────────────
// 직접 촬영 편집 워커 — 편집 에이전트(3)의 촬영본 편집. 사람이 "다 올렸어요"를 누른(UPLOADED) 촬영 요청마다:
//   1. 컷마다 쓸 구간을 고른다 — 말하는 컷은 받아쓰기(whisper) 시각으로 말 앞뒤만, 아니면 앞 흔들림을 빼고 컷 길이만큼
//   2. 1080x1920으로 맞추고 화면 문구(위) · 말 자막(아래)을 입힌다 — 사람이 고친 문구가 있으면 그걸로
//   3. 이어 붙이고 소리 크기를 맞춘다. 음악은 아직 없음(AI 음악 도구를 정하면 여기서 깐다)
//   4. 실제로 들어간 문구 · 자막 · 캡션으로 점검(4)을 다시 돌린다 → 완성본 확인 화면에 보인다
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
  // 완성본 확인에서 사람이 고친 문구 (있으면 이걸 쓴다)
  on_screen_override?: string | null;
  subtitle_override?: string | null;
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
}

async function planCut(cut: Cut, file: string, workDir: string, speaks: boolean): Promise<Plan> {
  const info = probe(file);
  if (info.duration < 0.5) throw new Error(`${cut.no}번 컷 촬영본이 너무 짧아요 (${info.duration.toFixed(1)}초)`);
  const onScreen = (cut.on_screen_override ?? cut.on_screen ?? "").trim();

  // 말하는 컷: 받아쓰기 시각으로 말 앞뒤만 남긴다(대본 길이보다 말이 길면 말을 살린다)
  if (speaks && info.hasAudio && cut.voice.trim()) {
    const audio = join(workDir, `cut${cut.no}.mp3`);
    extractAudio(file, audio);
    const { segments: segs, words } = await transcribe(audio, cut.voice);
    if (segs.length) {
      const first = words[0]?.start ?? segs[0].start;
      const last = words[words.length - 1]?.end ?? segs[segs.length - 1].end;
      const start = Math.max(0, first - 0.25);
      const end = Math.min(info.duration, last + 0.35);
      // 사람이 고친 자막이 있으면 그걸로(빈 문자열 = 이 컷 자막 빼기)
      const subtitles = cut.subtitle_override != null
        ? chunkSubtitle(cut.subtitle_override, 0, end - start)
        : segs.flatMap((s) => chunkSubtitle(s.text, Math.max(first, s.start) - start, Math.min(end, s.end) - start));
      return { cutNo: cut.no, input: file, start, duration: end - start, hasAudio: true, onScreen, subtitles };
    }
  }

  // 말 없는 컷: 앞 흔들림을 빼고 컷 길이만큼. 짧게 찍었으면 있는 만큼.
  const start = info.duration > cut.seconds + LEAD_SKIP * 2 ? LEAD_SKIP : Math.min(0.1, info.duration * 0.05);
  const duration = Math.min(cut.seconds, info.duration - start - 0.05);
  return {
    cutNo: cut.no,
    input: file,
    start,
    duration,
    hasAudio: info.hasAudio,
    onScreen,
    subtitles: cut.subtitle_override ? chunkSubtitle(cut.subtitle_override, 0, duration) : [],
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

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const onlyRequest = arg(argv, "--request");
  const service = createServiceClient();
  const rules = await loadRules(service);

  let q = service
    .from("shoot_requests")
    .select(
      "id, organization_id, plan_id, status, cuts, clips, content_plans!inner(id, slot_time, product_id, script, social_accounts(display_name, role_focus))",
    )
    .order("uploaded_at");
  q = onlyRequest ? q.eq("id", onlyRequest) : q.eq("status", "UPLOADED");
  const { data: requests, error } = await q;
  if (error) throw new Error(error.message);
  if (!requests?.length) {
    console.log("[shoot-edit] 편집할 촬영 요청 없음");
    return;
  }

  for (const req of requests) {
    const plan = req.content_plans;
    const acc = plan.social_accounts;
    const label = `@${acc?.display_name} ${plan.slot_time} (${req.id.slice(0, 8)})`;
    // 선점 — 동시에 두 run이 같은 요청을 편집하지 않게
    if (!dryRun) {
      const { data: claimed } = await service
        .from("shoot_requests")
        .update({ status: "EDITING", error: null })
        .eq("id", req.id)
        .in("status", onlyRequest ? ["UPLOADED", "EDITED", "FAILED"] : ["UPLOADED"])
        .select("id");
      if (!claimed?.length) continue;
    }

    const workDir = join(tmpdir(), `shoot-${req.id}`);
    rmSync(workDir, { recursive: true, force: true });
    mkdirSync(workDir, { recursive: true });
    const startedAt = Date.now();
    try {
      const cuts = ((req.cuts ?? []) as Cut[]).slice().sort((a, b) => a.no - b.no);
      const clips = (req.clips ?? []) as Clip[];
      const speaks = acc?.role_focus === "PERSON" || cuts.some((c) => c.voice?.trim());

      const plans: Plan[] = [];
      for (const cut of cuts) {
        const clip = clips.find((c) => c.cut === cut.no);
        if (!clip) throw new Error(`${cut.no}번 컷 촬영본이 없어요`);
        const ext = clip.path.split(".").pop() ?? "mp4";
        const file = join(workDir, `in${cut.no}.${ext}`);
        await download(service, clip.path, file);
        plans.push(await planCut(cut, file, workDir, speaks));
      }

      const segments: string[] = [];
      for (const p of plans) {
        const out = join(workDir, `seg${p.cutNo}.mp4`);
        const spec: SegmentSpec = {
          input: p.input,
          start: p.start,
          duration: p.duration,
          hasAudio: p.hasAudio,
          onScreen: p.onScreen,
          subtitles: p.subtitles,
        };
        renderSegment(spec, out, workDir, `c${p.cutNo}`);
        segments.push(out);
      }
      const final = join(workDir, "final.mp4");
      concatSegments(segments, final, workDir);
      const thumb = join(workDir, "thumb.jpg");
      snapshot(final, Math.min(1, plans[0].duration / 2), thumb);
      const seconds = probe(final).duration;
      console.log(`[shoot-edit] ${label} — 컷 ${plans.length}개 · ${seconds.toFixed(1)}초 · ${Math.round((Date.now() - startedAt) / 1000)}초 걸림`);
      for (const p of plans) {
        console.log(`  ${p.cutNo}. ${p.start.toFixed(1)}~${(p.start + p.duration).toFixed(1)}초 [${p.onScreen}]${p.subtitles.length ? ` 자막: ${p.subtitles.map((s) => s.text).join(" / ")}` : ""}`);
      }

      // 실제로 들어간 글로 다시 점검 — 사람이 말한 내용(자막)에 근거 없는 효과가 섞일 수 있다
      const script = (plan.script ?? {}) as { hooks?: { formula_id: number; spoken: string; on_screen: string }[]; chosen_hook?: number; caption?: { text: string; keywords: string[] }; loop_word?: string };
      const facts = await loadProductFacts(service, plan.product_id!);
      const check = await checkScript(
        {
          hooks: script.hooks ?? [],
          chosen_hook: script.chosen_hook ?? 0,
          beats: plans.map((p) => ({ spoken: p.subtitles.map((s) => s.text).join(" ") || p.onScreen, on_screen: p.onScreen, visual: "" })),
          loop_word: script.loop_word ?? "",
          caption: script.caption ?? { text: "", keywords: [] },
        },
        facts,
        rules,
        acc?.display_name ?? "",
        { track: "A", seconds },
      );
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
        segments: plans.map((p) => ({ cut: p.cutNo, start: p.start, duration: p.duration, onScreen: p.onScreen, subtitles: p.subtitles })),
        check: { ...check, checkedAt: new Date().toISOString() },
        music: null,
        editedAt: new Date().toISOString(),
      };
      const { data: prev } = await service.from("shoot_requests").select("rendered_path, edit").eq("id", req.id).maybeSingle();
      const { error: upErr } = await service
        .from("shoot_requests")
        .update({ status: "EDITED", rendered_path: `${base}.mp4`, edit: edit as unknown as Json, error: null })
        .eq("id", req.id);
      if (upErr) throw new Error(upErr.message);
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
        agent: "edit",
        plan_id: plan.id,
        status: "success",
        model: speaks ? "whisper-1 + ffmpeg" : "ffmpeg",
        input: { requestId: req.id, cuts: cuts.length } as Json,
        output: { seconds, segments: edit.segments.length, checkModel: agentModel(), issues: check.issues.length } as Json,
        tokens_input: check.tokens.input,
        tokens_output: check.tokens.output,
        finished_at: new Date().toISOString(),
      });
    } catch (err) {
      process.exitCode = 1;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[shoot-edit] ${label} 실패: ${message}`);
      if (!dryRun) await service.from("shoot_requests").update({ status: "FAILED", error: message.slice(0, 500) }).eq("id", req.id);
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
