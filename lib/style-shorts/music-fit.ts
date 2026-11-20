import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentModel } from "@/lib/agents/runner";
import { getOpenAI } from "@/lib/openai";
import { callOptions } from "@/lib/products/analysis/analyze";
import type { JudgedTrack, MusicJudge } from "@/lib/shoot/video-kit/music";

// 스타일 쇼츠 배경음악 판정기 — 내려받은 후보를 earshot으로 재서 쓸 곡만 통과시킨다(러너 전용, 2026-11-20 사용자 결정).
// 제목 · 태그만 보고 고르던 때의 문제 두 가지를 막는다.
// - 내용과 다른 분위기: "upbeat" · "playful"로 찾아도 피아노 발라드 · 잔잔한 재즈가 섞여 나왔다
// - 똑같은 소리 반복: 8~12초짜리 루프를 그대로 이어 붙인 곡(실측 반복 정도 0.99~1.0)
// 편집 키트(pipeline.ts)의 음악 검색에 musicJudge로 넘긴다. 직접 촬영 · AI 자동 영상은 이 판정기를 쓰지 않는다.

const EARSHOT_PYTHON = process.env.EARSHOT_PYTHON || "python";
const FIT_SCRIPT = join(process.cwd(), "lib", "style-shorts", "py", "music_fit.py");
// 분위기는 곡에서 실제로 쓰는 앞부분으로 잰다(초). 쓰는 길이를 모르면 MAX, 너무 짧으면 MIN
// (2026-11-20 실측: 앞 45초로는 경쾌한 곡이 11초만 쓰인 자리에서는 잔잔한 도입부만 들렸다)
const LISTEN_MAX = 45;
const LISTEN_MIN = 12;

// earshot 분위기 낱말(music_mood 16개, 고정 커밋 591fa3e). 판정은 이 낱말끼리만 견준다
export const MUSIC_MOODS = [
  "uplifting and hopeful music",
  "playful and quirky music",
  "dark and tense music",
  "sad and melancholic music",
  "calm and relaxing music",
  "energetic and driving music",
  "dreamy and ethereal music",
  "triumphant and heroic music",
  "mysterious music",
  "romantic music",
  "aggressive music",
  "warm and cozy music",
  "futuristic music",
  "confident and cool music",
  "suspenseful build-up music",
  "celebratory and joyful music",
] as const;

// earshot 기준: z 2 미만은 "안 맞음"
export const FIT_MIN = 2;
// 주기 · 두 배 · 세 배만큼 밀어도 이만큼 똑같으면 루프를 이어 붙인 곡이다.
// 2026-11-20 실측(Openverse 펑크 후보 17곡): 루프 0.99~1.0, 연주가 이어지는 곡 0.34~0.75
export const LOOP_SAME = 0.9;

/** 원하는 분위기와 같은 쪽 · 반대쪽 낱말(MUSIC_MOODS 안에서) */
export interface MoodGuide {
  fits: string[];
  avoid: string[];
}

/** py/music_fit.py가 잰 값 */
export interface FitTrack {
  id: string;
  fit?: number;
  moods?: Record<string, number>;
  genres?: [string, number][];
  loop?: { period: number; same: number } | null;
  like?: number | null;
  near?: Record<string, number>;
  error?: string;
}

const short = (term: string) => term.replace(/ music$/, "");

/** 한 곡을 쓸 수 있는지. why는 떨어진 이유(기록용). */
export function judgeTrack(t: FitTrack, guide: MoodGuide | null): { ok: boolean; score: number; why: string | null } {
  if (t.error || t.fit == null) return { ok: false, score: -99, why: `잴 수 없음${t.error ? ` (${t.error})` : ""}` };
  if (t.fit < FIT_MIN) return { ok: false, score: t.fit, why: `원하는 분위기와 안 맞음(${t.fit})` };
  if (guide?.fits.length && guide.avoid.length && t.moods) {
    const z = (term: string) => t.moods?.[term] ?? -9;
    const best = Math.max(...guide.fits.map(z));
    const off = [...guide.avoid].sort((a, b) => z(b) - z(a))[0];
    // 원하는 쪽 낱말보다 피할 쪽 낱말이 더 또렷하면 다른 분위기로 들린다
    if (z(off) >= best) return { ok: false, score: t.fit, why: `${short(off)} 쪽으로 들림(${z(off)} ≥ ${best})` };
  }
  if (t.loop && t.loop.same >= LOOP_SAME) return { ok: false, score: t.fit, why: `${t.loop.period}초짜리 같은 소리가 그대로 반복(${t.loop.same})` };
  return { ok: true, score: t.fit, why: null };
}

