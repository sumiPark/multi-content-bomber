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
