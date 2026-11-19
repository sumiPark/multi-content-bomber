// .env.local 로드는 다른 어떤 import보다 먼저 (dev 전용 — GitHub Actions에선 no-op).
import "./load-env";

import { createWriteStream, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { ProductFacts } from "@/lib/agents/product-facts";
import { DEFAULT_EDIT_STYLE } from "@/lib/shoot/edit-style";
import { readClip, renderKitEdit, type KitClip, type KitResult } from "@/lib/shoot/video-kit/pipeline";
import { transcribeWords } from "@/lib/shoot/video-kit/tools";
import type { StyleCard } from "@/lib/style-shorts/card";
import { renderStyleSfx } from "@/lib/style-shorts/sfx";
import { CLIP_KEEP_DAYS, type JobClip, type VersionRequest, type VersionTimeline } from "@/lib/style-shorts/jobs";
import { warnIfError } from "@/lib/supabase/result";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";

// ─────────────────────────────────────────────────────────────────────────────
// 스타일 쇼츠 편집 워커 — 편집 대기(PENDING) 버전을 집어 찍은 영상을 레퍼런스 스타일 카드대로 편집한다.
//   직접 촬영과 같은 편집 키트(lib/shoot/video-kit)를 쓰고, 스타일 쇼츠 전용 값만 넘긴다:
//   카드 · 소리 모드 · 대본 · 컨셉(편집 지시), earshot 효과음, 카드의 음악 검색어. 상품 · 계정은 연결하지 않는다.
// 끝나면 완성본 · 표지를 media 버킷에 올리고 버전을 DONE으로. 실패하면 FAILED와 이유.
// 촬영본은 30일이 지나면 지운다(완성본은 모든 버전 보관).
// FFmpeg · HyperFrames · earshot이 필요해 GitHub Actions(.github/workflows/style-shorts-edit.yml)에서만 돈다.
// 옵션: --version <id> (그 버전만) · --dry-run (편집만 하고 저장하지 않음)
// ─────────────────────────────────────────────────────────────────────────────

type Service = ReturnType<typeof createServiceClient>;

// 워크플로 시간 제한(45분)보다 길게 — 이보다 오래 "편집 중"이면 러너가 죽은 것으로 보고 다시 집는다
const STALE_MS = 55 * 60_000;
const DAY_MS = 86_400_000;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
}

async function download(service: Service, path: string, to: string): Promise<void> {
  const { data, error } = await service.storage.from("media").createSignedUrl(path, 3600);
  if (error || !data) throw new Error(`촬영본 링크 실패: ${error?.message}`);
  const res = await fetch(data.signedUrl);
  if (!res.ok || !res.body) throw new Error(`촬영본 받기 실패 (${res.status})`);
  await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), createWriteStream(to));
}

/** 상품이 없는 편집이라 비어 있는 상품 정보를 넘긴다(종류 OTHER → AI 이미지 컷도 쓰지 않는다). */
function emptyFacts(id: string, title: string, concept: string | null): ProductFacts {
  return {
    id,
    name: title,
    rawName: title,
    shop: "",
    kind: "OTHER",
    kindLabel: "영상",
    price: null,
    stockStatus: "",
    url: "",
    detailImages: 0,
    oneLine: concept ? concept.slice(0, 80) : null,
    usage: null,
    cautions: null,
    details: {},
    claims: [],
    uncertainties: [],
    healthFunctional: null,
    approvedClaims: [],
    certifiedFunctions: [],
    sourceText: "",
  };
}

function timelineSummary(kit: KitResult): VersionTimeline {
  const tl = kit.timeline;
  const r = (n: number) => Math.round(n * 100) / 100;
  return {
    duration: r(tl.duration),
    cuts: tl.cuts.map((c) => ({ start: r(c.start), end: r(c.end), clip: c.clip, in: r(c.in) })),
    captions: tl.captions.map((c) => ({ start: r(c.start), end: r(c.end), text: c.text })),
    graphics: tl.graphics.map((g) => ({ start: r(g.start), end: r(g.end), type: g.type, text: g.g.text ?? "" })),
    sfx: tl.sfx.map((s) => ({ t: r(s.t), name: s.name })),
  };
}

