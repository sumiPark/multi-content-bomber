import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { editKit } from "@/lib/agents/ko-skills";
import type { MotionSpec } from "@/lib/agents/source-plan";
import { contrast } from "@/lib/shoot/video-kit/caption-style";
import { fallbackFonts, installFonts, type VideoFonts } from "@/lib/shoot/video-kit/compose";
import { hyperframes } from "@/lib/shoot/video-kit/tools";
import { runVisionTool } from "@/lib/shoot/video-kit/vision-tools";

// AI 자동 콘텐츠 소재를 8초짜리 MP4로 만든다. 편집 키트는 촬영본처럼 이 파일을 받는다.
// 렌더는 작업자 1개로 한다 — 큰 레이어 이미지를 여러 작업자로 렌더하면 일부 프레임의 배경이 검게 나왔다(2026-11-04 시험).

const GSAP = "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js";
const D = 8;
const MOTION_BG = "#17181A";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function page(css: string, body: string, script: string, fonts: VideoFonts): string {
  return `<!doctype html>
<html lang="ko"><head><meta charset="UTF-8" /><meta name="viewport" content="width=1080, height=1920" />
<script src="${GSAP}"></script>
<style>
${fonts.css}
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 1080px; height: 1920px; overflow: hidden; background: #000; }
#root { position: relative; width: 100%; height: 100%; overflow: hidden; font-family: ${fonts.family}; }
.layer { position: absolute; transform-origin: 50% 50%; }
.layer img { display: block; }
#sweep { position: absolute; top: -200px; left: -700px; width: 420px; height: 2400px; transform: rotate(14deg); background: linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,.08), rgba(255,255,255,0)); mix-blend-mode: screen; }
${css}
</style></head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${D}" data-width="1080" data-height="1920">
<div id="shell" class="clip" data-start="0" data-duration="${D}" data-track-index="0" style="position:absolute;inset:0">
${body}
</div></div>
<script>
const tl = gsap.timeline({ paused: true });
${script}
window.__timelines["main"] = tl;
</script></body></html>
`;
}

function renderProject(dir: string, out: string, fonts: VideoFonts): string {
  installFonts(dir, fonts);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "auto-clip", private: true }));
  writeFileSync(join(dir, "hyperframes.json"), JSON.stringify({ paths: { assets: "assets" }, media: { autoProxy: false } }));
  hyperframes(editKit().render.hyperframes, dir, ["render", "-o", out, "-q", "standard", "--video-bitrate", "10M", "--skill", "hyperframes", "-w", "1"], 10 * 60_000);
  return out;
}

interface LayerInfo {
  file: string;
  path: string;
  left: number;
  top: number;
  w: number;
  h: number;
  kind: "bg" | "fg" | "far" | "near" | "whole";
}

const MOVES: Record<LayerInfo["kind"], string> = {
  bg: "{ scale: 1, x: 14 }, { scale: 1.05, x: -14",
  far: "{ scale: 1, x: -10 }, { scale: 1.05, x: 10",
  near: "{ scale: 1, x: 8 }, { scale: 1.02, x: -8",
  fg: "{ scale: 0.98, x: -6, y: 6 }, { scale: 1.01, x: 6, y: -6",
  whole: "{ scale: 1, x: -8 }, { scale: 1.02, x: 8",
};

export interface PhotoLayers {
  mode: string;
  soft: boolean;
  layers: LayerInfo[];
}

/** 사진을 레이어로 나눈다. 세로로 채우면 제품이 잘리는 넓은 사진은 mode가 letter(사진 전체 + 위아래 단색)다. */
export function photoLayers(photo: string, workDir: string, name: string): PhotoLayers {
  const res = runVisionTool<PhotoLayers>("photo_layers.py", [photo, join(workDir, name, "layers")]);
  if (!res) throw new Error(`사진을 나누지 못했어요 (${name})`);
  return res;
}

