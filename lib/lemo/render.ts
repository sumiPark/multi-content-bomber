import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// lemo-opuscar 라이브러리의 렌더 도구(core/render/still.mjs · video.mjs)를 부른다.
// node는 process.execPath를 쓴다(Windows Git Bash에서 fnm 셸 함수가 node를 가로채는 문제 회피).
// 진행 로그(stdout)는 버린다 — AI 문맥에 넣지 않는다. 오류 판단용으로 stderr 끝 40줄만 남긴다.

const DEFAULT_HOME = "D:/ai/lemo-firstgel-test/_vendor/lemo-opuscar";
const REPO = "https://github.com/lemomo-ai/lemo-opuscar";

/** 라이브러리 폴더. LEMO_OPUSCAR_HOME → 로컬 기본 경로(있을 때만) → 없으면 throw */
export function lemoHome(): string {
  const env = process.env.LEMO_OPUSCAR_HOME?.trim();
  const ok = (p: string) => fs.existsSync(path.join(p, "core", "render", "video.mjs"));
  if (env) {
    if (!ok(env)) throw new Error(`LEMO_OPUSCAR_HOME(${env})에 core/render/video.mjs가 없어요. lemo-opuscar 라이브러리 폴더(그 안 node_modules까지)를 가리키게 해 주세요.`);
    return path.resolve(env);
  }
  if (ok(DEFAULT_HOME)) return DEFAULT_HOME;
  throw new Error(
    `lemo-opuscar 라이브러리를 찾지 못했어요. 환경 변수 LEMO_OPUSCAR_HOME에 라이브러리 폴더를 지정해 주세요. ` +
      `설치: git clone ${REPO} <폴더> && cd <폴더> && git checkout 9eb7739 && npm ci && node node_modules/playwright-core/cli.js install chromium-headless-shell`,
  );
}

function ffmpegBin(): string {
  return process.env.FFMPEG_PATH || "ffmpeg";
}
// video.mjs는 PATH의 ffmpeg를 부르므로, FFMPEG_PATH가 있으면 그 폴더를 PATH 앞에 둔다
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const ff = process.env.FFMPEG_PATH;
  if (ff && path.isAbsolute(ff)) {
    const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
    env[key] = path.dirname(ff) + path.delimiter + (env[key] ?? "");
  }
  return env;
}
function browsersDir(): string {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== "0") return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "ms-playwright");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "ms-playwright");
}

/** 렌더 환경 점검: node 20+, ffmpeg 7+(FFMPEG_PATH 고려), playwright chromium-headless-shell 설치, 라이브러리 git 커밋 */
export async function lemoDoctor(): Promise<{ ok: boolean; problems: string[]; node: string; ffmpeg: string | null; chromium: boolean; commit: string | null }> {
  const problems: string[] = [];
  const node = process.versions.node;
  if (Number(node.split(".")[0]) < 20) problems.push(`node ${node}: 20 이상이 필요해요`);
  let ffmpeg: string | null = null;
  try {
    const out = execFileSync(ffmpegBin(), ["-version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    ffmpeg = /ffmpeg version (\S+)/.exec(out)?.[1] ?? "알 수 없음";
    const major = Number(/^n?(\d+)/.exec(ffmpeg)?.[1]);
    if (Number.isFinite(major) && major < 7) problems.push(`ffmpeg ${ffmpeg}: 7 이상이 필요해요`);
  } catch {
    problems.push(`ffmpeg를 실행하지 못했어요(${ffmpegBin()}). 설치하거나 FFMPEG_PATH를 지정해 주세요`);
  }
  let home: string | null = null;
  try {
    home = lemoHome();
  } catch (e) {
    problems.push((e as Error).message);
  }
  let chromium = false;
  let commit: string | null = null;
  if (home) {
    const bj = path.join(home, "node_modules", "playwright-core", "browsers.json");
    if (!fs.existsSync(bj)) problems.push(`라이브러리에 node_modules/playwright-core가 없어요. ${home}에서 npm ci를 해 주세요`);
    else if (process.env.PLAYWRIGHT_CHROME) {
      chromium = fs.existsSync(process.env.PLAYWRIGHT_CHROME);
      if (!chromium) problems.push(`PLAYWRIGHT_CHROME(${process.env.PLAYWRIGHT_CHROME}) 파일이 없어요`);
    } else {
      const rev = (JSON.parse(fs.readFileSync(bj, "utf8")) as { browsers: { name: string; revision: string }[] }).browsers.find((b) => b.name === "chromium-headless-shell")?.revision;
      chromium = !!rev && fs.existsSync(path.join(browsersDir(), `chromium_headless_shell-${rev}`));
      if (!chromium) problems.push(`chromium-headless-shell(${rev ?? "?"})이 설치돼 있지 않아요. ${home}에서 node node_modules/playwright-core/cli.js install chromium-headless-shell`);
    }
    try {
      commit = execFileSync("git", ["-C", home, "rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    } catch {
      commit = null;
    }
  }
  return { ok: problems.length === 0, problems, node, ffmpeg, chromium, commit };
}

function readSize(filmDir: string): { w: number; h: number; duration: number | null } {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(filmDir, "production.json"), "utf8")) as { size?: { w: number; h: number }; duration?: number };
    return { w: p.size?.w ?? 1080, h: p.size?.h ?? 1920, duration: typeof p.duration === "number" ? p.duration : null };
  } catch {
    return { w: 1080, h: 1920, duration: null };
  }
}

// 자식 프로세스 실행: stdout은 버리고 stderr 끝 n줄만 보관
function run(args: string[], cwd: string, keep = 40): Promise<{ code: number; stderrTail: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: childEnv(), stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    const lines: string[] = [];
    let rest = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      const parts = (rest + d).split(/\r?\n/);
      rest = parts.pop() ?? "";
      for (const l of parts) {
        lines.push(l);
        if (lines.length > keep) lines.shift();
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (rest) lines.push(rest);
      resolve({ code: code ?? 1, stderrTail: lines.slice(-keep).join("\n") });
    });
  });
}
function failMessage(what: string, code: number, tail: string): string {
  const why =
    code === 2
      ? "입력 · 사용법 오류(index.html 없음, 잘못된 크기, 같은 out에 다른 렌더가 쓰는 중 등)"
      : code === 1
        ? "렌더 중 실패(페이지 오류 · 필요한 파일 404 · READY 시간 초과 · WebGL 끊김 · ffmpeg 실패 등)"
        : `종료 코드 ${code}`;
  return `${what} 실패 — ${why}\n${tail}`;
}

