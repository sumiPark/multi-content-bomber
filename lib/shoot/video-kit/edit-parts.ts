import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Timeline } from "@/lib/shoot/video-kit/timeline";
import { ffmpeg } from "@/lib/shoot/video-kit/tools";

// 편집용 파일 묶음(스타일 쇼츠, 2026-11-19 사용자 결정) — 완성본을 캡컷 같은 편집 앱에서 다시 고칠 수 있게
// 자막 없는 영상 · 자막만 그린 영상(투명 배경 · 크로마 키용) · 자막 글(srt) · 음성 · 배경음악 · 효과음을 따로 담아 zip 하나로 만든다(러너 전용).
// 모든 파일은 0초부터 시작하고 완성본과 길이가 같다. 묶음을 못 만들어도 완성본은 그대로 저장한다(호출하는 쪽이 경고만 남긴다).

const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const PYTHON = process.env.VIDEO_PYTHON || (process.platform === "win32" ? "python" : "python3");
// 크로마 키 배경색. 자막에 잘 쓰지 않는 진한 초록
const CHROMA = "0x00FF00";

export interface EditPartsInput {
  workDir: string;
  // 자막 · 첫 화면 글자 · 끝 화면 글자가 없는 완성본(소리는 빼고 담는다)
  noTextVideo: string;
  // 자막 모션 스킬이 찍은 투명 자막 프레임 폴더(f00000.png …). 기본 자막으로 만든 영상은 null
  captionFrames: string | null;
  stems: { voice: string; music: string; sfx: string } | null;
  tl: Timeline;
}

function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

/** 자막 파일(srt) 내용. 빈 글은 뺀다. */
export function toSrt(items: { start: number; end: number; text: string }[]): string {
  return items
    .filter((c) => c.text.trim() && c.end > c.start)
    .sort((a, b) => a.start - b.start)
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text.trim()}\n`)
    .join("\n");
}

/** 말 자막과, 첫 화면 · 끝 화면 글자를 따로 나눈다(같은 시각에 겹쳐 나오므로 한 파일에 넣지 않는다). */
export function partSubtitles(tl: Timeline): { captions: string; titles: string } {
  const titles = [
    { start: tl.hook.start, end: tl.hook.end, text: tl.hook.onScreen },
    ...tl.graphics
      .filter((g) => g.type === "end_card")
      .map((g) => ({ start: g.start, end: g.end, text: [g.g.chip, g.g.text, g.g.sub, g.g.note].map((t) => t?.trim()).filter(Boolean).join("\n") })),
    // 반응 · 속마음 글자(스타일 쇼츠)도 자막 없는 영상에는 빠져 있어 같이 넣는다
    ...(tl.reactions ?? []).map((r) => ({ start: r.start, end: r.end, text: r.text })),
  ];
  return { captions: toSrt(tl.captions), titles: toSrt(titles) };
}

function videoFps(file: string): string {
  const r = spawnSync(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", file], { encoding: "utf8" });
  const fps = (r.stdout || "").trim();
  return /^\d+(\/\d+)?$/.test(fps) ? fps : "30";
}

const README = `편집용 파일 묶음 — 캡컷에서 이어 편집하기

모든 파일은 0초부터 시작하고 완성본과 길이가 같아요. 캡컷 타임라인의 0초에 맞춰 놓으면 완성본과 똑같이 맞아요.

1_자막없는영상.mp4        바탕 영상(컷 · 그래픽 포함, 자막 · 첫 화면 글자 없음, 소리 없음)
2_자막_투명배경.mov       자막만 그린 영상(배경 투명). 바탕 영상 위 트랙에 겹쳐 올려요
3_자막_크로마키.mp4       2번이 캡컷에서 투명하게 안 보일 때 쓰는 같은 영상(초록 배경). 겹쳐 올린 뒤 [크로마 키]로 초록을 지워요
4_자막.srt                말 자막 글과 시각. 캡컷 데스크톱 [자막] → [자막 파일 가져오기]로 불러오면 글자를 고칠 수 있어요
5_첫화면_끝화면_글자.srt  첫 화면 큰 글자 · 끝 화면 글자
6_음성.wav · 7_배경음악.wav · 8_효과음.wav   소리 트랙(완성본과 같은 크기로 섞기 전 상태)