/** 나눈 사진 → 움직이는 컷. 레이어는 통째로만 움직여 포장 글자가 휘지 않는다. 글자가 없는 컷이다. */
export function photoClip(res: PhotoLayers, workDir: string, name: string): { file: string; mode: string; soft: boolean } {
  const dir = join(workDir, name);
  mkdirSync(join(dir, "assets"), { recursive: true });
  const body: string[] = [];
  const motion: string[] = [];
  res.layers.forEach((l, i) => {
    copyFileSync(l.path, join(dir, "assets", l.file));
    body.push(`<div id="l${i}" class="layer" style="left:${l.left}px;top:${l.top}px;width:${l.w}px;height:${l.h}px"><img src="assets/${l.file}" width="${l.w}" height="${l.h}" decoding="sync" loading="eager" /></div>`);
    motion.push(`tl.fromTo("#l${i}", ${MOVES[l.kind]}, duration: ${D}, ease: "none" }, 0);`);
  });
  body.push('<div id="sweep"></div>');
  motion.push('tl.fromTo("#sweep", { x: 0 }, { x: 2300, duration: 1.5, ease: "sine.inOut" }, 1.2); tl.set("#sweep", { x: 0 }, 3.5); tl.to("#sweep", { x: 2300, duration: 1.5, ease: "sine.inOut" }, 4.8);');
  const fonts = fallbackFonts();
  writeFileSync(join(dir, "index.html"), page("", body.join("\n"), motion.join("\n"), fonts));
  const file = join(workDir, `${name}.mp4`);
  renderProject(dir, file, fonts);
  return { file, mode: res.mode, soft: res.soft };
}