/** 30일이 지난 촬영본을 지운다. 지운 뒤에는 수정 · 다시 만들기를 할 수 없다(화면이 알린다). */
async function cleanupClips(service: Service): Promise<void> {
  const before = new Date(Date.now() - CLIP_KEEP_DAYS * DAY_MS).toISOString();
  const { data } = await service.from("style_short_jobs").select("id, clips").is("clips_deleted_at", null).lt("created_at", before).limit(50);
  for (const job of data ?? []) {
    // 편집 중인 버전이 있으면 다음에
    const { count } = await service.from("style_short_versions").select("id", { count: "exact", head: true }).eq("job_id", job.id).in("status", ["PENDING", "EDITING"]);
    if (count) continue;
    const paths = ((job.clips ?? []) as unknown as JobClip[]).map((c) => c.path);
    if (paths.length) {
      const { error } = await service.storage.from("media").remove(paths);
      if (error) {
        console.warn(`[style-edit] 촬영본 지우기 실패 ${job.id}: ${error.message}`);
        continue;
      }
    }
    warnIfError(await service.from("style_short_jobs").update({ clips_deleted_at: new Date().toISOString() }).eq("id", job.id), `촬영본 삭제 표시 (${job.id})`);
    console.log(`[style-edit] 30일 지난 촬영본 ${paths.length}개 삭제 (job=${job.id})`);
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const only = arg("--version");
  const service = createServiceClient();
  if (!dryRun) await cleanupClips(service);

  const staleBefore = new Date(Date.now() - STALE_MS).toISOString();
  let q = service.from("style_short_versions").select("id, job_id, version, status, request, organization_id").order("created_at");
  q = only ? q.eq("id", only) : q.or(`status.eq.PENDING,and(status.eq.EDITING,editing_since.lt.${staleBefore})`);
  const { data: versions, error } = await q;
  if (error) throw new Error(error.message);
  if (!versions?.length) {
    console.log("[style-edit] 편집할 버전 없음");
    return;
  }

  for (const v of versions) {
    if (!dryRun) {
      let claim = service.from("style_short_versions").update({ status: "EDITING", editing_since: new Date().toISOString(), error: null }).eq("id", v.id);
      claim = v.status === "EDITING" ? claim.eq("status", "EDITING").lt("editing_since", staleBefore) : claim.in("status", only ? ["PENDING", "FAILED", "DONE"] : ["PENDING"]);
      const { data: claimed } = await claim.select("id");
      if (!claimed?.length) continue;
    }

    const label = `${v.job_id.slice(0, 8)} v${v.version}`;
    const workDir = join(tmpdir(), `style-${v.id}`);
    rmSync(workDir, { recursive: true, force: true });
    mkdirSync(workDir, { recursive: true });
    const startedAt = Date.now();
    try {
      const { data: job, error: jobErr } = await service
        .from("style_short_jobs")
        .select("id, organization_id, title, card, voice_mode, script, concept, clips, clips_deleted_at, created_by")
        .eq("id", v.job_id)
        .single();
      if (jobErr || !job) throw new Error(`요청을 찾지 못했어요: ${jobErr?.message ?? ""}`);
      if (job.clips_deleted_at) throw new Error(`촬영본을 보관 기간(${CLIP_KEEP_DAYS}일)이 지나 지웠어요. 새로 만들어 주세요.`);
      const card = job.card as unknown as StyleCard;
      const clips = (job.clips ?? []) as unknown as JobClip[];
      if (!clips.length) throw new Error("편집할 촬영본이 없어요");
      const liveVoice = job.voice_mode === "LIVE";
      const script = job.script?.trim() || null;
      const concept = job.concept?.trim() || null;
      const request = (v.request ?? null) as VersionRequest | null;

      // 수정 버전(3단계)은 아직 지원하지 않는다 — 처음부터 다시 만든다
      if (request?.kind === "revise") console.log(`[style-edit] ${label}: 수정 요청은 다음 단계에서 지원해요. 처음부터 다시 편집합니다.`);

      const kitClips: KitClip[] = [];
      for (const [i, c] of clips.entries()) {
        const ext = c.path.split(".").pop() ?? "mp4";
        const file = join(workDir, `in${i + 1}.${ext}`);
        await download(service, c.path, file);
        const k = readClip(i + 1, file, { shot: "", how: "", onScreen: "", voice: "", narration: "" });
        // 말소리 모드만 원본의 말을 받아 적는다. 대본이 있으면 맞춤법 힌트로
        if (liveVoice && k.hasAudio) k.transcript = (await transcribeWords(file, workDir, script ?? undefined)).segments;
        kitClips.push(k);
      }

      const title = job.title?.trim() || "스타일 쇼츠";
      const kit = await renderKitEdit({
        workDir: join(workDir, "kit"),
        service: dryRun ? null : service,
        readService: service,
        accountName: "스타일 쇼츠",
        liveVoice,
        facts: emptyFacts(job.id, title, concept),
        rules: [],
        clips: kitClips,
        source: "style",
        stylePlan: { card, voiceMode: liveVoice ? "LIVE" : "AI", script, concept },
        sfxRenderer: renderStyleSfx,
        // 자막 디자인 AI가 참고하는 글 — 카드의 자막 · 화면 설명
        editStyleText: `${card.sections.captions}\n${card.sections.visual}`,
        tone: concept,
        style: DEFAULT_EDIT_STYLE,
      });
      console.log(
        `[style-edit] ${label} 완성: ${kit.seconds.toFixed(1)}초, 컷 ${kit.timeline.cuts.length}개, 효과음 ${kit.timeline.sfx.length}개, 음악 ${kit.sounds.music}, ${Math.round((Date.now() - startedAt) / 1000)}초 걸림`,
      );
      for (const w of kit.warnings) console.log(`  ! ${w}`);

      if (dryRun) {
        console.log(`  (dry-run) 결과: ${kit.final}`);
        continue;
      }

      const base = `${job.organization_id}/${job.created_by}/style-shorts/out/${job.id}/v${v.version}-${Date.now()}`;
      const up = async (path: string, file: string, contentType: string) => {
        const { error: e } = await service.storage.from("media").upload(path, readFileSync(file), { contentType, upsert: true });
        if (e) throw new Error(`완성본 올리기 실패: ${e.message}`);
      };
      await up(`${base}.mp4`, kit.final, "video/mp4");
      await up(`${base}.jpg`, kit.cover, "image/jpeg");

      const { data: done, error: saveErr } = await service
        .from("style_short_versions")
        .update({
          status: "DONE",
          video_path: `${base}.mp4`,
          cover_path: `${base}.jpg`,
          seconds: Math.round(kit.seconds * 10) / 10,
          plan: kit.plan as unknown as Json,
          timeline: timelineSummary(kit) as unknown as Json,
          warnings: kit.warnings,
          sounds: { ...kit.sounds, loudness: kit.loudness, captionMode: kit.captionMode, usedVoice: kit.usedVoice } as unknown as Json,
          error: null,
          editing_since: null,
          finished_at: new Date().toISOString(),
        })
        .eq("id", v.id)
        .eq("status", "EDITING")
        .select("id");
      if (saveErr) throw new Error(saveErr.message);
      if (!done?.length) {
        console.log(`  편집하는 사이 버전이 지워져 결과를 버림`);
        await service.storage.from("media").remove([`${base}.mp4`, `${base}.jpg`]);
        continue;
      }
      warnIfError(await service.from("style_short_jobs").update({ updated_at: new Date().toISOString() }).eq("id", job.id), `요청 갱신 (${job.id})`);
    } catch (err) {
      process.exitCode = 1;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[style-edit] ${label} 실패: ${message}`);
      if (!dryRun) {
        warnIfError(
          await service.from("style_short_versions").update({ status: "FAILED", error: message.slice(0, 500), editing_since: null, finished_at: new Date().toISOString() }).eq("id", v.id).eq("status", "EDITING"),
          `버전 실패 표시 (${v.id})`,
        );
      }
    } finally {
      if (!dryRun) rmSync(workDir, { recursive: true, force: true });
    }
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("[style-edit] 치명적 오류:", err);
    process.exit(1);
  });
