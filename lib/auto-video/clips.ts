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
  near: "{ scale: 1, x: 34 }, { scale: 1.11, x: -34",
  fg: "{ scale: 0.96, x: -22, y: 14 }, { scale: 1.08, x: 22, y: -14",
  whole: "{ scale: 1, x: -26 }, { scale: 1.13, x: 26",
};

export interface PhotoLayers {
  mode: string;
  soft: boolean;
  layers: LayerInfo[];
}

/** 사진을 레이어로 나눈다. mode가 unfit이면 세로 화면에서 제품이 잘리는 사진이라 쓰지 않는다. */
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

function compareHtml(m: MotionSpec, accent: string): { css: string; body: string; script: string; shot: string } {
  const values = (m.right_values.length ? m.right_values : [m.left_value]).slice(0, 5);
  const nums = values.map((v, i) => `<div class="num rv" id="r${i}">${esc(v)}</div>`).join("");
  const css = `${BASE_CSS}
#card { position: absolute; left: 110px; top: 720px; width: 860px; height: 560px; border-radius: 36px; overflow: hidden; background: #2A2D30; box-shadow: 0 40px 90px rgba(0,0,0,.55); }
.half { position: absolute; top: 0; bottom: 0; width: 50%; }
#left { left: 0; background: #3C4247; } #right { right: 0; background: ${accent}; opacity: .3; }
#div { position: absolute; left: 427px; top: 0; width: 6px; height: 100%; background: #fff; transform-origin: 50% 0; }
.lab { position: absolute; top: 110px; width: 50%; text-align: center; color: #fff; font-weight: 600; font-size: 50px; }
.num { position: absolute; top: 220px; width: 50%; text-align: center; color: #fff; font-weight: 800; font-size: 104px; letter-spacing: -.03em; opacity: 0; }
.rv { left: 50%; }`;
  const body = `<div id="bgd"></div>${title(m.title)}<div id="card"><div id="left" class="half"></div><div id="right" class="half"></div><div id="div"></div>
<div class="lab" style="left:0">${esc(m.left_label)}</div><div class="lab" style="right:0">${esc(m.right_label)}</div>
<div class="num" id="lv" style="left:0">${esc(m.left_value)}</div>${nums}</div>`;
  const step = values.length > 1 ? 3.4 / (values.length - 1) : 0;
  const steps = values
    .slice(1)
    .map((_, i) => {
      const at = 2.4 + step * (i + 1);
      return `tl.set("#r${i}", { opacity: 0 }, ${at.toFixed(2)}); tl.fromTo("#r${i + 1}", { opacity: 0, scale: 1.25 }, { opacity: 1, scale: 1, duration: .22, ease: "back.out(2)" }, ${at.toFixed(2)});`;
    })
    .join("\n");
  const script = `tl.fromTo("#card", { y: 60, opacity: 0, scale: .94 }, { y: 0, opacity: 1, scale: 1, duration: .5, ease: "power3.out" }, 0);
tl.fromTo("#div", { scaleY: 0 }, { scaleY: 1, duration: .5, ease: "power2.inOut" }, .5);
tl.fromTo("#lv", { opacity: 0, scale: 1.25 }, { opacity: 1, scale: 1, duration: .25, ease: "back.out(2)" }, 1.2);
tl.fromTo("#r0", { opacity: 0, scale: 1.25 }, { opacity: 1, scale: 1, duration: .25, ease: "back.out(2)" }, 1.4);
${steps}
tl.to("#right", { opacity: .95, duration: ${Math.max(1, step * Math.max(1, values.length - 1)).toFixed(2)}, ease: "none" }, 2.4);`;
  return { css, body, script, shot: `비교 도식: 왼쪽 ${m.left_label} ${m.left_value}, 오른쪽 ${m.right_label}이 ${values.join(" → ")} 차례로 바뀐다(2.4~5.8초)` };
}

function countHtml(m: MotionSpec, accent: string, seconds: number): { css: string; body: string; script: string; shot: string } {
  // 장면이 짧으면 그 안에 숫자가 다 차오르게 한다
  const run = Math.max(1, Math.min(4, seconds - 0.8));
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
    ? `tl.to("#count", { opacity: 0, y: -30, duration: .25 }, ${(run + 0.7).toFixed(2)}); tl.to("#unit", { opacity: 0, duration: .2 }, ${(run + 0.7).toFixed(2)});
tl.fromTo("#endt", { opacity: 0, scale: .8 }, { opacity: 1, scale: 1, duration: .35, ease: "back.out(2)" }, ${(run + 0.9).toFixed(2)});`
    : "";
  const script = `const num = { v: 0 }; const el = document.getElementById("count");
tl.fromTo("#ring", { scale: .86, opacity: 0 }, { scale: 1, opacity: 1, duration: .45, ease: "power3.out" }, 0);
tl.to("#arc", { strokeDashoffset: 0, duration: ${run.toFixed(2)}, ease: "none" }, .5);
tl.fromTo(num, { v: 0 }, { v: ${to}, duration: ${run.toFixed(2)}, ease: "none", onUpdate: () => { el.textContent = String(Math.floor(num.v + 0.0001)); } }, .5);
${endMotion}
tl.to("#ring", { scale: 1.04, duration: 2.2, ease: "none" }, ${(run + 1.8).toFixed(2)});`;
  return { css, body, script, shot: `숫자 도식: 고리가 차며 0에서 ${to}${m.unit}까지 올라간다(0.5~${(run + 0.5).toFixed(1)}초)${m.end_text.trim() ? `, ${(run + 0.9).toFixed(1)}초에 "${m.end_text.trim()}" 글자가 나온다` : ""}` };
}

function stepsHtml(m: MotionSpec, accent: string, seconds: number): { css: string; body: string; script: string; shot: string } {
  const items = m.items.slice(0, 4);
  const check = '<svg viewBox="0 0 24 24" width="58" height="58" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  const css = `${BASE_CSS}
#list { position: absolute; left: 90px; right: 90px; top: 730px; }
.it { display: flex; align-items: center; gap: 30px; margin-bottom: 36px; color: #fff; font-weight: 800; font-size: 66px; letter-spacing: -.03em; opacity: 0; }
.ic { flex: none; width: 96px; height: 96px; border-radius: 50%; background: ${accent}; display: flex; align-items: center; justify-content: center; }`;
  const body = `<div id="bgd"></div>${title(m.title)}<div id="list">${items.map((t, i) => `<div class="it" id="i${i}"><span class="ic">${check}</span><span>${esc(t)}</span></div>`).join("")}</div>`;
  // 장면이 짧아도 항목이 다 나오게 한다
  const gap = Math.max(0.3, Math.min(6, seconds) - 0.8) / Math.max(1, items.length);
  const script = items.map((_, i) => `tl.fromTo("#i${i}", { opacity: 0, x: -50 }, { opacity: 1, x: 0, duration: .34, ease: "power3.out" }, ${(0.4 + gap * i).toFixed(2)});`).join("\n");
  return { css, body, script, shot: `목록 도식: ${items.map((t, i) => `${(0.4 + gap * i).toFixed(1)}초 "${t}"`).join(", ")}` };
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
  const built = m.kind === "compare" ? compareHtml(m, accent) : m.kind === "count" ? countHtml(m, accent, seconds) : m.kind === "steps" ? stepsHtml(m, accent, seconds) : bigHtml(m, accent);
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), page(built.css, built.body, built.script, fonts));
  const file = join(workDir, `${name}.mp4`);
  renderProject(dir, file, fonts);
  return { file, shot: built.shot };
}
