import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blockingIssues, checkScript } from "@/lib/agents/check";
import type { AccountConcept } from "@/lib/agents/concept";
import type { EditGraphic, EditPlan } from "@/lib/agents/edit-plan";
import { LONG_VISUALS, type VisualPolicy } from "@/lib/agents/edit-plan";
import { dropFailedPhrases, fixedPhraseBlock, fixedRecord, phraseNotes, preparePhrases, recentTemplates, type PhraseState } from "@/lib/agents/fixed-phrases";
import { editKit, scoreHooks } from "@/lib/agents/ko-skills";
import { loadVideoKnowledge } from "@/lib/agents/knowledge";
import { loadProductFacts } from "@/lib/agents/product-facts";
import type { ScriptOutput } from "@/lib/agents/script";
// LENGTH_TOLERANCE: 음성으로 잰 길이의 허용 오차(초). 합성 결과의 작은 차이로 칸을 멈추지 않고, 장면표 글자 수 점검도 같은 여유를 둔다
import { AUTO_SECONDS, DEFAULT_SPEECH_RATE, LENGTH_TOLERANCE, MIN_AUTO_HOOK_SCORE, MIN_INTEREST, charRange, firstViewerTest, motionTexts, rankAngles, realMaterialCount, repairEdgeVisuals, repairOverflow, repeatLimit, reviewFinalFrames, reviewHookMaterials, reviewStoryboard, storyboardProblems, writeAngles, writeSceneVisuals, writeStoryboard, type Storyboard, type StoryAngle } from "@/lib/agents/storyboard";
import { hookEvidenceProblems, rejectIncompatiblePhrases } from "@/lib/auto-video/hook-evidence";
import { loadArchiveChoices } from "@/lib/auto-video/archive";
import { motionClip, photoClip, photoLayers, type PhotoLayers } from "@/lib/auto-video/clips";
import { gifClip, isAnimatedGif, isGif, prepareGifAssets } from "@/lib/auto-video/gif-clips";
import { stockClip } from "@/lib/auto-video/stock";
import { kstDate } from "@/lib/automation/time";
import type { ContentRule } from "@/lib/rules/check";
import { finalBlocking } from "@/lib/shoot/final-check";
import { captionSkillDir } from "@/lib/shoot/video-kit/caption-skill";
import type { VideoFonts } from "@/lib/shoot/video-kit/compose";
import { loadVisualLibrary } from "@/lib/shoot/video-kit/generated-visual";
import { readClip, renderKitEdit, type KitClip } from "@/lib/shoot/video-kit/pipeline";
import { chosenFonts, downloadVideoFonts, loadSkillFonts, type SkillFont } from "@/lib/shoot/video-kit/skill-fonts";
import { ffmpeg, fishTts, imageDataUrl, voicedSpan } from "@/lib/shoot/video-kit/tools";
import { runVisionTool } from "@/lib/shoot/video-kit/vision-tools";
import type { createServiceClient } from "@/lib/supabase/service";

// AI 자동 콘텐츠 한 편 만들기. 재료 판단 → 장면표(말 · 이미지 · 글자를 함께) → 음성 → 낱말 시각에 맞춘 조립 → 완성본 점검.
// 참고 내용은 호출하는 쪽이 넘긴 계정 컨셉의 auto_* 값만 읽는다. 저장 · 발행은 워커가 맡는다.

// 제품을 띄우는 컷은 가로 약 2.4배까지 키워도 볼 만하다. 그보다 작으면 흐리다
const MIN_NATIVE = 400;
const MIN_MATERIALS = 2;
const MAX_DETAIL_FILES = 40;
// 완성본을 볼 때 쓰는 자막 프레임 수. 긴 영상은 자막이 많아 전부 보내지 않는다
const MAX_REVIEW_FRAMES = 30;
const CALIBRATION_TEXT = "처음 듣는 사람도 알아듣게 천천히 설명해 볼게요. 이름이 낯설어도 뜻을 알면 고르기 쉬워져요.";
const MAX_BOARD_TRIES = 4;
const LONG_BEAT_SECONDS = 6.5;
const CAPTION_CHARS = 16;

const squash = (t: string) => t.replace(/\s+/g, "");
const graphicTexts = (g: EditGraphic) => [g.text, g.small, g.sub, g.note, g.chip, g.number, g.unit, g.left, g.right, g.from, ...g.items].filter(Boolean);

/** 낱말을 자르지 않고 자막 길이로 나눈다. */
function splitCaption(text: string): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.trim().split(/\s+/)) {
    if (line && (line + " " + word).length > CAPTION_CHARS) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

/** 저장해 둔 후킹 · 마지막 문구는 글자를 바꾸지 않고 말과 화면에 그대로 넣는다. */
function applyFixedPhrases(board: Storyboard, phrases: PhraseState): Storyboard {
  const scenes = [...board.scenes];
  const hook = phrases.hooks[0]?.text;
  const ending = phrases.endings[0]?.text;
  // 같은 문구면 AI가 쓴 읽기용 원고를 살린다. 영문 · 숫자를 읽는 대로 바꾼 값이다
  const reading = (text: string, scene: Storyboard["scenes"][number]) => (squash(scene.say) === squash(text) ? scene.tts : text);
  if (hook && scenes[0]) scenes[0] = { ...scenes[0], say: hook, tts: reading(hook, scenes[0]) };
  if (ending && scenes.length > 1) {
    const last = scenes[scenes.length - 1];
    scenes[scenes.length - 1] = { ...last, say: ending, tts: reading(ending, last), captions: splitCaption(ending) };
  }
  return { ...board, scenes, hook: hook ? { ...board.hook, spoken: hook, on_screen: hook } : { ...board.hook, spoken: scenes[0]?.say ?? board.hook.spoken } };
}

/** 근거 점검이 화면 그래픽의 글자만 잡았으면 그 그래픽을 뺀다. 그래픽은 없어도 영상이 되고, 말은 건드리지 않는다. 끝 카드는 남긴다. */
export function stripFlaggedGraphics(board: Storyboard, issues: { kind: string; detail: string }[]): { board: Storyboard; removed: number; unresolved: number } {
  let removed = 0;
  let unresolved = 0;
  const scenes = board.scenes.map((s) => ({ ...s }));
  for (const issue of issues) {
    const sentence = issue.kind === "grounding" ? issue.detail.match(/근거 없음: "([^"]+)"/)?.[1] : null;
    if (!sentence) {
      unresolved++;
      continue;
    }
    const target = squash(sentence);
    let hit = false;
    for (const s of scenes) {
      const kept = s.graphics.filter((g) => {
        // 점검은 화면에 보이는 순서로 인용해 그래픽의 칸 순서와 다를 수 있다. 칸마다 글자가 인용문에 있는지 본다
        const pieces = graphicTexts(g).map(squash).filter(Boolean);
        const flagged = g.type !== "end_card" && pieces.length > 0 && (pieces.join("").includes(target) || pieces.every((p) => target.includes(p)));
        if (flagged) hit = true;
        return !flagged;
      });
      removed += s.graphics.length - kept.length;
      s.graphics = kept;
    }
    if (!hit) unresolved++;
  }
  return { board: { ...board, scenes }, removed, unresolved };
}

