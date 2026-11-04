import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CutZones, Zone } from "@/lib/shoot/video-kit/caption-style";
import { ffmpeg } from "@/lib/shoot/video-kit/tools";

// 파이썬 영상 도구(배경 제거 · 깊이 · 사진 찾기) 호출. 러너는 워크플로에서 lib/shoot/video-kit/py/requirements.txt를 깐다.
// 도구가 없거나 실패하면 null — 호출하는 쪽이 대체 동작으로 이어 간다.

const PYTHON = process.env.VIDEO_PYTHON || (process.platform === "win32" ? "python" : "python3");
const PY_DIR = join(process.cwd(), "lib", "shoot", "video-kit", "py");

export function runVisionTool<T>(script: string, args: string[], timeoutMs = 10 * 60_000): T | null {
  const res = spawnSync(PYTHON, ["-X", "utf8", join(PY_DIR, script), ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  if (res.status !== 0) {
    console.warn(`[video-kit] ${script} 실패: ${(res.stderr || String(res.error ?? "")).slice(-400)}`);
    return null;
  }
  const line = (res.stdout || "").trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(line) as T;
  } catch {
    console.warn(`[video-kit] ${script} 결과를 읽지 못함: ${line.slice(0, 200)}`);
    return null;
  }
}

export function frameZones(frames: string[], workDir: string): Record<Zone, number>[] | null {
  mkdirSync(workDir, { recursive: true });
  const list = join(workDir, `zones-${Date.now()}.json`);
  writeFileSync(list, JSON.stringify(frames));
  return runVisionTool<Record<Zone, number>[]>("zones.py", [list]);
}

/** 컷마다 가운데 프레임을 찍어 글자 자리를 잰다. */
export function subjectZones(video: string, cuts: { start: number; end: number }[], workDir: string): CutZones[] | null {
  try {
    const dir = join(workDir, "zones");
    mkdirSync(dir, { recursive: true });
    const frames = cuts.map((c, i) => {
      const f = join(dir, `cut${i}.jpg`);
      ffmpeg(["-y", "-v", "error", "-ss", ((c.start + c.end) / 2).toFixed(3), "-i", video, "-frames:v", "1", "-q:v", "4", f]);
      return f;
    });
    const covers = frameZones(frames, workDir);
    if (!covers || covers.length !== cuts.length) return null;
    return cuts.map((c, i) => ({ start: c.start, end: c.end, cover: covers[i] }));
  } catch (e) {
    console.warn("[video-kit] 글자 자리 읽기 실패:", e instanceof Error ? e.message : e);
    return null;
  }
}
