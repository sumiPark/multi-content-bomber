import { join } from "node:path";
import { sfxNames, type EditPlan } from "@/lib/agents/edit-plan";
import type { ProductFacts } from "@/lib/agents/product-facts";
import type { Production, VoiceLine } from "@/lib/lemo/contract";
import { toPresetVoices } from "@/lib/lemo/voice";
import type { ContentRule } from "@/lib/rules/check";
import { CAPTION_FALLBACK_WARNING } from "@/lib/shoot/video-kit/caption-renderer";
import { captionSkillDir } from "@/lib/shoot/video-kit/caption-skill";
import { DEFAULT_LOOK, normalizeLook } from "@/lib/shoot/video-kit/caption-style";
import { readClip, renderKitEdit, type KitResult } from "@/lib/shoot/video-kit/pipeline";
import { layoutBeats } from "@/lib/shoot/video-kit/timeline";
import type { createServiceClient } from "@/lib/supabase/service";

// lemo 무음 화면 + 확정 음성 → 기존 편집 키트(renderKitEdit)로 음성 · 모션 자막 · 음악 · 효과음 · 표지를 얹는다.
// lemo 화면에는 나레이션 자막이 없다는 전제다. 자막은 자막 모션 스킬로만 얹고, 스킬을 못 쓰면 실패로 던진다(기본 자막으로 조용히 완료하지 않는다).
// 화면은 자르지도 늘리지도 않는다: 비트마다 lemo 영상의 같은 시각 구간을 1배속으로 잘라 이어 붙여 원래 영상이 그대로 나온다.
// AI 이미지 · 그래픽은 넣지 않는다(visualPolicy max 0, graphics 없음).

type Service = ReturnType<typeof createServiceClient>;

const CAPTION_CHARS = 16;
const SFX = new Set<string>(sfxNames);

