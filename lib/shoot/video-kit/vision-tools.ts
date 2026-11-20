import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
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

// 얼굴 자리를 재려고 영상에서 프레임을 뽑는 간격(초당 장수). 사람이 움직여도 놓치지 않게 컷마다 여러 장을 본다
const FACE_FPS = 2;

/**
 * 컷마다 얼굴이 글자 자리에 얼마나 걸치는지 잰다(스타일 쇼츠만 쓴다). 그 컷에 든 프레임 중 가장 많이 걸친 값이다.
 * 프레임은 영상을 한 번만 읽어 뽑는다(컷마다 따로 뽑으면 1분 영상에 55초가 걸렸다, 2026-11-20).
 * 도구가 없거나 실패하면 null — 호출한 쪽은 예전 기준(사람 · 상품 가림)으로 이어 간다.
 */
export function faceZones(video: string, cuts: { start: number; end: number }[], workDir: string): Record<Zone, number>[] | null {
  try {
    const dir = join(workDir, "zones", "faces");
    mkdirSync(dir, { recursive: true });
    ffmpeg(["-y", "-v", "error", "-i", video, "-an", "-vf", `fps=${FACE_FPS},scale=360:640`, "-q:v", "5", join(dir, "f%05d.jpg")]);
    const frames = readdirSync(dir).filter((f) => /^f\d+\.jpg$/.test(f)).sort().map((f) => join(dir, f));
    if (!frames.length) return null;
    const list = join(workDir, `faces-${Date.now()}.json`);
    writeFileSync(list, JSON.stringify(frames));
    const found = runVisionTool<Record<Zone, number>[]>("face_zones.py", [list]);
    if (!found || found.length !== frames.length) return null;
    return cuts.map((c) => {
      // n번째 프레임(0부터)의 시각은 n / FACE_FPS초. 컷이 프레임 간격보다 짧으면 가운데에서 가장 가까운 한 장을 본다
      const from = Math.ceil(c.start * FACE_FPS - 1e-6);
      const to = Math.ceil(c.end * FACE_FPS - 1e-6);
      const at = from < to ? found.slice(from, to) : [];
      const use = at.length ? at : [found[Math.min(found.length - 1, Math.max(0, Math.round(((c.start + c.end) / 2) * FACE_FPS)))]];
      return { top: Math.max(...use.map((f) => f.top)), mid: Math.max(...use.map((f) => f.mid)), lower: Math.max(...use.map((f) => f.lower)) };
    });
  } catch (e) {
    console.warn("[video-kit] 얼굴 자리 읽기 실패:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** 컷마다 가운데 프레임을 찍어 글자 자리를 잰다. faces를 켜면(스타일 쇼츠) 얼굴이 걸친 자리도 함께 잰다. */
export function subjectZones(video: string, cuts: { start: number; end: number }[], workDir: string, opts: { faces?: boolean } = {}): CutZones[] | null {
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
    const faces = opts.faces ? faceZones(video, cuts, workDir) : null;
    return cuts.map((c, i) => ({ start: c.start, end: c.end, cover: covers[i], ...(faces ? { face: faces[i] } : {}) }));
  } catch (e) {
    console.warn("[video-kit] 글자 자리 읽기 실패:", e instanceof Error ? e.message : e);
    return null;
  }
}
