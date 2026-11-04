import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

// 한국어 인스타 스킬(.claude/skills/ig-*-ko, ef4d415)의 채점 스크립트를 에이전트 스킬로 부른다.
// 규칙의 출처를 하나로 두려고 TS로 옮기지 않고 같은 파이썬 스크립트를 그대로 실행한다.
// GitHub Actions(ubuntu)에는 python3가 있고, Windows 로컬은 python.

const SKILLS_DIR = path.join(process.cwd(), ".claude", "skills");
const PYTHON = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");

function runPy(script: string, input: string, args: string[] = []): unknown {
  const dir = mkdtempSync(path.join(tmpdir(), "mcb-ko-"));
  try {
    const file = path.join(dir, "input.txt");
    writeFileSync(file, input, "utf8");
    const res = spawnSync(PYTHON, ["-I", path.join(SKILLS_DIR, script), "--json", ...args, file], {
      encoding: "utf8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      timeout: 30_000,
    });
    // 채점 스크립트는 "통과 못 함"을 종료 코드 1로 알리기도 한다 — 출력이 JSON이면 그대로 쓴다.
    const out = (res.stdout || "").trim();
    if (!out) throw new Error(`${script} 실행 실패: ${(res.stderr || String(res.error ?? "")).slice(0, 300)}`);
    return JSON.parse(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface HookScore {
  hook: string;
  score: number;
  verdict: string;
  weakest: string;
  flags: string[];
}

/** 훅 여러 개를 한 번에 채점 (hookscore_ko.py). */
export function scoreHooks(hooks: string[]): HookScore[] {
  // 여러 줄이면 배열, 한 줄이면 객체 하나가 온다.
  const r = runPy("ig-reel-ko/hookscore_ko.py", hooks.join("\n") + "\n");
  const list = (Array.isArray(r) ? r : [r]) as HookScore[];
  return list.map((h) => ({ hook: h.hook, score: h.score, verdict: h.verdict, weakest: h.weakest, flags: h.flags ?? [] }));
}

export interface BeatTiming {
  totalSeconds: number;
  beats: { n: number; start: number; dur: number; text: string; label?: string; flags: string[] }[];
  flags: string[];
}

/** 대본 한 줄 = 비트 하나로 시간 추정 (beats_ko.py). */
export function timeScript(lines: string[], targetSeconds: number): BeatTiming {
  const r = runPy("ig-reel-ko/beats_ko.py", lines.join("\n") + "\n", ["--target", String(targetSeconds)]) as {
    total_seconds: number;
    beats: BeatTiming["beats"];
    notes?: string[];
  };
  // 비트별 경고는 beats[].flags, 전체 평(루프 · 목표 길이)은 notes
  return { totalSeconds: r.total_seconds, beats: r.beats, flags: r.notes ?? [] };
}

export interface ToneCheck {
  humanScore: number;
  verdict: string;
  checks: Record<string, { score: number; detail: string }>;
}

/** AI 말투 점검 (detect_ko.py). */
export function checkTone(text: string): ToneCheck {
  const r = runPy("ig-human-ko/detect_ko.py", text) as { human_score: number; verdict: string; checks: ToneCheck["checks"] };
  return { humanScore: r.human_score, verdict: r.verdict, checks: r.checks };
}

export interface CaptionCheck {
  verdict: string;
  visibleFeed: string;
  hashtags: string[];
  checks: unknown;
}

/** 캡션 점검 (caption_ko.py). */
export function checkCaption(caption: string, keywords: string[], handle: string): CaptionCheck {
  const r = runPy("ig-caption-ko/caption_ko.py", caption, [
    ...(keywords.length ? ["--keywords", keywords.join(",")] : []),
    "--handle",
    handle || "account",
  ]) as { verdict: string; visible_feed: string; hashtags: string[]; checks: unknown };
  return { verdict: r.verdict, visibleFeed: r.visible_feed, hashtags: r.hashtags, checks: r.checks };
}

export interface HookFormula {
  id: number;
  name: string;
  template: string;
  example: string;
  on_screen: string;
  best_for: string;
  trap: string;
}

let formulasCache: { rules: string[]; hooks: HookFormula[] } | null = null;

/** 한국어 훅 공식 26개 + 규칙 (hooks_ko.json, 분류용 정규식은 뺌). */
export function hookFormulas(): { rules: string[]; hooks: HookFormula[] } {
  if (formulasCache) return formulasCache;
  const raw = JSON.parse(readFileSync(path.join(SKILLS_DIR, "ig-reel-ko", "hooks_ko.json"), "utf8")) as {
    rules: string[];
    hooks: (HookFormula & { match?: string })[];
  };
  formulasCache = {
    rules: raw.rules,
    hooks: raw.hooks.map(({ id, name, template, example, on_screen, best_for, trap }) => ({ id, name, template, example, on_screen, best_for, trap })),
  };
  return formulasCache;
}

/** 잘된 릴스 첫 줄에 훅 공식 이름 · 점수를 붙인다 (swipe_ko.py). 다른 계정 비교용. */
export function classifyHooks(rows: { id: string; hook: string; views: number }[]): { id: string; formula: string; score: number | null }[] {
  const clean = (s: string) => s.replace(/[\t\r\n]+/g, " ").trim();
  const tsv = ["id\thook\tviews", ...rows.map((r) => `${r.id}\t${clean(r.hook)}\t${r.views}`)].join("\n") + "\n";
  const r = runPy("ig-viral-ko/swipe_ko.py", tsv, ["--no-write"]) as {
    reels: { id: string; formula: string; hook_score: number | null }[];
  };
  return r.reels.map((x) => ({ id: x.id, formula: x.formula, score: x.hook_score }));
}

export interface ProfileCheckItem {
  id: string;
  label: string;
  max: number;
  score: number | null; // null = 판단 채점 필요
  auto: boolean;
  findings: string[];
}

export interface ProfileCheck {
  items: ProfileCheckItem[];
  autoScore: number;
  autoMax: number;
  pending: string[];
  banned: string[];
}

/** 프로필 규칙 채점 (profile_ko.py) — 12개 중 7개는 점수까지, 5개는 근거만. 입력은 스크립트 설명의 JSON. */
export function checkProfile(profile: Record<string, unknown>): ProfileCheck {
  const r = runPy("ig-profile-ko/profile_ko.py", JSON.stringify(profile)) as {
    items: ProfileCheckItem[];
    auto_score: number;
    auto_max: number;
    pending: string[];
    banned: string[];
  };
  return { items: r.items, autoScore: r.auto_score, autoMax: r.auto_max, pending: r.pending, banned: r.banned };
}

export interface RubricItem {
  id: string;
  label: string;
  points: number;
  full_marks: string;
  common_fail: string;
}

let rubricCache: { note: string; roleNote: string; items: RubricItem[] } | null = null;

/** 프로필 채점 기준 12개 (rubric_ko.json). */
export function profileRubric(): { note: string; roleNote: string; items: RubricItem[] } {
  if (rubricCache) return rubricCache;
  const raw = JSON.parse(readFileSync(path.join(SKILLS_DIR, "ig-profile-ko", "rubric_ko.json"), "utf8")) as {
    note: string;
    role_note: string;
    items: RubricItem[];
  };
  rubricCache = { note: raw.note, roleNote: raw.role_note, items: raw.items };
  return rubricCache;
}

export interface EditKit {
  hook_rules: string[];
  thumbnail_rules: string[];
  cut_rules: string[];
  caption_rules: string[];
  tts_rules: string[];
  graphics: Record<string, { use: string; params: Record<string, string> }>;
  graphics_rules: string[];
  sfx: Record<string, { use: string; gain_db: number; slice: [number, number] | null; lead?: number }>;
  sfx_rules: string[];
  music: { file: string; in: number; gain_db: number };
  voice: { id: string; title: string; model: string; speed: number };
  render: { hyperframes: string };
}

let editKitCache: EditKit | null = null;

/** 편집 규칙 · 그래픽 틀 · 소리 목록 (ig-edit-ko/kit.json). */
export function editKit(): EditKit {
  if (editKitCache) return editKitCache;
  editKitCache = JSON.parse(readFileSync(path.join(SKILLS_DIR, "ig-edit-ko", "kit.json"), "utf8")) as EditKit;
  return editKitCache;
}

/** 편집 소재가 있는 폴더 (글꼴 · 효과음). */
export function editKitAsset(...parts: string[]): string {
  return path.join(SKILLS_DIR, "ig-edit-ko", "assets", ...parts);
}

/** TTS 읽기용 원고에 남은 숫자 · 기호를 말하는 대로 바꾼다 (ttsread_ko.py). 한 줄에 문장 하나. */
export function ttsReading(lines: string[]): { source: string; text: string; flags: string[] }[] {
  const clean = lines.map((l) => l.replace(/\s+/g, " ").trim());
  const r = runPy("ig-edit-ko/ttsread_ko.py", `${clean.join("\n")}\n`) as { source: string; text: string; flags: string[] }[];
  return Array.isArray(r) ? r : [r];
}
