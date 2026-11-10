import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { Production } from "@/lib/lemo/contract";
import { nearlyFlat } from "@/lib/shoot/video-kit/pipeline";
import { ffmpeg, mediaSeconds } from "@/lib/shoot/video-kit/tools";

// lemo 자동 검사 — 긴 로그 대신 AI · 사람이 읽을 짧은 요약 JSON을 낸다.
// 1) 무음 렌더: 길이(장면 데이터 ±1프레임), 빈 프레임(거의 한 색) 비율, 장면 정지(연속 프레임 차이 0) 비율, 장면별 대표 스틸 묶음
// 2) 완성본: 길이, 통합 음량(LUFS), 진폭 · 트루 피크

const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
// 정지 판단용 작은 회색 프레임
const W = 48;
const H = 84;
// 연속 프레임 평균 밝기 차이가 이보다 작으면 같은 프레임으로 본다(인코딩 잡음 허용)
const STILL_DIFF = 0.2;
// 장면 프레임 변화 중 이 비율 넘게 멈춰 있으면 정지 장면
const FROZEN_SHARE = 0.8;
// 빈 프레임은 초당 이만큼만 본다
const BLANK_FPS = 2;

export interface SceneCheck {
  id: string;
  start: number;
  end: number;
  still_share: number;
  blank_share: number;
  frozen: boolean;
  blank: boolean;
}

export interface RenderChecks {
  ok: boolean;
  file: string;
  seconds: number;
  expected: number;
  frames: number | null;
  duration_ok: boolean;
  blank_share: number;
  still_share: number;
  scenes: SceneCheck[];
  contact: string | null;
  problems: string[];
}

export interface FinalChecks {
  ok: boolean;
  file: string;
  seconds: number;
  lufs: number | null;
  true_peak_db: number | null;
  max_volume_db: number | null;
  problems: string[];
}