function boardAsScript(board: Storyboard): ScriptOutput {
  return {
    hooks: [{ formula_id: 0, spoken: board.hook.spoken, on_screen: board.hook.on_screen }],
    chosen_hook: 0,
    beats: board.scenes.map((s, i) => ({ spoken: s.say, on_screen: i === 0 ? board.hook.on_screen : [...s.graphics.flatMap(graphicTexts), ...(s.motion ? motionTexts(s.motion) : [])].join(" "), visual: s.shows })),
    loop_word: "",
    caption: board.caption,
  };
}

/** 상세페이지 소재를 전부 받는다. 사진은 사진 후보로, 움직이는 이미지는 영상 소재로 나눈다. */
async function detailAssets(urls: string[], dir: string): Promise<{ images: string[]; gifs: string[] }> {
  mkdirSync(dir, { recursive: true });
  const images: string[] = [];
  const gifs: string[] = [];
  for (const [i, url] of [...new Set(urls)].slice(0, MAX_DETAIL_FILES).entries()) {
    // 한 장이 안 받아져도 나머지로 만든다
    try {
      const res = await fetch(url, { headers: { "User-Agent": "MCB-Video/1.0" } });
      if (!res.ok) throw new Error(String(res.status));
      const bytes = Buffer.from(await res.arrayBuffer());
      const gif = isGif(bytes);
      const f = join(dir, `d${i}${gif ? ".gif" : url.toLowerCase().includes(".png") ? ".png" : ".jpg"}`);
      writeFileSync(f, bytes);
      if (gif && isAnimatedGif(f)) gifs.push(f);
      else images.push(f);
    } catch (e) {
      console.warn(`  이미지 ${i + 1} 내려받기 실패(${e instanceof Error ? e.message : e})`);
    }
  }
  return { images, gifs };
}

/** 이 목소리의 말 속도(초당 글자)를 잰다. 대본 분량을 영상마다 실제 음성에 맞춘다. */
async function measureSpeechRate(voiceId: string | null | undefined, workDir: string): Promise<number> {
  try {
    const kit = editKit();
    const buf = await fishTts(CALIBRATION_TEXT, { ...kit.voice, id: voiceId || process.env.FISH_VOICE_ID || kit.voice.id });
    if (!buf) return DEFAULT_SPEECH_RATE;
    const file = join(workDir, "calibration.wav");
    writeFileSync(file, buf);
    const span = voicedSpan(file);
    const seconds = span.to - span.from;
    const rate = seconds > 1 ? squash(CALIBRATION_TEXT).replace(/[.,]/g, "").length / seconds : DEFAULT_SPEECH_RATE;
    return Math.min(9.5, Math.max(5, rate));
  } catch (e) {
    console.warn("  말 속도를 재지 못해 기본값을 써요:", e instanceof Error ? e.message : e);
    return DEFAULT_SPEECH_RATE;
  }
}

