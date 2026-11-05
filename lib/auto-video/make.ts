import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkScript } from "@/lib/agents/check";
import type { AccountConcept } from "@/lib/agents/concept";
import type { EditGraphic } from "@/lib/agents/edit-plan";
import { loadProductFacts } from "@/lib/agents/product-facts";
import type { ScriptOutput } from "@/lib/agents/script";
import { sourcePlanProblems, writeSourcePlan, type MotionSpec, type SourcePlan } from "@/lib/agents/source-plan";
import { loadArchiveChoices } from "@/lib/auto-video/archive";
import { motionClip, photoClip } from "@/lib/auto-video/clips";
import { stockClip } from "@/lib/auto-video/stock";
import type { ContentRule } from "@/lib/rules/check";
import { finalBlocking } from "@/lib/shoot/final-check";
import { readClip, renderKitEdit, type KitClip } from "@/lib/shoot/video-kit/pipeline";
import { ffmpeg, imageDataUrl } from "@/lib/shoot/video-kit/tools";
import { runVisionTool } from "@/lib/shoot/video-kit/vision-tools";
import type { createServiceClient } from "@/lib/supabase/service";

// AI 자동 콘텐츠 한 편 만들기. 상세페이지 사진 찾기 → 소재 에이전트 → 사진 · 도식 · 스톡 · 자사 촬영 컷 → 편집 키트 → 최종 점검.
// 참고 내용은 호출하는 쪽이 넘긴 계정 컨셉의 auto_* 값만 읽는다. 저장 · 발행은 워커가 맡는다.

export type SavedScript = ScriptOutput & { fixed?: { hook?: { text?: string } | null; ending?: { text?: string } | null } };

async function detailImages(urls: string[], dir: string): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  for (const [i, url] of urls.slice(0, 12).entries()) {
    // 한 장이 안 받아져도 나머지로 만든다
    try {
      const res = await fetch(url, { headers: { "User-Agent": "MCB-Video/1.0" } });
      if (!res.ok) throw new Error(String(res.status));
      const f = join(dir, `d${i}${url.toLowerCase().includes(".png") ? ".png" : ".jpg"}`);
      writeFileSync(f, Buffer.from(await res.arrayBuffer()));
      files.push(f);
    } catch (e) {
      console.warn(`  이미지 ${i + 1} 내려받기 실패(${e instanceof Error ? e.message : e})`);
    }
  }
  return files;
}

interface Candidate {
  id: string;
  file: string;
  w: number;
  h: number;
}

function trimPhoto(c: Candidate, top: number, bottom: number, workDir: string): string {
  const t = Math.min(0.6, Math.max(0, top));
  const b = Math.min(0.6, Math.max(0, bottom));
  if (t === 0 && b === 0) return c.file;
  const y = Math.round(c.h * t);
  const h = Math.max(240, Math.round(c.h * (1 - t - b)));
  const out = join(workDir, `${c.id}-trim.jpg`);
  ffmpeg(["-y", "-v", "error", "-i", c.file, "-vf", `crop=${c.w}:${h}:0:${y}`, "-q:v", "2", out]);
  return out;
}