const hex = (s: string, fallback: string) => (/^#[0-9a-fA-F]{6}$/.test((s ?? "").trim()) ? s.trim() : fallback);

function title(text: string): string {
  return text.trim() ? `<div id="ttl">${esc(text.trim())}</div>` : "";
}
const BASE_CSS = `#bgd { position: absolute; inset: 0; background: #17181A; }
#ttl { position: absolute; left: 80px; right: 80px; top: 640px; text-align: center; color: #C9CDD1; font-weight: 600; font-size: 50px; }`;

/** 글자 폭(em). 한글 · 한자는 1em, 영문 · 숫자 · 공백은 그보다 좁다. */
const textEm = (t: string) => [...t].reduce((n, ch) => n + (/[ᄀ-ᇿ㄰-㆏가-힯一-鿿]/.test(ch) ? 1 : 0.62), 0);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// 비교 도식 반쪽 칸(860px 카드의 절반)에서 글자가 쓸 수 있는 가로 폭. 칸 양옆에 28px씩 여백을 둔다
const COMPARE_HALF_TEXT = 430 - 28 * 2;
// 이 길이 이상인 장면은 예전 속도(카드 0.5초 · 왼쪽 값 1.2초 · 오른쪽 첫 값 1.4초)로 연다. 더 짧으면 그만큼 당긴다
const COMPARE_FULL_SECONDS = 5;
// 오른쪽 마지막 값이 나오는 시각은 장면 길이의 이 비율 안. 값이 많아 읽을 틈이 모자라면 MAX 비율까지 늘린다
const COMPARE_RESULT_SHARE = 0.45;
const COMPARE_MAX_SHARE = 0.6;
// 오른쪽 값 하나가 바뀌기 전에 보이는 최소 시간
const COMPARE_MIN_GAP = 0.3;
// 값이 튀어 들어오는 움직임 길이
const POP = 0.22;

/**
 * 비교 도식의 글자 크기 · 등장 시각.
 * 예전에는 오른쪽 값이 장면 길이와 상관없이 2.4~5.8초에 바뀌어, 2~4초짜리 장면에서는 바뀌기 전에 장면이 끝났다.
 * 글자도 반쪽 430px 칸에 104px 고정 · overflow:hidden이라 6자 값("사이아노코발")이 잘렸다.
 * 이제 오른쪽 마지막 값이 장면 앞쪽 45%(값이 많으면 60%) 안에 나와 장면 대부분 동안 비교 결과가 보이고,
 * 글자는 가장 긴 값 · 이름이 반쪽 칸에 한 줄로 들어가는 만큼만 키운다.
 */
export function compareLayout(
  texts: { labels: string[]; values: string[] },
  count: number,
  seconds: number,
): { valueFont: number; valueTop: number; valueWrap: boolean; labelFont: number; labelTop: number; labelWrap: boolean; cardDur: number; divAt: number; divDur: number; left: number; first: number; changes: number[]; fillAt: number; fillDur: number } {
  const fit = (list: string[], max: number, min: number) => {
    const widest = Math.max(1, ...list.map((t) => textEm(t.trim())));
    const size = Math.floor(COMPARE_HALF_TEXT / widest);
    // 가장 작은 크기로도 한 줄에 안 들어가면 자르지 않고 줄을 바꾼다
    return { font: clamp(size, min, max), wrap: size < min };
  };
  const value = fit(texts.values, 104, 44);
  const label = fit(texts.labels, 50, 30);
  // 글자가 작아져도 예전 글자 줄의 가운데 높이를 지킨다
  const valueTop = Math.round(220 + (104 - value.font) * 0.6);
  const labelTop = Math.round(110 + (50 - label.font) * 0.6);

  const s = clamp(seconds / COMPARE_FULL_SECONDS, 0.35, 1);
  const left = 1.2 * s;
  const first = 1.4 * s;
  const n = Math.max(1, count);
  let last = first;
  if (n > 1) {
    const target = Math.max(first + COMPARE_MIN_GAP, Math.min(5.8, seconds * COMPARE_RESULT_SHARE));
    const need = first + COMPARE_MIN_GAP * (n - 1);
    last = Math.max(target, Math.min(need, seconds * COMPARE_MAX_SHARE));
  }
  const changes = Array.from({ length: n - 1 }, (_, i) => first + ((last - first) * (i + 1)) / (n - 1));
  return {
    valueFont: value.font,
    valueTop,
    valueWrap: value.wrap,
    labelFont: label.font,
    labelTop,
    labelWrap: label.wrap,
    cardDur: 0.5 * s,
    divAt: 0.5 * s,
    divDur: 0.5 * s,
    left,
    first,
    changes,
    fillAt: first,
    fillDur: Math.max(0.5, last - first + POP),
  };
}

const wrapCss = (wrap: boolean) => (wrap ? "white-space: normal; word-break: keep-all; overflow-wrap: anywhere;" : "white-space: nowrap;");

function compareHtml(m: MotionSpec, accent: string, seconds: number): { css: string; body: string; script: string; shot: string } {
  const values = (m.right_values.length ? m.right_values : [m.left_value]).slice(0, 5);
  const lay = compareLayout({ labels: [m.left_label, m.right_label], values: [m.left_value, ...values] }, values.length, seconds);
  const nums = values.map((v, i) => `<div class="num rv" id="r${i}">${esc(v)}</div>`).join("");
  const css = `${BASE_CSS}
#card { position: absolute; left: 110px; top: 720px; width: 860px; height: 560px; border-radius: 36px; overflow: hidden; background: #2A2D30; box-shadow: 0 40px 90px rgba(0,0,0,.55); }
.half { position: absolute; top: 0; bottom: 0; width: 50%; }
#left { left: 0; background: #3C4247; } #right { right: 0; background: ${accent}; opacity: .3; }
#div { position: absolute; left: 427px; top: 0; width: 6px; height: 100%; background: #fff; transform-origin: 50% 0; }
.lab { position: absolute; top: ${lay.labelTop}px; width: 50%; padding: 0 28px; text-align: center; color: #fff; font-weight: 600; font-size: ${lay.labelFont}px; ${wrapCss(lay.labelWrap)} }
.num { position: absolute; top: ${lay.valueTop}px; width: 50%; padding: 0 28px; text-align: center; color: #fff; font-weight: 800; font-size: ${lay.valueFont}px; letter-spacing: -.03em; opacity: 0; ${wrapCss(lay.valueWrap)} }
.rv { left: 50%; }`;
  const body = `<div id="bgd"></div>${title(m.title)}<div id="card"><div id="left" class="half"></div><div id="right" class="half"></div><div id="div"></div>
<div class="lab" style="left:0">${esc(m.left_label)}</div><div class="lab" style="right:0">${esc(m.right_label)}</div>
<div class="num" id="lv" style="left:0">${esc(m.left_value)}</div>${nums}</div>`;
  const steps = lay.changes
    .map((at, i) => `tl.set("#r${i}", { opacity: 0 }, ${at.toFixed(2)}); tl.fromTo("#r${i + 1}", { opacity: 0, scale: 1.25 }, { opacity: 1, scale: 1, duration: ${POP}, ease: "back.out(2)" }, ${at.toFixed(2)});`)
    .join("\n");
  // 장면이 짧으면 카드 · 가운데 선 · 값이 그만큼 빨리 나온다
  const script = `tl.fromTo("#card", { y: 60, opacity: 0, scale: .94 }, { y: 0, opacity: 1, scale: 1, duration: ${lay.cardDur.toFixed(2)}, ease: "power3.out" }, 0);
tl.fromTo("#div", { scaleY: 0 }, { scaleY: 1, duration: ${lay.divDur.toFixed(2)}, ease: "power2.inOut" }, ${lay.divAt.toFixed(2)});
tl.fromTo("#lv", { opacity: 0, scale: 1.25 }, { opacity: 1, scale: 1, duration: .25, ease: "back.out(2)" }, ${lay.left.toFixed(2)});
tl.fromTo("#r0", { opacity: 0, scale: 1.25 }, { opacity: 1, scale: 1, duration: .25, ease: "back.out(2)" }, ${lay.first.toFixed(2)});
${steps}
tl.to("#right", { opacity: .95, duration: ${lay.fillDur.toFixed(2)}, ease: "none" }, ${lay.fillAt.toFixed(2)});`;
  const lastAt = lay.changes.length ? lay.changes[lay.changes.length - 1] : lay.first;
  return { css, body, script, shot: `비교 도식: 왼쪽 ${m.left_label} ${m.left_value}, 오른쪽 ${m.right_label}이 ${values.join(" → ")} 차례로 바뀐다(${lay.first.toFixed(1)}~${lastAt.toFixed(1)}초)` };
}

// 숫자 도식: 끝 글자가 없으면 숫자가 장면 앞 50% 안에 다 차오르고, 끝 글자가 있으면 35% 안에 다 차오른 뒤 끝 글자로 넘어간다
const COUNT_SHARE = 0.5;
const COUNT_SHARE_WITH_END = 0.35;
const COUNT_MIN_RUN = 0.5;

/**
 * 숫자 도식의 등장 시각.
 * 예전에는 차오르는 시간을 (장면 길이 - 0.8초)로 잡아 숫자가 장면 끝 0.3초 전에야 다 찼고,
 * 끝 글자는 그보다 0.4초 뒤에 나와 4초 이하 장면에서는 장면이 끝난 뒤에 나왔다.
 * 이제 숫자는 장면 앞쪽에서 다 차고, 끝 글자도 장면 앞 60%쯤 안에 나와 남은 시간 동안 결과가 보인다.
 */
export function countTimes(seconds: number, hasEnd: boolean): { ringDur: number; start: number; run: number; fadeAt: number; endAt: number; breatheAt: number } {
  const start = clamp(seconds * 0.1, 0.2, 0.5);
  const ringDur = clamp(seconds * 0.12, 0.25, 0.45);
  const run = clamp(seconds * (hasEnd ? COUNT_SHARE_WITH_END : COUNT_SHARE) - start, COUNT_MIN_RUN, hasEnd ? 3 : 4);
  const done = start + run;
  // 다 찬 숫자를 잠깐 보여 준 뒤 끝 글자로 바꾼다
  const hold = clamp(seconds * 0.08, 0.2, 0.5);
  const fadeAt = done + hold;
  return { ringDur, start, run, fadeAt, endAt: fadeAt + 0.2, breatheAt: done };
}

function countHtml(m: MotionSpec, accent: string, seconds: number): { css: string; body: string; script: string; shot: string } {
  // 장면이 짧아도 숫자와 끝 글자가 장면 안에서 다 나오고, 남은 시간 동안 보인다
  const t = countTimes(seconds, Boolean(m.end_text.trim()));
  const run = t.run;
  const r = 300;
  const circ = (2 * Math.PI * r).toFixed(1);
  const to = m.number_to;
  const css = `${BASE_CSS}
#ring { position: absolute; left: 190px; top: 560px; width: 700px; height: 700px; }
#ring svg { transform: rotate(-90deg); }
#ring circle { fill: none; stroke-width: 44; }
#track { stroke: #303336; } #arc { stroke: ${accent}; stroke-linecap: round; stroke-dasharray: ${circ}; stroke-dashoffset: ${circ}; }
#count { position: absolute; left: 0; right: 0; top: 770px; text-align: center; color: #fff; font-weight: 800; font-size: 190px; line-height: 1; }
#unit { position: absolute; left: 0; right: 0; top: 970px; text-align: center; color: #C9CDD1; font-weight: 600; font-size: 58px; }
#endt { position: absolute; left: 240px; right: 240px; top: 800px; text-align: center; color: #fff; font-weight: 800; font-size: 76px; line-height: 1.2; opacity: 0; }`;
  const body = `<div id="bgd"></div>${title(m.title)}<div id="ring"><svg width="700" height="700"><circle id="track" cx="350" cy="350" r="${r}"/><circle id="arc" cx="350" cy="350" r="${r}"/></svg></div>
<div id="count">0</div><div id="unit">${esc(m.unit)}</div>${m.end_text.trim() ? `<div id="endt">${esc(m.end_text.trim())}</div>` : ""}`;
  const endMotion = m.end_text.trim()
    ? `tl.to("#count", { opacity: 0, y: -30, duration: .25 }, ${t.fadeAt.toFixed(2)}); tl.to("#unit", { opacity: 0, duration: .2 }, ${t.fadeAt.toFixed(2)});
tl.fromTo("#endt", { opacity: 0, scale: .8 }, { opacity: 1, scale: 1, duration: .35, ease: "back.out(2)" }, ${t.endAt.toFixed(2)});`
    : "";
  const script = `const num = { v: 0 }; const el = document.getElementById("count");
tl.fromTo("#ring", { scale: .86, opacity: 0 }, { scale: 1, opacity: 1, duration: ${t.ringDur.toFixed(2)}, ease: "power3.out" }, 0);
tl.to("#arc", { strokeDashoffset: 0, duration: ${run.toFixed(2)}, ease: "none" }, ${t.start.toFixed(2)});
tl.fromTo(num, { v: 0 }, { v: ${to}, duration: ${run.toFixed(2)}, ease: "none", onUpdate: () => { el.textContent = String(Math.floor(num.v + 0.0001)); } }, ${t.start.toFixed(2)});
${endMotion}
tl.to("#ring", { scale: 1.04, duration: 2.2, ease: "none" }, ${t.breatheAt.toFixed(2)});`;
  return { css, body, script, shot: `숫자 도식: 고리가 차며 0에서 ${to}${m.unit}까지 올라간다(${t.start.toFixed(1)}~${(t.start + run).toFixed(1)}초)${m.end_text.trim() ? `, ${t.endAt.toFixed(1)}초에 "${m.end_text.trim()}" 글자가 나온다` : ""}` };
}

// 목록 도식의 글자 영역(가로)과, 자막 자리 위에서 목록 묶음을 세울 세로 중심
const STEPS_WIDTH = 900;
const STEPS_CENTER_Y = 880;
// 마지막 항목이 나오는 시각은 장면 길이의 이 비율 안. 나머지 시간에는 목록 전체가 보인다
const STEPS_REVEAL_SHARE = 0.3;

/**
 * 목록 도식의 크기 · 자리 · 등장 시각.
 * 예전에는 항목을 장면 길이 전체에 고르게 흩어 마지막 항목이 장면 중간쯤(2개면 정확히 가운데)에야 나왔고,
 * 글자도 항목 수와 상관없이 66px · 왼쪽 정렬이라 항목이 적으면 화면 대부분이 비었다
 * (2026-11-09 시험: 8.1~10.5초 · 15.1~16.9초 "거의 한 색" — 가운데 프레임에 항목 하나와 작은 제목만 있었다).
 * 이제 모든 항목이 장면 앞쪽 30%(최대 2.2초) 안에 나오고, 항목이 적을수록 글자를 키워 목록 묶음을 화면 가운데에 세운다.
 */
export function stepsLayout(items: string[], seconds: number): { font: number; icon: number; rowGap: number; top: number; titleTop: number; times: number[] } {
  const n = Math.max(1, items.length);
  const base = n <= 2 ? 96 : n === 3 ? 84 : 72;
  const gapX = 32;
  // 가장 긴 항목이 한 줄에 들어가는 만큼만 키운다
  const widest = Math.max(1, ...items.map(textEm));
  const font = Math.max(56, Math.min(base, Math.floor((STEPS_WIDTH - Math.round(base * 1.4) - gapX) / widest)));
  const icon = Math.round(font * 1.4);
  const rowGap = Math.round(font * 0.5);
  const listH = n * icon + (n - 1) * rowGap;
  const titleH = 50 + 56;
  const top = Math.round(STEPS_CENTER_Y - (listH + titleH) / 2 + titleH);
  const first = 0.2;
  const last = Math.max(first, Math.min(2.2, Math.max(0.5, seconds * STEPS_REVEAL_SHARE)));
  const times = items.map((_, i) => (items.length > 1 ? first + ((last - first) * i) / (items.length - 1) : first));
  return { font, icon, rowGap, top, titleTop: top - titleH, times };
}

function stepsHtml(m: MotionSpec, accent: string, seconds: number): { css: string; body: string; script: string; shot: string } {
  const items = m.items.map((t) => t.trim()).filter(Boolean).slice(0, 4);
  const lay = stepsLayout(items, seconds);
  const mark = Math.round(lay.icon * 0.6);
  const check = `<svg viewBox="0 0 24 24" width="${mark}" height="${mark}" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
  // 목록 묶음은 화면 가운데, 항목끼리는 체크 표시가 한 줄로 서게 왼쪽을 맞춘다
  const css = `${BASE_CSS}
#ttl { top: ${lay.titleTop}px; }
#list { position: absolute; left: 0; right: 0; top: ${lay.top}px; display: flex; justify-content: center; }
#rows { display: flex; flex-direction: column; align-items: flex-start; gap: ${lay.rowGap}px; max-width: ${STEPS_WIDTH}px; }
.it { display: flex; align-items: center; gap: 32px; color: #fff; font-weight: 800; font-size: ${lay.font}px; line-height: 1.15; letter-spacing: -.03em; opacity: 0; }
.ic { flex: none; width: ${lay.icon}px; height: ${lay.icon}px; border-radius: 50%; background: ${accent}; display: flex; align-items: center; justify-content: center; }`;
  const body = `<div id="bgd"></div>${title(m.title)}<div id="list"><div id="rows">${items.map((t, i) => `<div class="it" id="i${i}"><span class="ic">${check}</span><span>${esc(t)}</span></div>`).join("")}</div></div>`;
  // 장면이 짧아도 항목이 앞쪽에 다 나와, 장면 대부분 동안 목록 전체가 보인다
  const script = items.map((_, i) => `tl.fromTo("#i${i}", { opacity: 0, x: -50 }, { opacity: 1, x: 0, duration: .3, ease: "power3.out" }, ${lay.times[i].toFixed(2)});`).join("\n");
  return { css, body, script, shot: `목록 도식: ${items.map((t, i) => `${lay.times[i].toFixed(1)}초 "${t}"`).join(", ")}` };
}

function bigHtml(m: MotionSpec, accent: string): { css: string; body: string; script: string; shot: string } {
  const css = `${BASE_CSS}
#big { position: absolute; left: 40px; right: 40px; top: 790px; text-align: center; color: ${accent}; font-weight: 800; font-size: 250px; line-height: 1; letter-spacing: -.04em; }
#unit { position: absolute; left: 0; right: 0; top: 1060px; text-align: center; color: #fff; font-weight: 800; font-size: 72px; }`;
  const big = m.big.trim().slice(0, 8);
  const body = `<div id="bgd"></div>${title(m.title)}<div id="big" style="font-size:${Math.min(250, Math.floor(1000 / Math.max(1, [...big].length)))}px">${esc(big)}</div><div id="unit">${esc(m.unit)}</div>`;
  const script = `tl.fromTo("#big", { scale: 1.6, opacity: 0 }, { scale: 1, opacity: 1, duration: .3, ease: "back.out(2.2)" }, .2);
tl.fromTo("#unit", { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: .3 }, .6);
tl.to("#big", { scale: 1.06, duration: 7, ease: "none" }, .6);`;
  return { css, body, script, shot: `큰 글자 도식: "${big}${m.unit}"` };
}

/** 코드 모션 → 컷. 값은 소재 에이전트가 상품 정보에서 낸 것만 들어온다. */
function readableAccent(color: string): string {
  const n = Number.parseInt(color.slice(1), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  for (let mix = 0; mix <= 1; mix += 0.05) {
    const out = rgb.map((v) => Math.round(v + (255 - v) * mix));
    const next = `#${out.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    if (contrast(next, MOTION_BG) >= 3.2) return next;
  }
  return "#FFFFFF";
}

export function motionClip(input: MotionSpec, workDir: string, name: string, opts: { seconds?: number; fonts?: VideoFonts } = {}): { file: string; shot: string } {
  const seconds = opts.seconds ?? D;
  const fonts = opts.fonts ?? fallbackFonts();
  // 차오르는 숫자는 자연수만 쓴다. 1.5g 같은 값을 반올림하면 사실이 바뀌니 그대로 크게 보여 준다
  const m: MotionSpec = input.kind === "count" && !(Number.isInteger(input.number_to) && input.number_to > 0) ? { ...input, kind: "big_fact", big: String(input.number_to) } : input;
  // 도식 바탕이 어두워서 어두운 강조색은 읽히지 않는다. 색 계열은 두고 밝힌다
  const accent = readableAccent(hex(m.accent, "#E04E08"));
  const built = m.kind === "compare" ? compareHtml(m, accent, seconds) : m.kind === "count" ? countHtml(m, accent, seconds) : m.kind === "steps" ? stepsHtml(m, accent, seconds) : bigHtml(m, accent);
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  // 검은 화면이 이어지지 않게 바탕을 강조색 계열로 물들인다
  const tinted = `${built.css}\n#bgd { background: linear-gradient(160deg, color-mix(in srgb, ${accent} 42%, ${MOTION_BG}) 0%, color-mix(in srgb, ${accent} 16%, ${MOTION_BG}) 100%); }`;
  writeFileSync(join(dir, "index.html"), page(tinted, built.body, built.script, fonts));
  const file = join(workDir, `${name}.mp4`);
  renderProject(dir, file, fonts);
  return { file, shot: built.shot };
}