/** 통과한 곡만, 잘 맞는 순서로. */
export function passedTracks(tracks: FitTrack[], guide: MoodGuide | null): { passed: JudgedTrack[]; dropped: { id: string; why: string }[] } {
  const passed: JudgedTrack[] = [];
  const dropped: { id: string; why: string }[] = [];
  for (const t of tracks) {
    const v = judgeTrack(t, guide);
    if (v.ok) passed.push({ id: t.id, score: v.score, near: t.near ?? {}, like: t.like ?? null });
    else dropped.push({ id: t.id, why: v.why ?? "" });
  }
  return { passed: passed.sort((a, b) => b.score - a.score), dropped };
}

/** 한국어 분위기 설명을 earshot 분위기 낱말로 옮긴다. 실패하면 null(분위기 낱말 비교 없이 맞는 정도 · 반복만 본다). */
export async function moodGuide(query: string, mood: string): Promise<MoodGuide | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const model = agentModel();
    const completion = await getOpenAI().chat.completions.create({
      model,
      ...callOptions(model, 300),
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: `릴스 배경음악을 고른다. 원하는 분위기: ${mood || "(설명 없음)"} / 검색어: ${query}
아래 분위기 낱말 가운데 원하는 분위기와 같은 쪽인 것을 fits에 1~4개, 반대쪽이라 이 영상에 나오면 어색한 것을 avoid에 2~6개 고른다. 애매한 낱말은 어느 쪽에도 넣지 않는다. 낱말은 목록의 글자 그대로 쓴다.
JSON만 답한다: {"fits":["..."],"avoid":["..."]}
${JSON.stringify(MUSIC_MOODS)}`,
        },
      ],
    });
    const raw = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as { fits?: unknown; avoid?: unknown };
    const known = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && (MUSIC_MOODS as readonly string[]).includes(x)) : []);
    const fits = known(raw.fits);
    const avoid = known(raw.avoid).filter((x) => !fits.includes(x));
    return fits.length && avoid.length ? { fits, avoid } : null;
  } catch (e) {
    console.warn("[style-shorts] 음악 분위기 낱말 고르기 실패:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** 후보를 잰다. 도구가 없거나 실패하면 null과 이유. */
export function listenToMusic(req: { want: string; like: { file: string; start: number } | null; seconds: number | null; tracks: { id: string; file: string; start: number }[] }, workDir: string): { tracks: FitTrack[] | null; warning: string | null } {
  const file = join(workDir, `music-fit-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify({ ...req, seconds: Math.max(LISTEN_MIN, Math.min(LISTEN_MAX, req.seconds ?? LISTEN_MAX)) }));
  const r = spawnSync(EARSHOT_PYTHON, ["-I", FIT_SCRIPT, file], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000 });
  if (r.error || r.status !== 0) {
    const why = r.error?.message ?? (r.stderr || "").trim().split("\n").pop() ?? "";
    return { tracks: null, warning: why.slice(0, 160) };
  }
  try {
    return { tracks: (JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}") as { tracks?: FitTrack[] }).tracks ?? [], warning: null };
  } catch {
    return { tracks: null, warning: "결과를 해석하지 못했어요" };
  }
}

/**
 * 편집 키트에 넘길 판정기. 한 영상에서 여러 번 불려도 분위기 낱말은 한 번만 고른다.
 * 잴 수 없으면 null을 돌려 예전처럼 제목 순위로 고르게 하고, warnings에 한 번만 알린다.
 */
export function makeMusicJudge(warnings: string[]): MusicJudge {
  const guides = new Map<string, Promise<MoodGuide | null>>();
  let warned = false;
  return async (req) => {
    const key = `${req.query}\n${req.intent}`;
    if (!guides.has(key)) guides.set(key, moodGuide(req.query, req.intent));
    const guide = await guides.get(key)!;
    const heard = listenToMusic({ want: `${req.query} music`, like: req.like, seconds: req.seconds, tracks: req.tracks.map((t) => ({ id: t.id, file: t.file, start: t.start })) }, req.workDir);
    if (!heard.tracks) {
      if (!warned) warnings.push(`배경음악 후보의 소리를 재지 못해 제목 · 태그만 보고 골랐어요. 분위기가 맞는지 들어 보고 확인해 주세요. (${heard.warning ?? ""})`);
      warned = true;
      return null;
    }
    const { passed, dropped } = passedTracks(heard.tracks, guide);
    const title = (id: string) => req.tracks.find((t) => t.id === id)?.title || id.slice(0, 8);
    for (const p of passed) console.log(`[style-shorts] 음악 통과: ${title(p.id)} (맞는 정도 ${p.score})`);
    for (const d of dropped) console.log(`[style-shorts] 음악 제외: ${title(d.id)} — ${d.why}`);
    return passed;
  };
}
