// 다시 편집용 글 파일 — 대본 · 말 자막(SRT) · 화면 문구(SRT) · 캡션. 사람이 CapCut 등에서 다시 편집할 때 쓴다.
// 자막 시각은 완성본 기준(컷 길이를 차례로 더한 값)이다. 컷 안 자막의 from · to는 그 컷 시작이 0이다.

export interface PackageCut {
  no: number;
  seconds?: number;
  shot?: string;
  how?: string;
  on_screen?: string;
  voice?: string;
  skipped?: boolean;
}

export interface PackageSegment {
  cut: number;
  duration: number;
  onScreen: string;
  subtitles: { text: string; from: number; to: number }[];
}

export interface PackageScript {
  hooks?: { spoken?: string; on_screen?: string }[];
  chosen_hook?: number;
  caption?: { text?: string };
}

export interface TextFile {
  name: string;
  content: string;
}

function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

function srt(rows: { from: number; to: number; text: string }[]): string {
  return rows.map((r, i) => `${i + 1}\n${srtTime(r.from)} --> ${srtTime(r.to)}\n${r.text}\n`).join("\n");
}

export function buildPackageTexts(input: {
  account: string;
  productName: string;
  caption: string;
  script: PackageScript | null;
  cuts: PackageCut[];
  segments: PackageSegment[];
}): TextFile[] {
  const files: TextFile[] = [];

  const hook = input.script?.hooks?.[input.script.chosen_hook ?? 0];
  const lines = [`@${input.account} · ${input.productName}`, ""];
  if (hook?.spoken || hook?.on_screen) lines.push(`첫 문장: ${hook.spoken ?? ""}`, `첫 화면 문구: ${hook.on_screen ?? ""}`, "");
  for (const c of input.cuts) {
    if (c.skipped) {
      lines.push(`${c.no}번 컷 (찍지 않고 뺌)`, "");
      continue;
    }
    lines.push(`${c.no}번 컷${c.seconds ? ` · ${c.seconds}초` : ""}`);
    if (c.shot) lines.push(`찍을 것: ${c.shot}`);
    if (c.how) lines.push(`찍는 법: ${c.how}`);
    if (c.on_screen) lines.push(`화면 문구: ${c.on_screen}`);
    if (c.voice) lines.push(`대사: ${c.voice}`);
    lines.push("");
  }
  files.push({ name: "대본.txt", content: lines.join("\n").trimEnd() + "\n" });

  if (input.segments.length) {
    const speech: { from: number; to: number; text: string }[] = [];
    const onScreen: { from: number; to: number; text: string }[] = [];
    let at = 0;
    for (const s of input.segments) {
      for (const sub of s.subtitles) speech.push({ from: at + sub.from, to: at + sub.to, text: sub.text });
      if (s.onScreen?.trim()) onScreen.push({ from: at, to: at + s.duration, text: s.onScreen });
      at += s.duration;
    }
    if (speech.length) files.push({ name: "자막.srt", content: srt(speech) });
    if (onScreen.length) files.push({ name: "화면문구.srt", content: srt(onScreen) });
  }

  if (input.caption.trim()) files.push({ name: "캡션.txt", content: input.caption.trim() + "\n" });
  return files;
}

/** 파일 이름에 못 쓰는 글자를 뺀다. 저장 경로와 무관하게 받는 사람이 알아보는 이름. */
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "영상";
}
