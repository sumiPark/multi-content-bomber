import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ffmpeg, imageDataUrl } from "@/lib/shoot/video-kit/tools";
import type { ReviseNote } from "@/lib/style-shorts/revise";

// 스타일 쇼츠 주석 수정(3단계) — 지난 완성본에서 주석 시각의 프레임을 꺼내 번호 동그라미를 그린다(러너 전용).
// 편집 에이전트에 촬영본 프레임 묶음 뒤에 붙여 보낸다. 그리기에 실패하면 동그라미 없는 프레임을 보낸다(주석 글에 위치 비율이 함께 간다).

const PYTHON = process.env.VIDEO_PYTHON || (process.platform === "win32" ? "python" : "python3");
const MARK_SCRIPT = join(process.cwd(), "lib", "style-shorts", "py", "mark_notes.py");
// 에이전트에 보내는 프레임 폭. 세로 영상이라 540이면 960 높이
const FRAME_WIDTH = 540;

export interface NoteFrame {
  no: number;
  image: string;
}

/** 시각이 있는 주석마다 프레임 한 장. 영상 전체 의견(시각 없음)은 프레임이 없다. */
export function noteFrames(video: string, notes: ReviseNote[], duration: number, workDir: string): { frames: NoteFrame[]; warnings: string[] } {
  const dir = join(workDir, "notes");
  mkdirSync(dir, { recursive: true });
  const timed = notes.filter((n) => n.at != null);
  const jobs: { src: string; out: string; no: number; x: number | null; y: number | null; label: string }[] = [];
  for (const n of timed) {
    // 마지막 프레임 바로 뒤를 가리키면 프레임이 없다 — 끝에서 조금 당긴다
    const at = Math.max(0, Math.min(n.at!, Math.max(0, duration - 0.05)));
    const src = join(dir, `raw${n.no}.jpg`);
    try {
      ffmpeg(["-y", "-v", "error", "-ss", at.toFixed(3), "-i", video, "-an", "-frames:v", "1", "-vf", `scale=${FRAME_WIDTH}:-2`, "-q:v", "4", src]);
    } catch (e) {
      console.warn(`[style-edit] 주석 ${n.no}번 프레임 꺼내기 실패:`, e instanceof Error ? e.message : e);
      continue;
    }
    if (existsSync(src)) jobs.push({ src, out: join(dir, `note${n.no}.jpg`), no: n.no, x: n.x, y: n.y, label: `#${n.no}  ${at.toFixed(1)}s` });
  }
  if (!jobs.length) return { frames: [], warnings: timed.length ? ["주석 시각의 화면을 꺼내지 못해 주석 글과 시각만으로 고쳤어요."] : [] };

  const req = join(dir, "jobs.json");
  writeFileSync(req, JSON.stringify(jobs));
  const r = spawnSync(PYTHON, ["-I", MARK_SCRIPT, req], { encoding: "utf8", timeout: 2 * 60_000 });
  let marked = new Set<string>();
  if (!r.error && r.status === 0) {
    try {
      const res = JSON.parse(r.stdout.trim().split("\n").pop() ?? "[]") as { out: string; ok: boolean }[];
      marked = new Set(res.filter((x) => x.ok).map((x) => x.out));
    } catch {
      // 아래에서 동그라미 없는 프레임으로 보낸다
    }
  }
  const warnings = marked.size < jobs.length ? ["주석 화면에 동그라미를 그리지 못한 것이 있어 위치는 비율 값으로만 알렸어요."] : [];
  return { frames: jobs.map((j) => ({ no: j.no, image: imageDataUrl(marked.has(j.out) ? j.out : j.src) })), warnings };
}