function frameCount(file: string): number | null {
  const r = spawnSync(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", file], { encoding: "utf8" });
  const n = Number((r.stdout || "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 영상 전체를 작은 회색 프레임으로 읽는다. 실패하면 null. */
function grayStream(file: string, fps: number, w: number, h: number): Uint8Array[] | null {
  const r = spawnSync(FFMPEG, ["-v", "error", "-i", file, "-an", "-vf", `fps=${fps},scale=${w}:${h}:flags=area,format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout) return null;
  const size = w * h;
  const out: Uint8Array[] = [];
  for (let i = 0; i + size <= r.stdout.length; i += size) out.push(new Uint8Array(r.stdout.subarray(i, i + size)));
  return out;
}

function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** 장면 가운데 스틸을 차례로 모은 묶음(6칸 너비). 실패하면 null. */
export function sceneContact(file: string, production: Production, out: string): string | null {
  const scenes = production.scenes.slice(0, 30);
  if (!scenes.length) return null;
  try {
    const cols = Math.min(6, scenes.length);
    const rows = Math.ceil(scenes.length / cols);
    const inputs = scenes.flatMap((s) => ["-ss", ((s.start + s.end) / 2).toFixed(3), "-i", file]);
    const scale = scenes.map((_, i) => `[${i}:v]scale=216:384,setsar=1[p${i}]`).join(";");
    const layout = scenes.map((_, i) => `${(i % cols) * 216}_${Math.floor(i / cols) * 384}`).join("|");
    const stack = scenes.length > 1 ? `${scenes.map((_, i) => `[p${i}]`).join("")}xstack=inputs=${scenes.length}:layout=${layout}:fill=black` : "[p0]null";
    ffmpeg(["-y", "-v", "error", ...inputs, "-filter_complex", `${scale};${stack},pad=${cols * 216}:${rows * 384}`, "-frames:v", "1", "-q:v", "3", out]);
    return out;
  } catch (e) {
    console.warn("[lemo] 장면 스틸 묶음 실패:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** 무음 렌더 검사. 문제는 problems에 적고 ok=false. 던지지 않는다. */
export function checkSilentRender(file: string, production: Production, workDir: string): RenderChecks {
  const fps = production.fps;
  const seconds = r3(mediaSeconds(file));
  const frames = frameCount(file);
  const expected = r3(production.duration);
  const tol = 1 / fps + 1e-3;
  const byFrames = frames != null ? frames / fps : seconds;
  const durationOk = Math.abs(byFrames - expected) <= tol;
  const problems: string[] = [];
  if (!durationOk) problems.push(`길이가 ${byFrames.toFixed(3)}초로 장면 데이터(${expected.toFixed(3)}초)와 1프레임 넘게 달라요`);

  const motion = grayStream(file, fps, W, H);
  const blankFrames = grayStream(file, BLANK_FPS, 64, 64);
  const scenes: SceneCheck[] = production.scenes.map((s) => {
    const a = Math.max(1, Math.floor(s.start * fps));
    const b = Math.min(motion?.length ?? 0, Math.ceil(s.end * fps));
    let still = 0;
    let total = 0;
    for (let i = a; i < b; i++) {
      total++;
      if (motion && meanAbsDiff(motion[i - 1], motion[i]) < STILL_DIFF) still++;
    }
    const ba = Math.floor(s.start * BLANK_FPS);
    const bb = Math.min(blankFrames?.length ?? 0, Math.ceil(s.end * BLANK_FPS));
    let blank = 0;
    let bt = 0;
    for (let i = ba; i < bb; i++) {
      bt++;
      if (blankFrames && nearlyFlat(blankFrames[i])) blank++;
    }
    const stillShare = total ? r3(still / total) : 0;
    const blankShare = bt ? r3(blank / bt) : 0;
    return { id: s.id, start: s.start, end: s.end, still_share: stillShare, blank_share: blankShare, frozen: stillShare > FROZEN_SHARE, blank: blankShare > 0.5 };
  });
  if (!motion) problems.push("프레임을 읽지 못해 정지 화면을 재지 못했어요");
  if (!blankFrames) problems.push("프레임을 읽지 못해 빈 화면을 재지 못했어요");
  for (const s of scenes) {
    if (s.frozen) problems.push(`${s.id}(${s.start.toFixed(1)}~${s.end.toFixed(1)}초) 화면이 ${Math.round(s.still_share * 100)}% 멈춰 있어요`);
    if (s.blank) problems.push(`${s.id}(${s.start.toFixed(1)}~${s.end.toFixed(1)}초) 화면이 ${Math.round(s.blank_share * 100)}% 거의 한 색이에요`);
  }
  const blankShare = blankFrames?.length ? r3(blankFrames.filter(nearlyFlat).length / blankFrames.length) : 0;
  let stillAll = 0;
  if (motion) for (let i = 1; i < motion.length; i++) if (meanAbsDiff(motion[i - 1], motion[i]) < STILL_DIFF) stillAll++;
  const contact = sceneContact(file, production, join(workDir, "contact.jpg"));
  return {
    ok: problems.length === 0,
    file,
    seconds,
    expected,
    frames,
    duration_ok: durationOk,
    blank_share: blankShare,
    still_share: motion && motion.length > 1 ? r3(stillAll / (motion.length - 1)) : 0,
    scenes,
    contact,
    problems,
  };
}

/** 완성본 검사: 길이 · 통합 음량 · 피크. 인스타 기준으로 너무 작거나 깨질 만한 소리만 문제로 적는다. */
export function checkFinal(file: string, expected: number): FinalChecks {
  const seconds = r3(mediaSeconds(file));
  const problems: string[] = [];
  let lufs: number | null = null;
  let truePeak: number | null = null;
  let maxVolume: number | null = null;
  try {
    const out = ffmpeg(["-hide_banner", "-i", file, "-vn", "-af", "ebur128=peak=true:framelog=quiet,volumedetect", "-f", "null", "-"]);
    const summary = out.slice(out.lastIndexOf("Summary:"));
    const i = summary.match(/I:\s+(-?[0-9.]+) LUFS/);
    const tp = summary.match(/True peak:\s+Peak:\s+(-?[0-9.]+|-inf) dBFS/);
    const mv = out.match(/max_volume:\s+(-?[0-9.]+) dB/);
    lufs = i ? Number(i[1]) : null;
    truePeak = tp && tp[1] !== "-inf" ? Number(tp[1]) : null;
    maxVolume = mv ? Number(mv[1]) : null;
  } catch (e) {
    problems.push(`음량을 재지 못했어요: ${e instanceof Error ? e.message.slice(0, 160) : e}`);
  }
  if (Math.abs(seconds - expected) > 0.1) problems.push(`완성본 길이 ${seconds.toFixed(2)}초가 예정(${expected.toFixed(2)}초)과 달라요`);
  if (lufs != null && (lufs < -20 || lufs > -10)) problems.push(`통합 음량 ${lufs} LUFS — 보통 -16~-13 근처예요`);
  if (truePeak != null && truePeak > -0.5) problems.push(`트루 피크 ${truePeak} dBFS — 소리가 깨질 수 있어요`);
  if (lufs == null && !problems.length) problems.push("통합 음량을 읽지 못했어요");
  return { ok: problems.length === 0, file, seconds, lufs, true_peak_db: truePeak, max_volume_db: maxVolume, problems };
}