자막 글자를 고치려면: 2번(또는 3번)에서 그 자막 구간을 잘라 지우고, 4번에서 불러온 같은 줄을 고쳐 쓰세요.
4번 · 5번 자막은 글과 시각만 담겨 있어 글꼴 · 색 · 움직임은 캡컷에서 다시 입혀야 해요.
`;

/** 묶음 만들기. 만든 파일과 zip 경로를 돌려준다. 일부를 못 만들면 그 파일만 빼고 경고를 남긴다. */
export function buildEditParts(input: EditPartsInput): { zip: string | null; files: string[]; warnings: string[] } {
  const dir = join(input.workDir, "edit-parts");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  const warnings: string[] = [];
  const D = input.tl.duration.toFixed(3);
  const step = (name: string, run: () => void) => {
    try {
      run();
      if (existsSync(join(dir, name))) files.push(join(dir, name));
    } catch (e) {
      console.warn(`[edit-parts] ${name} 실패:`, e instanceof Error ? e.message : e);
      warnings.push(name);
    }
  };

  step("1_자막없는영상.mp4", () => ffmpeg(["-y", "-v", "error", "-i", input.noTextVideo, "-an", "-c:v", "copy", "-t", D, "-movflags", "+faststart", join(dir, "1_자막없는영상.mp4")]));

  const frames = input.captionFrames && existsSync(input.captionFrames) && readdirSync(input.captionFrames).some((f) => /^f\d{5}\.png$/.test(f)) ? input.captionFrames : null;
  if (frames) {
    const fps = videoFps(input.noTextVideo);
    const seq = join(frames, "f%05d.png");
    // PNG 코덱 mov — 투명 배경을 그대로 담고, 글자가 없는 프레임은 거의 용량을 차지하지 않는다
    step("2_자막_투명배경.mov", () => ffmpeg(["-y", "-v", "error", "-framerate", fps, "-i", seq, "-t", D, "-c:v", "png", "-pix_fmt", "rgba", join(dir, "2_자막_투명배경.mov")]));
    step("3_자막_크로마키.mp4", () =>
      ffmpeg([
        "-y", "-v", "error",
        "-f", "lavfi", "-i", `color=c=${CHROMA}:s=1080x1920:r=${fps}:d=${D}`,
        "-framerate", fps, "-i", seq,
        "-filter_complex", "[1:v]scale=1080:1920,format=rgba[ov];[0:v][ov]overlay=0:0:shortest=1,format=yuv420p[v]",
        "-map", "[v]", "-t", D, "-c:v", "libx264", "-crf", "16", "-preset", "medium", "-movflags", "+faststart",
        join(dir, "3_자막_크로마키.mp4"),
      ]),
    );
  }

  const subs = partSubtitles(input.tl);
  step("4_자막.srt", () => subs.captions && writeFileSync(join(dir, "4_자막.srt"), `﻿${subs.captions}`));
  step("5_첫화면_끝화면_글자.srt", () => subs.titles && writeFileSync(join(dir, "5_첫화면_끝화면_글자.srt"), `﻿${subs.titles}`));

  if (input.stems) {
    const s = input.stems;
    for (const [name, src] of [["6_음성.wav", s.voice], ["7_배경음악.wav", s.music], ["8_효과음.wav", s.sfx]] as const) {
      step(name, () => ffmpeg(["-y", "-v", "error", "-i", src, "-t", D, "-ar", "48000", "-c:a", "pcm_s16le", join(dir, name)]));
    }
  }
  step("읽어주세요.txt", () => writeFileSync(join(dir, "읽어주세요.txt"), `﻿${README}`));

  if (!files.length) return { zip: null, files, warnings: ["편집용 파일을 만들지 못했어요."] };
  // zip은 파이썬 기본 모듈로(러너 · 로컬 모두 있다). 파일 이름만 담긴다
  const zip = join(input.workDir, "edit-parts.zip");
  rmSync(zip, { force: true });
  const r = spawnSync(PYTHON, ["-I", "-m", "zipfile", "-c", zip, ...files], { encoding: "utf8", timeout: 5 * 60_000 });
  if (r.status !== 0 || !existsSync(zip)) return { zip: null, files, warnings: [`편집용 파일을 묶지 못했어요. (${(r.stderr || String(r.error ?? "")).trim().slice(-160)})`] };
  return {
    zip,
    files,
    warnings: [
      ...(frames ? [] : ["자막을 기본 자막으로 만들어 편집용 묶음에 자막 영상은 넣지 못했어요. 자막 글(srt)은 들어 있어요."]),
      ...(warnings.length ? [`편집용 파일 중 ${warnings.join(", ")}을 만들지 못했어요.`] : []),
    ],
  };
}