/** 정지 화면: 시각마다 <outDir>/t_<시각>.jpg. 크기는 film의 production.json size. query는 페이지 주소 뒤 ?k=v(예: { sheet: "bangul" }) */
export async function renderStills(filmDir: string, times: number[], outDir: string, query?: Record<string, string>): Promise<{ files: string[]; seconds: number }> {
  if (!times.length) throw new Error("정지 화면 시각이 비어 있어요");
  const lib = lemoHome();
  const { w, h } = readSize(filmDir);
  const ts = times.map((t) => String(+t.toFixed(3)));
  fs.mkdirSync(outDir, { recursive: true });
  const args = [path.join(lib, "core", "render", "still.mjs"), path.resolve(filmDir), ...ts, "--out", path.resolve(outDir), "--size", `${w}x${h}`, "--prefix", "t_"];
  if (query && Object.keys(query).length) args.push("--q", new URLSearchParams(query).toString());
  const t0 = Date.now();
  const r = await run(args, lib);
  if (r.code !== 0) throw new Error(failMessage("정지 화면 렌더", r.code, r.stderrTail));
  const files = ts.map((t) => path.join(path.resolve(outDir), `t_${t}.jpg`));
  const missing = files.filter((f) => !fs.existsSync(f));
  if (missing.length) throw new Error(`정지 화면 일부가 만들어지지 않았어요: ${missing.join(", ")}\n${r.stderrTail}`);
  return { files, seconds: (Date.now() - t0) / 1000 };
}

/**
 * 무음 mp4 렌더: node <LIB>/core/render/video.mjs <filmDir> --fps --size --workers --out (cwd = 라이브러리 루트).
 * - out은 호출마다 고유한 경로를 주세요. video.mjs는 <out>.lock으로 같은 out에 두 렌더가 쓰는 것을 막고, 겹치면 종료 코드 2로 실패한다.
 * - size는 "1080x1920" 문자열 또는 production.size 같은 { w, h }.
 * - frames는 video.mjs와 같은 식 Math.round(DUR × fps)(DUR = production.duration). production.json이 없으면 null.
 * - 종료 코드 1(렌더 중 실패) · 2(입력 · 잠금 오류)는 원인을 붙인 Error로 던진다. stderrTail은 성공해도 돌려준다(경고 확인용).
 */
export async function renderVideo(
  filmDir: string,
  opts: { fps: number; size: string | { w: number; h: number }; workers?: number; out: string },
): Promise<{ file: string; seconds: number; frames: number | null; stderrTail: string }> {
  const lib = lemoHome();
  const size = typeof opts.size === "string" ? opts.size : `${opts.size.w}x${opts.size.h}`;
  if (!/^\d+x\d+$/.test(size)) throw new Error(`크기 ${size}는 WxH 형식이어야 해요(예: 1080x1920)`);
  const out = path.resolve(opts.out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const args = [path.join(lib, "core", "render", "video.mjs"), path.resolve(filmDir), "--fps", String(opts.fps), "--workers", String(opts.workers ?? 3), "--size", size, "--out", out];
  const t0 = Date.now();
  const r = await run(args, lib);
  if (r.code !== 0) throw new Error(failMessage("영상 렌더", r.code, r.stderrTail));
  if (!fs.existsSync(out)) throw new Error(`영상 렌더가 끝났는데 ${out} 파일이 없어요\n${r.stderrTail}`);
  const { duration } = readSize(filmDir);
  return { file: out, seconds: (Date.now() - t0) / 1000, frames: duration != null ? Math.round(duration * opts.fps) : null, stderrTail: r.stderrTail };
}
