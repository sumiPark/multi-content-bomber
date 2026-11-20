import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paletteSound } from "@/lib/style-shorts/sfx-palette";

// 스타일 쇼츠 효과음 만들기 — 편집 계획이 고른 earshot id를 그 자리에서 만들어 시각 · 크기를 정한다(러너 전용).
// 편집 키트(pipeline.ts)의 믹스에 sfxRenderer로 넘긴다. 직접 촬영 · AI 자동 영상은 이 함수를 쓰지 않는다.

const EARSHOT_PYTHON = process.env.EARSHOT_PYTHON || "python";
const SFX_SCRIPT = join(process.cwd(), "lib", "style-shorts", "py", "sfx.py");
// 효과음 크기 기준(순간 최대 LUFS). 내레이션(-15 LUFS)보다 작게 두고, 말할 때는 믹스가 한 번 더 줄인다
const TARGET_LUFS = -19;
// 휙 · 상승음은 배경처럼 조금 더 작게
const SOFT_KINDS = new Set(["WHOOSH", "RISER", "DROP"]);
const MAX_GAIN = 10;
const MIN_GAIN = -14;
// 지금 기준(TARGET_LUFS)으로 만든 완성본의 효과음 크기 — 바로 앞 소리보다 약 13dB(2026-11-20 실측, 933f2274).
// 레퍼런스가 더 크게 쓰면 그 차이만큼(최대 MAX_BOOST) 올린다
const BASE_OVER_BED_DB = 13;
const MAX_BOOST = 6;

/** 레퍼런스 효과음 크기(바로 앞 소리 대비 dB)에 맞춰 올릴 양. 값이 없거나 더 작으면 0. */
export function sfxBoostDb(refOverBedDb: number | null | undefined): number {
  if (refOverBedDb == null) return 0;
  return Math.round(Math.max(0, Math.min(MAX_BOOST, refOverBedDb - BASE_OVER_BED_DB)) * 10) / 10;
}

export interface PlacedSfx {
  name: string;
  file: string;
  // 영상에서 파일이 시작하는 시각(초) — 소리의 가장 큰 순간이 그 시각에 오게 당긴다
  start: number;
  gainDb: number;
}

interface Rendered {
  out: string;
  ok: boolean;
  peak_s?: number;
  lufs_m_max?: number | null;
  error?: string | null;
}

/** 시각이 정해진 효과음을 만든다. 실패한 소리는 빼고 경고를 남긴다. 같은 id는 시각마다 다른 seed로 만들어 똑같이 들리지 않게 한다. */
export function renderStyleSfx(sfx: { name: string; t: number }[], workDir: string, boostDb = 0): { placed: PlacedSfx[]; warnings: string[] } {
  const known = sfx.filter((s) => paletteSound(s.name));
  if (!known.length) return { placed: [], warnings: [] };
  const dir = join(workDir, "sfx");
  mkdirSync(dir, { recursive: true });
  const jobs = known.map((s, i) => ({ id: s.name, out: join(dir, `s${i}.wav`), seed: i + 1 }));
  const req = join(dir, "jobs.json");
  writeFileSync(req, JSON.stringify(jobs));
  const r = spawnSync(EARSHOT_PYTHON, ["-I", SFX_SCRIPT, req], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 5 * 60_000 });
  if (r.error || r.status !== 0) {
    const why = r.error?.message ?? (r.stderr || "").trim().split("\n").pop() ?? "";
    return { placed: [], warnings: [`효과음을 만들지 못해 효과음 없이 만들었어요. (${why.slice(0, 160)})`] };
  }
  let results: Rendered[];
  try {
    results = JSON.parse(r.stdout.trim().split("\n").pop() ?? "[]") as Rendered[];
  } catch {
    return { placed: [], warnings: ["효과음 결과를 해석하지 못해 효과음 없이 만들었어요."] };
  }
  const placed: PlacedSfx[] = [];
  const failed: string[] = [];
  known.forEach((s, i) => {
    const res = results[i];
    if (!res?.ok) {
      failed.push(s.name);
      return;
    }
    const kind = paletteSound(s.name)?.kind ?? "UI";
    const target = TARGET_LUFS + boostDb - (SOFT_KINDS.has(kind) ? 3 : 0);
    const gain = res.lufs_m_max == null ? -6 : Math.max(MIN_GAIN, Math.min(MAX_GAIN, target - res.lufs_m_max));
    placed.push({ name: s.name, file: res.out, start: Math.max(0, s.t - (res.peak_s ?? 0)), gainDb: Math.round(gain * 10) / 10 });
  });
  return { placed, warnings: failed.length ? [`효과음 ${failed.length}개(${[...new Set(failed)].join(", ")})를 만들지 못해 제외했어요.`] : [] };
}
