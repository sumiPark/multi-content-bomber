import type { EditPlan, EditBeat, EditGraphic } from "@/lib/agents/edit-plan";
import type { Spoken } from "@/lib/shoot/video-kit/tools";

// 편집 계획 → 시각표. 컷 길이는 말 길이에 맞추고, 그래픽 · 자막 · 효과음 시각은 말한 낱말에 맞춘다.

export const FPS = 30;
const GAP = 0.14;
const HEAD = 0.05;
const TAIL_END_CARD = 1.1;
const TAIL_PLAIN = 0.5;
// 재생 속도 한계 — 넘으면 구간을 줄이거나 마지막 프레임을 잠시 둔다
const MIN_RATE = 0.55;
const MAX_RATE = 2.4;

const toFrame = (s: number) => Math.round(s * FPS) / FPS;

export interface VoiceClip {
  // tts 줄은 만든 음성, live 비트는 촬영본
  file: string | null;
  fileIn: number;
  fileOut: number;
  // 음성이 없을 때 쓰는 말 길이(초)
  estimated?: number;
}

export interface TimedCut {
  clip: number;
  in: number;
  out: number;
  what: string;
  beat: number;
  start: number;
  end: number;
  duration: number;
  rate: number;
  hasAudio: boolean;
}

export interface TimedCaption {
  id: string;
  text: string;
  emphasis: string[];
  start: number;
  end: number;
  beat: number;
}

export interface TimedGraphic {
  id: string;
  type: EditGraphic["type"];
  g: EditGraphic;
  start: number;
  end: number;
  beat: number;
}

export interface TimedSfx {
  name: string;
  t: number;
}

export interface TimedLine {
  beat: number;
  start: number;
  end: number;
  file: string | null;
  fileIn: number;
  fileOut: number;
  tts: string;
  live: boolean;
}

export interface Timeline {
  duration: number;
  lines: TimedLine[];
  cuts: TimedCut[];
  captions: TimedCaption[];
  graphics: TimedGraphic[];
  sfx: TimedSfx[];
  hook: { start: number; end: number; onScreen: string; highlight: string; position: "top" | "lower" };
}

export function layoutBeats(plan: EditPlan, voices: VoiceClip[], clipSeconds: Map<number, number>): Omit<Timeline, "captions" | "graphics" | "sfx" | "hook"> {
  const lines: TimedLine[] = [];
  let t = HEAD;
  plan.beats.forEach((beat, i) => {
    const v = voices[i];
    const length = v.estimated ?? v.fileOut - v.fileIn;
    if (i > 0) t += GAP;
    lines.push({ beat: i, start: round(t), end: round(t + length), file: v.file, fileIn: v.fileIn, fileOut: v.fileOut, tts: beat.tts, live: beat.mode === "live" });
    t += length;
  });
  const hasEndCard = plan.beats[plan.beats.length - 1]?.graphics.some((g) => g.type === "end_card");
  const duration = toFrame(t + (hasEndCard ? TAIL_END_CARD : TAIL_PLAIN));

  const cuts: TimedCut[] = [];
  let prev = 0;
  plan.beats.forEach((beat, i) => {
    const end = i + 1 < lines.length ? lines[i + 1].start - 0.02 : duration;
    const span = end - prev;
    const weights = beat.cuts.map((c) => Math.max(0.2, c.out - c.in));
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    let at = prev;
    beat.cuts.forEach((c, j) => {
      const stop = j === beat.cuts.length - 1 ? toFrame(end) : toFrame(at + (span * weights[j]) / sum);
      const startFrame = toFrame(at);
      const dur = round(stop - startFrame);
      const seconds = clipSeconds.get(c.clip) ?? c.out;
      let from = clamp(c.in, 0, Math.max(0, seconds - 0.1));
      let to = clamp(c.out, from + 0.1, seconds);
      let rate = (to - from) / Math.max(0.05, dur);
      if (beat.mode === "live") {
        // 말은 원래 빠르기로
        rate = 1;
        to = Math.min(seconds, from + dur);
      } else if (rate > MAX_RATE) {
        to = from + dur * MAX_RATE;
        rate = MAX_RATE;
      } else if (rate < MIN_RATE) {
        // 구간이 짧으면 앞뒤로 넓혀 본다. 그래도 모자라면 렌더에서 마지막 프레임을 둔다
        const want = dur * MIN_RATE;
        const grow = want - (to - from);
        to = Math.min(seconds, to + grow / 2);
        from = Math.max(0, from - (want - (to - from)));
        rate = Math.max(MIN_RATE, (to - from) / Math.max(0.05, dur));
      }
      cuts.push({ clip: c.clip, in: round(from), out: round(to), what: c.what, beat: i, start: startFrame, end: stop, duration: dur, rate: round(rate), hasAudio: beat.mode === "live" });
      at = stop;
    });
    prev = toFrame(end);
  });
  return { duration, lines, cuts };
}