interface Candidate {
  id: string;
  file: string;
  w: number;
  h: number;
  native_w?: number;
  native_h?: number;
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
  accountId: string;
  account: string;
  productId: string;
  concept: AccountConcept;
  rules: ContentRule[];
  dryRun: boolean;
  workDir: string;
  /** 시험(--dry-run)에서만: 저장해 둔 장면표로 바로 영상을 만든다. 각도 · 장면표 쓰기를 건너뛴다 */
  savedBoard?: Storyboard;
}) {
  const { service, planId, account, productId, rules, workDir } = input;
  const facts = await loadProductFacts(service, productId);
  if (facts.stockStatus !== "available") throw new StopError(`지금 판매 중이 아닌 상품이에요 (${facts.stockStatus})`);
  // 저장하지 않는 시험에서만 지금 계정 설정의 컨셉 · 스타일 · 고정 문구를 빼고 새 구조를 본다. 말투 · 목소리는 그대로 둔다
  const ignoreSaved = input.dryRun && process.env.TEST_IGNORE_SAVED_CONCEPT === "1";
  const concept: AccountConcept = ignoreSaved ? { ...input.concept, autoConcept: "", autoVideoStyle: "", autoHooks: [], autoEndings: [] } : input.concept;
  if (ignoreSaved) console.log("  (시험) 저장된 컨셉 · 영상 스타일 · 고정 문구 제외");
  const { data: product } = await service.from("products").select("detail_image_urls, represent_image_url").eq("id", productId).maybeSingle();

  // 1. 상세페이지에서 사진 구간만 잘라 후보로
  // 대표 이미지는 제품만 찍힌 사진인 경우가 많아 맨 앞에 넣는다
  const urls = [...(product?.represent_image_url ? [product.represent_image_url] : []), ...(product?.detail_image_urls ?? [])];
  const { images, gifs: gifFiles } = await detailAssets(urls, join(workDir, "detail"));
  const gifs = prepareGifAssets(gifFiles, workDir);
  console.log(`  상세 소재 사진 ${images.length}개 · 움직이는 이미지 ${gifs.length}개`);
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

  // 재료 판단: 원본 해상도가 낮으면 후보에서 뺀다. 세로 영상에서 흐려진다
  const sharp = candidates.filter((c) => Math.min(c.native_w ?? c.w, (c.native_h ?? c.h) * 1.4) >= MIN_NATIVE);
  console.log(`  화질 통과 사진 ${sharp.length}개 / ${candidates.length}개`);
  if (sharp.length + gifs.length + archive.length < MIN_MATERIALS) throw new StopError(`쓸 수 있는 이미지가 ${sharp.length + gifs.length + archive.length}개뿐이에요. 제품이 잘 보이는 사진이 더 필요해요.`);
  const sharpIds = new Set(sharp.map((c) => c.id));
  const sheets = (blocks?.sheets ?? []).map((f) => imageDataUrl(f));
  const gifSheets = gifs.map((g) => imageDataUrl(g.sheet));

  // 상식 카드와 우리 차이. 사람이 승인한 것만 쓴다. 초안은 저장하지 않는 시험에서만 명시적으로 켠다
  const includeDrafts = input.dryRun && process.env.TEST_USE_DRAFT_KNOWLEDGE === "1";
  const knowledge = await loadVideoKnowledge(service, input.organizationId, facts, { includeDrafts });
  console.log(`  근거: 상식 카드 ${knowledge.cards.length}개 · 우리 차이 ${knowledge.differences.length}개${includeDrafts ? " (시험: 초안 포함)" : ""}`);
  const visualPolicy: VisualPolicy = { ...LONG_VISUALS, evidence: knowledge.cards.map((c) => c.statement).join(" ") };

  // 대본 분량을 이 목소리의 실제 말 속도에 맞춘다
  const speechRate = await measureSpeechRate(concept.autoVoiceId, workDir);
  const charLimits = charRange(speechRate);
  console.log(`  말 속도 초당 ${speechRate.toFixed(1)}자 → 대본 ${charLimits[0]}~${charLimits[1]}자`);

  // 저장한 후킹 · 마지막 문구는 장면표에 그대로 쓴다
  const hasPhrases = concept.autoHooks.length > 0 || concept.autoEndings.length > 0;
  const phrases = await preparePhrases({
    facts,
    rules,
    hooks: concept.autoHooks,
    endings: concept.autoEndings,
    recent: hasPhrases ? await recentTemplates(service, input.accountId, "B", kstDate(-14)) : [],
  });
  let tokens = { input: phrases.tokens.input, output: phrases.tokens.output };
  const add = (t: { input: number; output: number }) => {
    tokens = { input: tokens.input + t.input, output: tokens.output + t.output };
  };
  const materialCheck = await reviewHookMaterials({ hooks: phrases.hooks.map((h) => h.text), sheets: [...sheets, ...gifSheets], archive: archive.map((a) => a.what), facts });
  add(materialCheck.tokens);
  const rejectedHooks = new Map(materialCheck.rejected.map((r) => [r.index, r.why]));
  phrases.hooks = phrases.hooks.filter((h, i) => {
    const why = rejectedHooks.get(i);
    if (!why) return true;
    phrases.rejected.push({ kind: "hook", template: h.template, why, afterCheck: true });
    console.log(`  소재와 맞지 않는 후킹 제외: ${h.text} — ${why}`);
    return false;
  });

  const visualLibrary = await loadVisualLibrary(service);

  // 글꼴 후보. 스킬을 못 읽으면 후보 없이 쓰고, 영상은 대체 글꼴로 만든다
  const skillDir = captionSkillDir();
  let fontChoices: SkillFont[] = [];
  try {
    if (skillDir) fontChoices = loadSkillFonts(skillDir);
  } catch (e) {
    console.warn("  스킬 글꼴 목록을 읽지 못했어요:", e instanceof Error ? e.message : e);
  }

  // 사진 나누기는 시간이 걸려 같은 사진 · 같은 잘라 내기면 다시 하지 않는다
  const layerCache = new Map<string, PhotoLayers>();
  const trimmedLayers = (id: string, top: number, bottom: number): PhotoLayers | null => {
    const key = `${id}:${top}:${bottom}`;
    const hit = layerCache.get(key);
    if (hit) return hit;
    const cand = candidates.find((c) => c.id === id);
    if (!cand) return null;
    const made = photoLayers(trimPhoto(cand, top, bottom, workDir), workDir, `photo-${id}-${layerCache.size}`);
    layerCache.set(key, made);
    return made;
  };

  // 이야기 각도: 저장한 후킹이 없으면 서로 다른 각도를 내고, 상품 사정을 모르는 눈으로 가장 궁금한 것부터 쓴다
  let angles: StoryAngle[] = [];
  let angleOrder: number[] = [];
  let angleScores: number[] = [];
  let anglePos = 0;
  const savedBoard = input.dryRun ? input.savedBoard : undefined;
  if (savedBoard) console.log("  (시험) 저장된 장면표로 바로 영상을 만든다");
  if (!phrases.hooks.length && !savedBoard) {
    const written = await writeAngles({ accountName: account, facts, knowledge });
    add(written.tokens);
    angles = written.angles;
    const ranked = await rankAngles(angles);
    add(ranked.tokens);
    angleOrder = ranked.order;
    angleScores = ranked.scores;
    angleOrder.forEach((i) => console.log(`  각도 ${angleScores[i]}점 [${angles[i].situation}] ${angles[i].hook_line}`));
  }

  // 2. 장면표: 쓰고, 코드 · 시청자 눈 · 광고 규칙으로 보고, 걸리면 고쳐 쓴다
  let board: Storyboard | null = savedBoard ?? null;
  let retry: { board: Storyboard; problems: string[]; earlier?: string[] } | null = null;
  let left: string[] = [];
  const storyboardReviews: unknown[] = [];
  let boardNotes: string[] = [];
  let softLeft: string[] = [];
  // 못 쓰는 사진 때문에 다시 쓰는 횟수는 따로 센다. 말을 점검하기 전에 걸러 토큰을 아낀다
  let photoRetries = 3;
  // 앞 회차들에서 받은 지적. 다시 쓸 때 함께 넘겨, 이번 지적을 고치다 앞서 고친 것이 다시 깨지지 않게 한다
  let history: string[] = [];
  const retryWith = (b: Storyboard, problems: string[]) => ({ board: b, problems, earlier: history.filter((h) => !problems.includes(h)).slice(-12) });
  // 점검을 마친 장면표 가운데 남은 문제가 가장 적은 것(같으면 나중 것). 뒤 회차가 더 나빠지거나 AI 답이 깨져도 이걸 쓴다
  let best: { board: Storyboard; left: string[]; soft: string[]; notes: string[] } | null = null;
  let lastError = "";
  const fixedTexts = () => [phrases.hooks[0]?.text, phrases.endings[0]?.text].filter((t): t is string => !!t);
  for (let attempt = 0; !savedBoard && attempt < MAX_BOARD_TRIES; attempt++) {
    let res: Awaited<ReturnType<typeof writeStoryboard>>;
    try {
      res = await writeStoryboard({
      service: input.dryRun ? null : service,
      readService: service,
      planId,
      accountName: account,
      roleFocus: concept.autoRole,
      facts,
      rules,
      candidates: sharp.filter((c) => sharpIds.has(c.id)).map((c) => ({ id: c.id, w: c.w, h: c.h })),
      sheets,
      archive: archive.map((a) => ({ id: a.id, what: a.what, seconds: a.seconds })),
      archiveSheets: archive.map((a) => imageDataUrl(a.sheet)),
      gifs: gifs.map((g) => ({ id: g.id, w: g.w, h: g.h, seconds: g.seconds })),
      gifSheets,
      knowledge,
      charLimits,
      angle: angles.length ? angles[angleOrder[anglePos]] : null,
      concept: concept.autoConcept,
      tone: concept.autoTone,
      videoStyle: concept.autoVideoStyle,
      phraseBlock: fixedPhraseBlock(phrases),
      visualLibrary,
      fontChoices,
      // 처음에는 후보 수로 어림하고, 다시 쓸 때는 앞 장면표에서 실제로 쓸 수 있던 소재 수로 정한다
      repeatLimit: board ? repeatLimit(realMaterialCount(board, archiveIds), board.scenes.length) : repeatLimit(sharpIds.size + gifs.length + archive.length, 20),
      retry,
      });
    } catch (e) {
      // AI 답이 길이 한도를 넘는 등 형식이 깨지면 이번 회차만 버린다. 앞서 쓴 장면표와 고칠 목록은 그대로 두고 다시 쓴다
      if (e instanceof StopError) throw e;
      lastError = e instanceof Error ? e.message : String(e);
      storyboardReviews.push({ attempt: attempt + 1, problems: [`AI 답 오류: ${lastError}`] });
      console.log(`  장면표 ${attempt + 1}번째: AI 답을 받지 못해 다시 쓴다 (${lastError.slice(0, 120)})`);
      continue;
    }
    add(res.tokens);
    // 다시 쓴 답이 비어 있으면 앞서 쓴 장면표를 버리지 않는다
    if (!res.output.scenes.length || res.output.scenes.some((s) => !s.say.trim() || !s.tts.trim())) {
      storyboardReviews.push({ attempt: attempt + 1, problems: ["빈 장면표/말이 빈 장면"], board: res.output });
      console.log(`  장면표 ${attempt + 1}번째: 말이 빈 장면이 있어 다시 쓴다`);
      if (board) retry = retryWith(board, [...left, "쓸 수 있는 사진이 1~2개여도 해당 사진과 정보 도식(motion)으로 완성한다. 모든 장면에 say와 tts를 쓴다. 빈 배열로 답하지 않는다"]);
      continue;
    }
    board = applyFixedPhrases(res.output, phrases);
    // 설명 화면 · AI 이미지 · 스톡은 후보 번호가 없어 장면 순서로 번호를 붙인다. AI 이미지는 visual 장면에만 얹는다
    const scenes = board.scenes.map((s, i) => (s.source === "motion" ? { ...s, source_id: `m${i}` } : s.source === "visual" ? { ...s, source_id: `v${i}` } : s.source === "stock" ? { ...s, source_id: `s${i}` } : s));
    board = repairEdgeVisuals({ ...board, scenes, visuals: board.visuals.filter((v) => scenes[v.beat]?.source === "visual") });
    // 세로 화면에서 제품이 많이 잘리는 사진과, 제품이 아닌데 오려야 하는 사진(손 · 사용 장면)은 쓰지 않는다. 후보에서 빼고 다시 쓰게 한다
    const dropped: string[] = [];
    for (const s of board.scenes) {
      if (s.source !== "photo" || !sharpIds.has(s.source_id)) continue;
      const meta = board.photos.find((p) => p.id === s.source_id);
      const mode = meta && trimmedLayers(meta.id, meta.trim_top, meta.trim_bottom)?.mode;
      if (meta && (mode === "unfit" || (mode === "float" && meta.kind !== "product"))) {
        console.log(`  ${meta.id} 사진은 세로 화면에 맞지 않아 후보에서 뺌 (${mode}, ${meta.kind})`);
        sharpIds.delete(meta.id);
        dropped.push(meta.id);
      }
    }
    board = { ...board, photos: board.photos.map((p) => (sharpIds.has(p.id) ? p : { ...p, usable: false })) };
    if (dropped.length && photoRetries > 0) {
      photoRetries--;
      attempt--;
      retry = retryWith(board, [...left, `${dropped.join(", ")} 사진은 세로 화면에 맞지 않아 쓸 수 없다. 다른 후보나 설명 화면(motion)으로 바꾼다`]);
      continue;
    }
    // 같은 소재를 너무 많이 쓴 장면 · 넘치는 설명 화면은 다시 쓰게 하지 않고 AI 이미지로 바꾼다
    const overflow = repairOverflow(board, archiveIds);
    if (overflow.converted.length) {
      board = overflow.board;
      console.log(`  ${overflow.converted.join(", ")}번 장면을 AI 이미지로 바꿈 (같은 소재 ${overflow.limit}번까지 · 연달아 같은 소재 금지 · 설명 화면 25% 이하)`);
      try {
        // 빠진 장면이 있으면 그 장면만 한 번 더 쓴다
        for (let pass = 0; pass < 2; pass++) {
          const missing = overflow.converted.filter((i) => !board!.visuals.some((v) => v.beat === i));
          if (!missing.length) break;
          const filled = await writeSceneVisuals({ board, beats: missing, facts, knowledge, visualLibrary });
          add(filled.tokens);
          board = { ...board, visuals: [...board.visuals, ...filled.visuals] };
        }
        const stillMissing = overflow.converted.filter((i) => !board!.visuals.some((v) => v.beat === i));
        if (stillMissing.length) console.warn(`  ${stillMissing.join(", ")}번 장면의 AI 이미지 설명을 받지 못했어요`);
      } catch (e) {
        console.warn(`  바꾼 장면의 AI 이미지 설명을 쓰지 못했어요: ${e instanceof Error ? e.message : e}`);
      }
    }
    const code = [...storyboardProblems(board, archiveIds, phrases.hooks.length > 0, { knowledge, charLimits }), ...hookEvidenceProblems(board, archive)];
    // 길이는 글자 수로 storyboardProblems가 재고, 완성본의 실제 길이를 다시 잰다.
    const estimated = board.scenes.reduce((n, s) => n + squash(s.tts).length, 0) / speechRate;
    const boardCheck = () => checkScript(boardAsScript(board!), facts, rules, account, { fixedHook: true, fixedTexts: fixedTexts(), knowledge, seconds: estimated, lengthRange: [0, 999], longBeatSeconds: LONG_BEAT_SECONDS });
    let check: Awaited<ReturnType<typeof checkScript>>;
    let review: Awaited<ReturnType<typeof reviewStoryboard>>;
    try {
      check = await boardCheck();
      add(check.tokens);
      // 말은 통과했는데 화면 그래픽 글자만 걸리면 그 그래픽을 빼고 다시 본다. 대본 전체를 다시 쓰지 않는다
      const stripped = stripFlaggedGraphics(board, blockingIssues(check.issues));
      if (stripped.removed > 0 && stripped.unresolved === 0) {
        console.log(`  근거가 맞지 않는 화면 그래픽 ${stripped.removed}개 제외`);
        board = stripped.board;
        check = await boardCheck();
        add(check.tokens);
      }
      review = await reviewStoryboard({ board, facts, knowledge, sheets: [...sheets, ...gifSheets], fixedTexts: fixedTexts() });
      add(review.tokens);
    } catch (e) {
      // 점검 답이 깨지면 이 장면표는 점검을 못 받은 것으로 보고 버린다. 고칠 목록은 앞 회차 그대로 다시 쓴다
      if (e instanceof StopError) throw e;
      lastError = e instanceof Error ? e.message : String(e);
      storyboardReviews.push({ attempt: attempt + 1, problems: [`점검 답 오류: ${lastError}`] });
      console.log(`  장면표 ${attempt + 1}번째: 점검 답을 받지 못해 다시 쓴다 (${lastError.slice(0, 120)})`);
      continue;
    }
    const blockingNow = blockingIssues(check.issues).map((i) => i.detail);
    left = [...code, ...blockingNow, ...review.problems, ...review.unsuitable_phrases.map((p) => `${p.kind}: ${p.reason}`)];
    // 재미 · 후킹 점수는 다시 쓰게 하는 이유로만 쓴다. 마지막까지 낮으면 멈추지 않고 사람이 볼 경고로 남긴다
    const soft: string[] = [];
    if (review.interest < MIN_INTEREST) soft.push(`재미 점수 ${review.interest}점이다. 끝까지 볼 이유가 약하다. ${review.boringParts.join(" / ")}`.trim());
    if (!phrases.hooks.length) {
      const hookScore = scoreHooks([board.hook.spoken])[0];
      if (hookScore && hookScore.score < MIN_AUTO_HOOK_SCORE) soft.push(`첫 문장 "${board.hook.spoken}" 점수가 ${hookScore.score}점이다. 시청자의 오해 · 손해 · 놀라움과 이어지는 구체적인 문장으로 바꾼다`);
    }
    storyboardReviews.push({ attempt: attempt + 1, hook: board.hook, situation: board.situation, worry: board.worry, oneThing: board.one_thing, interest: review.interest, problems: left, soft, notes: review.notes, boring: review.boringParts });
    boardNotes = [...review.notes, ...review.boringParts.map((b) => `지루할 수 있는 구간: ${b}`)];
    softLeft = soft;
    if (!best || left.length <= best.left.length) best = { board, left, soft, notes: boardNotes };
    console.log(`  장면표 ${attempt + 1}번째: 코드 ${code.length} · 규칙/근거 ${blockingNow.length} · 시청자 ${review.problems.length} · 재미 ${review.interest}점 · ${board.situation} · ${board.one_thing}`);
    for (const p of left) console.log(`    - ${p.slice(0, 160)}`);
    if (!left.length && (!soft.length || attempt === MAX_BOARD_TRIES - 1)) break;
    rejectIncompatiblePhrases(phrases, [...review.unsuitable_phrases, ...code.filter((p) => p.includes("제형을 보라고")).map((reason) => ({ kind: "hook" as const, reason }))]);
    dropFailedPhrases(phrases, blockingIssues(check.issues));
    // 재미가 낮으면 문장을 고치지 않고 다음 각도로 새로 쓴다
    if (review.interest < MIN_INTEREST && !left.length && anglePos < angleOrder.length - 1) {
      anglePos++;
      retry = null;
      // 각도가 바뀌면 앞 각도의 지적은 맞지 않을 수 있어 비운다
      history = [];
      console.log(`  재미가 낮아 다음 각도로 바꾼다: ${angles[angleOrder[anglePos]].hook_line}`);
      continue;
    }
    retry = retryWith(board, [...left, ...soft]);
    for (const p of left) if (!history.includes(p)) history.push(p);
  }
  if (!savedBoard) {
    if (!best) throw new Error(lastError ? `장면표를 만들지 못했어요: ${lastError}` : "장면표를 만들지 못했어요");
    // 마지막 회차가 더 나빠졌거나 깨졌으면, 남은 문제가 가장 적었던 장면표로 만든다
    if (best.board !== board) console.log(`  남은 문제가 가장 적은 장면표(${best.left.length}개)로 만든다`);
    board = best.board;
    left = best.left;
    softLeft = best.soft;
    boardNotes = best.notes;
  }
  if (!board) throw new Error("장면표를 만들지 못했어요");
  writeFileSync(join(workDir, "storyboard-review.json"), JSON.stringify({ angles: angleOrder.map((i) => ({ score: angleScores[i], ...angles[i] })), attempts: storyboardReviews, phrases: fixedRecord(phrases), board }, null, 2));
  if (left.length) throw new StopError(`장면표를 ${MAX_BOARD_TRIES}번 고친 뒤에도 해결되지 않았어요: ${left.join(" / ")}`);

  // 3. 이미지 → 컷. 같은 사진을 또 쓰면 앞 장면이 끝난 곳부터 잇는다
  // AI가 고른 글꼴을 자막 · 설명 화면이 함께 쓴다. 못 받으면 설명 화면만 대체 글꼴로 만든다
  const finalBoard = board;
  const pickedFonts = fontChoices.length ? chosenFonts(fontChoices, { key_font: finalBoard.key_font, small_font: finalBoard.small_font }) : null;
  if (pickedFonts) console.log(`  글꼴: ${pickedFonts.key.name} + ${pickedFonts.small.name}`);
  let motionFonts: VideoFonts | undefined;
  const clips: KitClip[] = [];
  const sources: unknown[] = [];
  const warnings: string[] = [...softLeft, ...boardNotes.map((n) => `장면표 의견: ${n}`)].map((n) => n.slice(0, 300));
  if (pickedFonts && finalBoard.scenes.some((s) => s.source === "motion")) {
    try {
      motionFonts = await downloadVideoFonts(pickedFonts, workDir);
    } catch (e) {
      warnings.push(`고른 글꼴을 받지 못해 설명 화면은 대체 글꼴로 만들었어요. (${e instanceof Error ? e.message : e})`.slice(0, 300));
    }
  }
  const clipNo = new Map<string, number>();
  const used = new Map<string, number>();
  // AI 이미지를 못 만들면 상품 사진이 대신 나간다
  const fallbackPhoto = finalBoard.photos.find((p) => p.usable && p.kind === "product" && p.upright)?.id ?? finalBoard.photos.find((p) => p.usable && p.kind !== "product")?.id;
  const clipOf = (id: string, kind: "photo" | "archive" | "gif"): number | null => {
    if (clipNo.has(id)) return clipNo.get(id)!;
    const no = clips.length + 1;
    if (kind === "gif") {
      const asset = gifs.find((g) => g.id === id);
      const meta = finalBoard.gifs.find((g) => g.id === id);
      if (!asset || !meta) return null;
      const made = gifClip(asset, meta, workDir);
      if (made.soft) warnings.push(`${id} 움직이는 이미지(${meta.what})는 원본 해상도가 낮아 영상에서 흐릴 수 있어요.`);
      clips.push(readClip(no, made.file, { shot: `[상세 움직임] ${meta.what}` }));
      sources.push({ no, kind: "gif", id, what: meta.what });
    } else if (kind === "archive") {
      const a = archive.find((x) => x.id === id);
      if (!a) return null;
      clips.push(readClip(no, a.file, { shot: `[자사 촬영] ${a.what}` }));
      sources.push({ no, kind: "archive", id: a.rowId, what: a.what });
    } else {
      const meta = finalBoard.photos.find((p) => p.id === id);
      const layers = meta && trimmedLayers(id, meta.trim_top, meta.trim_bottom);
      if (!meta || !layers) return null;
      const made = photoClip(layers, workDir, `photo-${id}`);
      if (made.soft) warnings.push(`${id} 사진(${meta.what})은 해상도가 낮아 영상에서 흐릴 수 있어요.`);
      clips.push(readClip(no, made.file, { shot: `[제품컷] ${meta.what}` }));
      sources.push({ no, kind: "photo", id, what: meta.what, mode: made.mode });
    }
    clipNo.set(id, no);
    return no;
  };
  const motionClipOf = (spec: NonNullable<Storyboard["scenes"][number]["motion"]>, i: number, seconds: number): number => {
    const made = motionClip(spec, workDir, `motion-${i}`, { seconds, fonts: motionFonts });
    const no = clips.length + 1;
    clips.push(readClip(no, made.file, { shot: `[코드 모션] ${made.shot}` }));
    sources.push({ no, kind: "motion", spec });
    return no;
  };
  // 스톡 영상: 장면마다 검색 → 얼굴 · 로고 · 글자 검수 → 세로 컷. 못 찾으면 상품 사진이 대신 나가고 경고를 남긴다
  const stockNo = new Map<number, number>();
  const usedStock = new Set<number>();
  const stockDir = join(workDir, "stock");
  for (const [i, s] of board.scenes.entries()) {
    if (s.source !== "stock") continue;
    mkdirSync(stockDir, { recursive: true });
    try {
      const pick = await stockClip(service, s.stock_query, s.shows || s.say, stockDir, `stock-${i}`, usedStock);
      if (pick) {
        add(pick.tokens);
        const no = clips.length + 1;
        clips.push(readClip(no, pick.file, { shot: `[스톡] ${pick.shot}` }));
        sources.push({ no, kind: "stock", ...pick.source });
        stockNo.set(i, no);
        continue;
      }
      warnings.push(`${i}번 장면 스톡 영상("${s.stock_query}")에서 쓸 수 있는 영상을 찾지 못해 AI 이미지로 대신했어요.`);
    } catch (e) {
      warnings.push(`${i}번 장면 스톡 영상을 받지 못해 AI 이미지로 대신했어요. (${e instanceof Error ? e.message : e})`.slice(0, 300));
    }
    console.warn(`  ${warnings.at(-1)}`);
  }
  // 스톡을 못 찾은 장면은 AI 이미지로 바꾼다(영상당 AI 이미지 한도 안에서, 마지막 장면 제외).
  // 한도를 넘거나 그림 설명을 못 받은 장면은 아래 기본 컷이 그대로 나간다
  const stockMissed = board.scenes.map((s, i) => (s.source === "stock" && !stockNo.has(i) ? i : -1)).filter((i) => i >= 0);
  if (stockMissed.length) {
    const room = Math.max(0, LONG_VISUALS.max - board.scenes.filter((s) => s.source === "visual").length);
    const toVisual = new Set(stockMissed.filter((i) => i !== board!.scenes.length - 1).slice(0, room));
    if (toVisual.size) {
      board = { ...board, scenes: board.scenes.map((s, i) => (toVisual.has(i) ? { ...s, source: "visual" as const, source_id: `v${i}`, motion: null, stock_query: "" } : s)) };
      try {
        const filled = await writeSceneVisuals({ board, beats: [...toVisual], facts, knowledge, visualLibrary });
        add(filled.tokens);
        board = { ...board, visuals: [...board.visuals.filter((v) => !toVisual.has(v.beat)), ...filled.visuals] };
        console.log(`  스톡을 못 찾은 ${[...toVisual].join(", ")}번 장면을 AI 이미지로 바꿈 (그림 설명 ${filled.visuals.length}개)`);
      } catch (e) {
        warnings.push(`스톡을 못 찾은 장면의 AI 이미지 설명을 쓰지 못해 기본 컷으로 대신했어요. (${e instanceof Error ? e.message : e})`.slice(0, 300));
        console.warn(`  ${warnings.at(-1)}`);
      }
    }
  }
  // AI 이미지 장면 · 스톡을 못 찾은 장면 밑에 까는 기본 컷. 상품 사진 → 움직이는 이미지 → 찾은 스톡 순서로 고른다.
  // AI 이미지가 만들어지면 이 컷은 화면에 나오지 않고, 그림을 못 만들면 이 컷이 나간다
  const fallbackGif = finalBoard.gifs.find((g) => g.usable && gifs.some((a) => a.id === g.id))?.id;
  const firstStock = stockNo.values().next().value as number | undefined;
  const fallbackKey = fallbackPhoto ?? fallbackGif ?? (firstStock ? `stock-clip-${firstStock}` : null);
  const fallbackClip = (): number | null => (fallbackPhoto ? clipOf(fallbackPhoto, "photo") : fallbackGif ? clipOf(fallbackGif, "gif") : firstStock ?? null);
  if (!fallbackPhoto) {
    warnings.push(`쓸 수 있는 상품 사진이 없어 AI 이미지 · 스톡 장면의 기본 컷을 ${fallbackGif ? `움직이는 이미지(${fallbackGif})` : firstStock ? "찾은 스톡 영상" : "만들 수 없었어요"}${fallbackGif || firstStock ? "로 썼어요" : ""}.`);
    console.warn(`  ${warnings.at(-1)}`);
  }
  const beats: EditPlan["beats"] = [];
  board.scenes.forEach((s, i) => {
    const want = Math.max(1.2, squash(s.tts).length / speechRate + 0.25);
    const stockFallback = s.source === "stock" && !stockNo.has(i);
    const no =
      s.source === "motion" ? (s.motion ? motionClipOf(s.motion, i, want) : null)
      : s.source === "stock" ? (stockNo.get(i) ?? fallbackClip())
      : s.source === "visual" ? fallbackClip()
      : clipOf(s.source_id, s.source);
    if (!no) throw new Error(`${i}번 장면(${s.source_id})에 쓸 컷이 없어요. 쓸 수 있는 상품 사진 · 움직이는 이미지 · 스톡이 하나도 없어요`);
    const seconds = clips[no - 1].duration;
    // 설명 화면은 장면마다 새로 만든 컷이라 늘 0초부터 쓴다(등장 움직임이 빠지지 않게).
    // AI 이미지 장면과 스톡을 못 찾은 장면은 대신 쓰는 기본 컷의 기록을 이어 쓴다
    const key = s.source === "motion" ? null : s.source === "visual" || stockFallback ? fallbackKey : s.source_id;
    const from = key ? Math.min(used.get(key) ?? 0, Math.max(0, seconds - want)) : 0;
    const to = Math.min(seconds, from + want);
    if (key) used.set(key, to);
    beats.push({
      mode: "tts",
      tts: s.tts,
      captions: i === 0 ? [] : s.captions.length && squash(s.captions.join("")) === squash(s.say) ? s.captions : splitCaption(s.say),
      emphasis: s.emphasis,
      cuts: [{ clip: no, in: from, out: to, what: s.shows }],
      // 글자 없는 그래픽은 빈 막대로 나온다
      graphics: i === 0 ? [] : s.graphics.filter((g) => graphicTexts(g).length > 0),
      sfx: s.sfx.filter((x) => s.say.includes(x.at_word)).map((x) => ({ name: x.name, at_word: x.at_word, at: 0 })),
    });
  });
  // 표지는 제품이 보이는 장면으로. 설명 화면 · AI 이미지를 골랐으면 첫 장면을 쓴다
  const coverAt = Math.min(Math.max(0, board.thumbnail.scene), beats.length - 1);
  const coverSource = board.scenes[coverAt]?.source;
  const coverScene = beats[coverSource === "motion" || coverSource === "visual" ? 0 : coverAt]?.cuts[0];
  const plan: EditPlan = {
    look: board.look,
    analysis: [],
    hook: board.hook,
    thumbnail: { title: board.thumbnail.title, highlight: board.thumbnail.highlight, position: board.thumbnail.position, sub: board.thumbnail.sub, clip: coverScene?.clip ?? 1, at: coverScene ? (coverScene.in + coverScene.out) / 2 : 1 },
    beats,
    visuals: board.visuals,
    warnings: [],
  };

  // 4. 음성 → 시간표 → 렌더. 컷 · 그래픽 · 자막이 낱말 시각에 맞춰진다. 자동 콘텐츠 설정만 넘긴다
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
    reusePlan: plan,
    tone: concept.autoTone,
    editStyleText: concept.autoVideoStyle,
    voiceId: concept.autoVoiceId,
    fonts: pickedFonts ? { key_font: pickedFonts.key.name, small_font: pickedFonts.small.name } : undefined,
    visualPolicy,
    reviewFinal: async (file, timeline) => {
      const every = Math.max(0.5, timeline.duration / 24);
      const sheetFile = join(workDir, "final-frames.jpg");
      ffmpeg(["-y", "-v", "error", "-i", file, "-vf", `fps=1/${every.toFixed(3)},scale=270:-2,tile=8x3`, "-frames:v", "1", "-q:v", "3", sheetFile]);
      // 연락판만 보면 짧은 자막을 놓친다. 모든 자막의 안정 구간을 휴대폰 크기로 별도 검사한다.
      const allTimes = timeline.captions.map((c) => (c.start + c.end) / 2);
      const step = Math.max(1, allTimes.length / MAX_REVIEW_FRAMES);
      const times = [Math.min(0.35, timeline.hook.end / 2), ...Array.from({ length: Math.min(MAX_REVIEW_FRAMES, allTimes.length) }, (_, n) => allTimes[Math.floor(n * step)])];
      const frames = times.map((at, i) => {
        const path = join(workDir, `readability-${i}.jpg`);
        ffmpeg(["-y", "-v", "error", "-ss", at.toFixed(3), "-i", file, "-frames:v", "1", "-vf", "scale=360:640", "-q:v", "2", path]);
        return { at, image: imageDataUrl(path) };
      });
      const review = await reviewFinalFrames({ sheet: imageDataUrl(sheetFile), frames, everySeconds: every, lines: timeline.lines.map((l) => ({ at: l.start, say: board!.scenes[l.beat]?.say ?? l.tts })) });
      add(review.tokens);
      return review;
    },
  });
  add(kit.tokens);

  const coverTexts = [kit.plan.thumbnail.title.replace(/\n+/g, " "), kit.plan.thumbnail.sub].filter(Boolean);
  const lastBeat = kit.plan.beats.length - 1;
  const script: ScriptOutput & { fixed?: unknown } = { ...boardAsScript(board), ...(hasPhrases ? { fixed: fixedRecord(phrases) } : {}) };
  const check = await checkScript(
    {
      ...script,
      // 근거 점검은 화면에 보이는 표기로 한다
      beats: kit.plan.beats.map((b, i) => ({ spoken: board!.scenes[i]?.say ?? b.tts, on_screen: [...(i === 0 ? [kit.plan.hook.on_screen] : []), ...b.graphics.flatMap(graphicTexts), ...(board!.scenes[i]?.motion ? motionTexts(board!.scenes[i].motion!) : []), ...(i === lastBeat ? coverTexts : [])].join(" "), visual: "" })),
    },
    facts,
    rules,
    account,
    { track: "B", seconds: kit.seconds, fixedHook: true, fixedTexts: fixedTexts(), knowledge, longBeatSeconds: LONG_BEAT_SECONDS, lengthRange: [AUTO_SECONDS[0] - LENGTH_TOLERANCE, AUTO_SECONDS[1] + LENGTH_TOLERANCE] },
  );
  // 처음 보는 사람 시험 — 상품 자료 없이 영상만 보고 답하게 한다. 멈추지 않고 사람이 볼 경고로 남긴다
  let firstViewer: Awaited<ReturnType<typeof firstViewerTest>> | null = null;
  try {
    const every = Math.max(0.5, kit.seconds / 24);
    const sheetFile = join(workDir, "first-viewer.jpg");
    ffmpeg(["-y", "-v", "error", "-i", kit.final, "-vf", `fps=1/${every.toFixed(3)},scale=270:-2,tile=8x3`, "-frames:v", "1", "-q:v", "3", sheetFile]);
    firstViewer = await firstViewerTest({ sheet: imageDataUrl(sheetFile), lines: board.scenes.map((s) => s.say), hasDifference: knowledge.differences.length > 0 });
    add(firstViewer.tokens);
    if (firstViewer.gaps.length) warnings.push(`처음 보는 사람 시험: 영상만 보고 알기 어려운 항목이 있어요. (${firstViewer.gaps.join(", ")})`);
  } catch (e) {
    console.warn("  처음 보는 사람 시험 실패:", e instanceof Error ? e.message : e);
  }
  const blocking = finalBlocking(
    { caption: board.caption.text, onScreen: [...kit.plan.beats.flatMap((b) => b.graphics.flatMap(graphicTexts)), kit.plan.hook.on_screen, ...board.scenes.flatMap((s) => (s.motion ? motionTexts(s.motion) : [])), ...coverTexts], subtitles: kit.plan.beats.flatMap((b) => b.captions) },
    { kind: facts.kind, rules, approvedClaims: facts.approvedClaims, stockStatus: facts.stockStatus, healthFunctional: facts.healthFunctional, certifiedFunctions: facts.certifiedFunctions },
  );
  if (!kit.quality?.passed) {
    check.passed = false;
    check.issues.push(...(kit.quality?.attempts.at(-1)?.issues.filter((i) => i.severity === "blocking").map((i) => ({ kind: "edit" as const, detail: `${i.at.toFixed(1)}초 ${i.detail}` })) ?? [{ kind: "edit" as const, detail: "완성본 검수가 완료되지 않았어요" }]));
  }
  return { kit, check, blocking, warnings: [...new Set([...warnings, ...kit.warnings])], sources, tokens, facts, script, board, storyboardReviews, phraseNotes: phraseNotes(phrases), knowledge, firstViewer, speechRate };
}

export class StopError extends Error {}