export async function makeAutoVideo(input: {
  service: ReturnType<typeof createServiceClient>;
  planId: string;
  organizationId: string;
  account: string;
  productId: string;
  concept: AccountConcept;
  script: SavedScript;
  rules: ContentRule[];
  dryRun: boolean;
  workDir: string;
}) {
  const { service, planId, account, productId, script, rules, workDir } = input;
  const facts = await loadProductFacts(service, productId);
  if (facts.stockStatus !== "available") throw new StopError(`지금 판매 중이 아닌 상품이에요 (${facts.stockStatus})`);
  const concept = input.concept;
  const { data: product } = await service.from("products").select("detail_image_urls, represent_image_url").eq("id", productId).maybeSingle();

  // 1. 상세페이지에서 사진 구간만 잘라 후보로
  // 대표 이미지는 제품만 찍힌 사진인 경우가 많아 맨 앞에 넣는다
  const urls = [...(product?.represent_image_url ? [product.represent_image_url] : []), ...(product?.detail_image_urls ?? [])];
  const images = await detailImages(urls, join(workDir, "detail"));
  const listFile = join(workDir, "images.json");
  writeFileSync(listFile, JSON.stringify(images));
  const blocks = images.length
    ? runVisionTool<{ candidates: Candidate[]; sheets: string[] }>("photo_blocks.py", [listFile, join(workDir, "blocks")])
    : null;
  const candidates = blocks?.candidates ?? [];
  console.log(`  사진 후보 ${candidates.length}개`);

  const archive = await loadArchiveChoices(service, input.organizationId, productId, workDir);
  if (archive.length) console.log(`  자사 촬영 컷 ${archive.length}개`);
  const archiveIds = archive.map((a) => a.id);

  // 2. 소재 에이전트
  const beats = script.beats.map((b) => ({ spoken: b.spoken, on_screen: b.on_screen, visual: b.visual }));
  const ask = (retry: { problems: string[] } | null) =>
    writeSourcePlan({
      service: input.dryRun ? null : service,
      readService: service,
      planId,
      accountName: account,
      facts,
      rules,
      beats,
      candidates,
      sheets: (blocks?.sheets ?? []).map((s) => imageDataUrl(s)),
      archive: archive.map((a) => ({ id: a.id, what: a.what, seconds: a.seconds })),
      archiveSheets: archive.map((a) => imageDataUrl(a.sheet)),
      tone: concept.autoTone,
      videoStyle: concept.autoVideoStyle,
      retry,
    });
  let tokens = { input: 0, output: 0 };
  let res = await ask(null);
  tokens = { input: tokens.input + res.tokens.input, output: tokens.output + res.tokens.output };
  let plan: SourcePlan = res.output;
  const problems = sourcePlanProblems(plan, beats.length, archiveIds);
  if (problems.length) {
    console.log(`  소재 계획 다시 쓰기: ${problems.join(" / ")}`);
    res = await ask({ problems });
    tokens = { input: tokens.input + res.tokens.input, output: tokens.output + res.tokens.output };
    plan = res.output;
  }
  const left = sourcePlanProblems(plan, beats.length, archiveIds).filter((p) => p.includes("소재가 없다") || p.includes("쓸 수 있는 후보가 아니다"));
  if (left.length) throw new Error(`소재를 정하지 못했어요: ${left.join(" / ")}`);

  // 3. 소재 → 컷. 같은 사진은 한 번만 만들고, 스톡이 탈락하면 그 비트는 사진이나 다른 컷을 쓴다
  const clips: KitClip[] = [];
  const sources: unknown[] = [];
  const warnings = [...plan.warnings];
  const photoFile = new Map<string, number>();
  const usedStock = new Set<number>();
  const usable = plan.photos.filter((p) => p.usable);
  const addPhoto = (id: string): number | null => {
    if (photoFile.has(id)) return photoFile.get(id)!;
    const cand = candidates.find((c) => c.id === id);
    const meta = usable.find((p) => p.id === id);
    if (!cand || !meta) return null;
    const src = trimPhoto(cand, meta.trim_top, meta.trim_bottom, workDir);
    const made = photoClip(src, workDir, `photo-${id}`);
    if (made.soft) warnings.push(`${id} 사진(${meta.what})은 해상도가 낮아 영상에서 흐릴 수 있어요.`);
    const no = clips.length + 1;
    clips.push(readClip(no, made.file, { shot: `[제품컷] ${meta.what}. 카메라가 8초 동안 천천히 움직인다.` }));
    sources.push({ no, kind: "photo", id, what: meta.what, mode: made.mode });
    photoFile.set(id, no);
    return no;
  };
  for (const b of plan.beats) {
    const line = beats[b.beat]?.spoken ?? "";
    if (b.use === "photo") addPhoto(b.photo_id);
    else if (b.use === "archive") {
      const a = archive.find((x) => x.id === b.archive_id);
      if (!a) continue;
      const no = clips.length + 1;
      clips.push(readClip(no, a.file, { shot: `[자사 촬영] ${a.what}`, narration: line }));
      sources.push({ no, kind: "archive", id: a.rowId, what: a.what });
    } else if (b.use === "motion" && b.motion) {
      const made = motionClip(b.motion, workDir, `motion-${b.beat}`);
      const no = clips.length + 1;
      clips.push(readClip(no, made.file, { shot: `[코드 모션] ${made.shot}`, narration: line }));
      sources.push({ no, kind: "motion", spec: b.motion });
    } else if (b.use === "stock") {
      let done = false;
      try {
        const pick = await stockClip(service, b.stock_query, b.stock_intent, workDir, `stock-${b.beat}`, usedStock);
        if (pick) {
          tokens = { input: tokens.input + pick.tokens.input, output: tokens.output + pick.tokens.output };
          const no = clips.length + 1;
          done = true;
          clips.push(readClip(no, pick.file, { shot: `[스톡] ${pick.shot}`, narration: line }));
          sources.push({ no, kind: "stock", ...pick.source });
        } else console.log(`  스톡 "${b.stock_query}" 통과 후보 없음 — 사진으로 대체`);
      } catch (e) {
        console.warn(`  스톡 실패(${e instanceof Error ? e.message : e}) — 사진으로 대체`);
      }
      if (!done && usable[0]) addPhoto(usable[0].id);
    }
  }
  if (!clips.length) throw new StopError("쓸 수 있는 소재가 없어요. 상세페이지에 제품만 찍힌 사진이 있는지 확인해 주세요.");

  // 4. 편집 키트 — 직접 촬영과 같은 코드. 자동 콘텐츠 설정만 넘긴다
  const chosen = script.hooks?.[script.chosen_hook] ?? script.hooks?.[0];
  const kit = await renderKitEdit({
    workDir: join(workDir, "kit"),
    service: input.dryRun ? null : service,
    readService: service,
    planId,
    accountName: account,
    liveVoice: false,
    facts,
    rules,
    clips,
    source: "auto",
    scriptLines: beats.map((b) => b.spoken),
    shotlistHook: chosen ? { spoken: chosen.spoken, on_screen: chosen.on_screen } : null,
    fixedHook: script.fixed?.hook?.text ?? null,
    fixedEnding: script.fixed?.ending?.text ?? null,
    tone: concept.autoTone,
    editStyleText: concept.autoVideoStyle,
    voiceId: concept.autoVoiceId,
  });
  tokens = { input: tokens.input + kit.tokens.input, output: tokens.output + kit.tokens.output };

  // 5. 실제로 들어간 글로 다시 점검. 도식 · 그래픽 · 표지까지 영상에 박히는 글은 모두 본다
  const graphicTexts = (g: EditGraphic) => [g.text, g.small, g.sub, g.note, g.chip, g.number, g.unit, g.left, g.right, ...g.items].filter(Boolean);
  const motionTexts = sources.flatMap((s) => {
    const m = (s as { spec?: MotionSpec }).spec;
    return m ? [m.title, m.left_label, m.right_label, m.left_value, ...m.right_values, m.number_to ? `${m.number_to}${m.unit}` : "", m.end_text, ...m.items, m.big ? `${m.big}${m.unit}` : ""].filter(Boolean) : [];
  });
  const coverTexts = [kit.plan.thumbnail.title.replace(/\n+/g, " "), kit.plan.thumbnail.sub].filter(Boolean);
  const lastBeat = kit.plan.beats.length - 1;
  const check = await checkScript(
    {
      hooks: [{ formula_id: 0, spoken: kit.plan.hook.spoken, on_screen: kit.plan.hook.on_screen }],
      chosen_hook: 0,
      // 근거 점검은 화면에 보이는 표기로 한다. 읽기용 원고(에이치에이)는 원문(AHA)과 맞지 않아 근거 없음으로 잘못 걸렸다
      beats: kit.plan.beats.map((b, i) => ({ spoken: b.captions.join(" ") || b.tts, on_screen: [...(i === 0 ? [kit.plan.hook.on_screen] : []), ...b.graphics.flatMap(graphicTexts), ...(i === lastBeat ? [...motionTexts, ...coverTexts] : [])].join(" "), visual: "" })),
      loop_word: script.loop_word ?? "",
      caption: script.caption,
    },
    facts,
    rules,
    account,
    // 훅 점수는 대본 단계에서 이미 통과했다. 여기 글은 읽기용(삼십칠 도)이라 다시 재면 낮게 나와 잘못 멈춘다
    { track: "B", seconds: kit.seconds, fixedHook: true, fixedTexts: [script.fixed?.hook?.text, script.fixed?.ending?.text].filter((t): t is string => !!t) },
  );
  const blocking = finalBlocking(
    { caption: script.caption?.text ?? "", onScreen: [...kit.plan.beats.flatMap((b) => b.graphics.flatMap(graphicTexts)), kit.plan.hook.on_screen, ...motionTexts, ...coverTexts], subtitles: kit.plan.beats.flatMap((b) => b.captions) },
    { kind: facts.kind, rules, approvedClaims: facts.approvedClaims, stockStatus: facts.stockStatus, healthFunctional: facts.healthFunctional, certifiedFunctions: facts.certifiedFunctions },
  );
  return { kit, check, blocking, warnings: [...new Set([...warnings, ...kit.warnings])], sources, tokens, facts };
}

export class StopError extends Error {}