const squash = (s: string) => s.replace(/[\s.,!?~·]+/g, "");

/** 낱말이 비트 안 어디서 시작하는지. 받아쓰기가 틀릴 수 있어 못 찾으면 null. */
function wordTime(words: Spoken[], line: TimedLine, needle: string): number | null {
  const n = squash(needle);
  if (!n) return null;
  const inLine = words.filter((w) => w.start >= line.start - 0.2 && w.start <= line.end + 0.05);
  const hit = inLine.find((w) => squash(w.text).includes(n) || n.includes(squash(w.text)) && squash(w.text).length >= 2);
  return hit ? hit.start : null;
}

function captionBounds(line: TimedLine, groups: string[], words: Spoken[]): number[] {
  const total = groups.reduce((s, g) => s + g.length, 0) || 1;
  const length = line.end - line.start;
  const inLine = words.filter((w) => w.start >= line.start - 0.1 && w.start <= line.end).map((w) => w.start);
  const bounds = [line.start];
  let acc = 0;
  for (const g of groups.slice(0, -1)) {
    acc += g.length;
    let at = line.start + (length * acc) / total;
    if (inLine.length) {
      const near = inLine.reduce((a, b) => (Math.abs(b - at) < Math.abs(a - at) ? b : a));
      if (Math.abs(near - at) < 0.45) at = near;
    }
    bounds.push(round(at));
  }
  bounds.push(round(line.end + 0.06));
  return bounds;
}

export function timeText(plan: EditPlan, base: Omit<Timeline, "captions" | "graphics" | "sfx" | "hook">, words: Spoken[], liveCaptions: Map<number, Spoken[]>): Timeline {
  const captions: TimedCaption[] = [];
  const graphics: TimedGraphic[] = [];
  const sfx: TimedSfx[] = [];

  plan.beats.forEach((beat: EditBeat, i) => {
    const line = base.lines[i];
    const at = (word: string, fraction: number) => wordTime(words, line, word) ?? round(line.start + (line.end - line.start) * clamp(fraction, 0, 1));
    const groups = beat.mode === "live" ? [] : beat.captions.map((c) => c.trim()).filter(Boolean);
    if (groups.length) {
      const bounds = captionBounds(line, groups, words);
      groups.forEach((text, g) => captions.push({ id: `c${i}_${g}`, text, emphasis: beat.emphasis, start: bounds[g], end: bounds[g + 1], beat: i }));
    }
    for (const [g, s] of (liveCaptions.get(i) ?? []).entries()) {
      captions.push({ id: `c${i}_l${g}`, text: s.text, emphasis: beat.emphasis, start: round(s.start), end: round(s.end), beat: i });
    }
    beat.graphics.forEach((g, n) => {
      const start = g.type === "end_card" ? line.start : at(g.at_word, g.at);
      graphics.push({ id: `g${i}_${n}`, type: g.type, g, start: round(start), end: 0, beat: i });
    });
    for (const s of beat.sfx) sfx.push({ name: s.name, t: round(at(s.at_word, s.at)) });
  });

  captions.sort((a, b) => a.start - b.start);
  for (let i = 0; i + 1 < captions.length; i++) captions[i].end = Math.min(captions[i].end, captions[i + 1].start);

  // 그래픽은 그 비트 끝까지, 글이 길면 다음 그래픽 전까지 더 둔다. 위치가 겹치는 틀은 앞의 것을 먼저 닫는다
  graphics.sort((a, b) => a.start - b.start);
  graphics.forEach((g, i) => {
    const lineEnd = base.cuts.filter((c) => c.beat === g.beat).reduce((m, c) => Math.max(m, c.end), g.start + 1);
    const next = graphics.slice(i + 1).find((o) => o.type !== "ring" && o.type !== "arrow" && g.type !== "ring" && g.type !== "arrow");
    const readable = g.start + readSeconds(g.g);
    const wanted = Math.max(lineEnd, readable);
    g.end = round(Math.min(wanted, next ? next.start : base.duration, base.duration));
    if (g.type === "end_card") g.end = base.duration;
  });

  const first = base.lines[0];
  return {
    ...base,
    captions,
    graphics,
    sfx: sfx.sort((a, b) => a.t - b.t),
    hook: {
      start: 0,
      end: round(Math.max(first?.end ?? 2, 1.8)),
      onScreen: plan.hook.on_screen,
      highlight: plan.hook.highlight,
      position: plan.hook.position ?? "top",
    },
  };
}

function readSeconds(g: EditGraphic): number {
  const text = [g.text, g.small, g.sub, g.note, g.chip, g.left, g.right, ...g.items].join(" ").trim();
  const words = text ? text.split(/\s+/).length : 0;
  return Math.max(1.1, 0.5 + 0.3 * words);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