/** 문장 부호에서 먼저 나누고, 긴 문장은 낱말을 자르지 않고 16자 안팎으로 나눈다. */
export function splitCaptions(text: string): string[] {
  const out: string[] = [];
  for (const sentence of (text.match(/(?:[^.?!。？！]|\.(?=\d))+[.?!。？！]*/g) ?? []).map((s) => s.trim()).filter(Boolean)) {
    let line = "";
    for (const word of sentence.split(/\s+/)) {
      if (line && `${line} ${word}`.length > CAPTION_CHARS) {
        out.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    if (line) out.push(line);
  }
  return out;
}

export interface ComposeInput {
  lemoVideo: string;
  voice: VoiceLine[];
  production: Production;
  script: string[];
  hook: { spoken: string; on_screen: string } | null;
  facts: ProductFacts;
  rules: ContentRule[];
  accountName: string;
  voiceId: string | null;
  workDir: string;
  service: Service | null;
  readService?: Service;
  tone?: string | null;
  // 배경음악 검색어 · 분위기. 없으면 스타일 기본값(STYLE_MUSIC). 키트가 영상마다 검색하고, 못 찾을 때만 대체 곡을 쓴다
  music?: { query: string; intent: string } | null;
}

/** 스타일별 배경음악 기본 검색어. 연출 AI · 계정 설정이 값을 주면 그 값을 쓴다. */
export const STYLE_MUSIC: Record<string, { query: string; intent: string }> = {
  "crayon-book": { query: "gentle ukulele music box", intent: "그림책을 넘기는 듯한 따뜻하고 가벼운 음악" },
  "midcentury-toon": { query: "playful retro jazz", intent: "1950년대 교육 영상 같은 경쾌한 음악" },
};
const DEFAULT_MUSIC = { query: "light acoustic background", intent: "말을 가리지 않는 가벼운 음악" };

/** lemo 장면 데이터 · 음성으로 편집 계획을 만든다. 렌더는 하지 않는다(시험에서 계획만 볼 때도 쓴다). */
export function buildLemoPlan(input: Omit<ComposeInput, "service" | "readService" | "workDir" | "rules" | "voiceId" | "accountName" | "tone">, clipSeconds: number): { plan: EditPlan; dropped: string[] } {
  const { voice, production: p } = input;
  if (!voice.length) throw new Error("음성 줄이 없어요");
  const dropped: string[] = [];
  const hookText = (input.hook?.on_screen || input.script[0] || voice[0].text).trim();
  const first = p.scenes[0];

  // 효과음은 시각이 든 줄(없으면 바로 앞 줄)의 비트로 옮긴다. 줄 사이 빈 구간의 효과음은 그 앞 줄 끝으로 붙는다
  const sfxOf = new Map<number, EditPlan["beats"][number]["sfx"]>();
  for (const s of p.sfx) {
    if (!SFX.has(s.name)) {
      dropped.push(`효과음 ${s.name}(${s.t.toFixed(2)}초)은 편집 키트에 없어 뺐어요`);
      continue;
    }
    // 실제 시각은 renderKitEdit의 presetSfx(영상 기준 초)로 넘긴다. 비트에는 기록용으로만 남긴다(말 사이 효과음도 옮기지 않는다)
    const i = Math.max(0, voice.findLastIndex((v) => v.start <= s.t + 1e-6));
    const v = voice[i];
    const at = Math.min(1, Math.max(0, (s.t - v.start) / Math.max(0.05, v.end - v.start)));
    sfxOf.set(i, [...(sfxOf.get(i) ?? []), { name: s.name as (typeof sfxNames)[number], at_word: "", at: Number(at.toFixed(3)) }]);
  }

  // 계정 · 영상 스타일 색: 강조색은 브랜드 팔레트 첫 색. 나머지는 기본(자막 모양은 모션 스킬이 정한다)
  const music = input.music ?? STYLE_MUSIC[p.style.slug] ?? DEFAULT_MUSIC;
  const look = normalizeLook({
    ...DEFAULT_LOOK,
    accent_color: p.brand.palette[0] ?? DEFAULT_LOOK.accent_color,
    reading: `lemo ${p.style.slug} 스타일 색`,
    music_query: music.query,
    music_intent: music.intent,
  });
  const draft: EditPlan = {
    look,
    analysis: [],
    hook: { on_screen: hookText, highlight: "", position: first?.caption_place === "lower" ? "lower" : "top", spoken: input.hook?.spoken || voice[0].text },
    thumbnail: { title: hookText, highlight: "", position: first?.caption_place === "lower" ? "lower" : "top", sub: "", clip: 1, at: first ? (first.start + first.end) / 2 : 0.5 },
    beats: voice.map((v, i) => ({
      mode: "tts" as const,
      tts: v.text,
      // 첫 줄은 후킹 글자가 자막을 대신한다(AI 자동과 같다)
      captions: i === 0 ? [] : splitCaptions(input.script[i] ?? v.text),
      emphasis: [],
      cuts: [{ clip: 1, in: 0, out: 0, what: p.scenes.find((s) => s.beat === i)?.purpose ?? "" }],
      graphics: [],
      sfx: sfxOf.get(i) ?? [],
    })),
    visuals: [],
    warnings: [],
  };
  // 편집 키트와 같은 계산으로 비트 구간을 잡고, 그 구간 그대로 lemo 영상을 자른다(1배속, 화면이 밀리지 않는다)
  const layout = toPresetVoices(voice).layout;
  const spans = layoutBeats(draft, voice.map((v) => ({ file: v.file, fileIn: v.fileIn, fileOut: v.fileOut })), new Map([[1, clipSeconds]]), { lines: layout, duration: p.duration });
  const plan: EditPlan = {
    ...draft,
    beats: draft.beats.map((b, i) => {
      const c = spans.cuts.find((x) => x.beat === i)!;
      return { ...b, cuts: [{ ...b.cuts[0], in: c.start, out: c.end }] };
    }),
  };
  return { plan, dropped };
}

export async function composeLemoVideo(input: ComposeInput): Promise<KitResult> {
  // 자막 모션 스킬과 자막 디자인 AI는 렌더 전에 확인한다. 기본 자막으로 넘어가지 않는다
  const skillDir = captionSkillDir();
  if (!skillDir) throw new Error(`자막 모션 스킬을 찾지 못했어요(CAPTION_SKILL_DIR=${process.env.CAPTION_SKILL_DIR ?? "없음"}, scripts/subs.cjs와 node_modules가 있어야 해요). lemo 영상은 기본 자막으로 만들지 않아요`);
  if (!process.env.OPENAI_API_KEY) throw new Error("자막 디자인 AI 키(OPENAI_API_KEY)가 없어 모션 자막을 고를 수 없어요. lemo 영상은 기본 자막으로 만들지 않아요");
  if (input.voice.some((v) => !v.file)) throw new Error("음성 파일이 없는 줄이 있어요");

  const clip = readClip(1, input.lemoVideo, { shot: "[코드 애니메이션] lemo 장면" });
  if (clip.duration + 1 / 30 < input.production.duration) console.warn(`[lemo] 화면(${clip.duration.toFixed(2)}초)이 장면 데이터 길이(${input.production.duration.toFixed(2)}초)보다 짧아 마지막 컷이 느려질 수 있어요`);
  const { plan, dropped } = buildLemoPlan(input, clip.duration);
  for (const d of dropped) console.log(`[lemo] ${d}`);

  const preset = toPresetVoices(input.voice);
  const kit = await renderKitEdit({
    workDir: join(input.workDir, "kit"),
    service: input.service,
    readService: input.readService,
    accountName: input.accountName,
    liveVoice: false,
    facts: input.facts,
    rules: input.rules,
    clips: [clip],
    source: "auto",
    scriptLines: input.script,
    voiceId: input.voiceId,
    tone: input.tone ?? null,
    reusePlan: plan,
    presetVoices: { clips: preset.clips, layout: preset.layout, duration: input.production.duration },
    visualPolicy: { max: 0, minGap: 99, allKinds: false },
    // 효과음은 장면 데이터의 영상 기준 시각 그대로(그림의 페이지 넘김 · 떨어짐과 맞춘다)
    presetSfx: input.production.sfx.filter((s) => SFX.has(s.name)).map((s) => ({ name: s.name, t: s.t })),
  });
  if (kit.captionMode !== "motion" || kit.warnings.some((w) => w.includes(CAPTION_FALLBACK_WARNING))) {
    const why = kit.warnings.find((w) => w.includes(CAPTION_FALLBACK_WARNING)) ?? `자막 방식 ${kit.captionMode}`;
    throw new Error(`모션 자막을 얹지 못해 실패로 처리해요: ${why}`);
  }
  return { ...kit, warnings: [...dropped, ...kit.warnings] };
}
