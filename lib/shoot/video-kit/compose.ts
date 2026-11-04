import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { editKitAsset } from "@/lib/agents/ko-skills";
import type { EditPlan } from "@/lib/agents/edit-plan";
import { bigText, captionBlock, captionZone, DEFAULT_LOOK, hookZone, lookCss, ZONE_BOX, type CutZones, type Look, type Zone } from "@/lib/shoot/video-kit/caption-style";
import type { TimedGraphic, Timeline } from "@/lib/shoot/video-kit/timeline";

// 시각표 → HyperFrames 프로젝트(index.html + compositions). 글자 · 그래픽 틀은 ig-edit-ko/kit.json과 같은 이름을 쓴다.
// 인스타 화면 규칙: 글자는 위 168px 아래, 1330px 위. 첫 프레임부터 후킹 글자가 보인다.

const GSAP = "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js";

const FONT = `@font-face { font-family: "Pretendard"; font-weight: 400; src: url("assets/fonts/Pretendard-Regular.woff2") format("woff2"); }
    @font-face { font-family: "Pretendard"; font-weight: 600; src: url("assets/fonts/Pretendard-SemiBold.woff2") format("woff2"); }
    @font-face { font-family: "Pretendard"; font-weight: 800; src: url("assets/fonts/Pretendard-ExtraBold.woff2") format("woff2"); }`;

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 큰 글자를 두 줄 이내로 나눈다. 사람이 줄을 나눴으면 그대로. */
export function hookLines(text: string): string[] {
  const parts = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (parts.length > 1) return parts.slice(0, 3);
  const t = parts[0] ?? "";
  if (t.length <= 9 || !t.includes(" ")) return t ? [t] : [];
  const half = t.length / 2;
  let best = -1;
  for (let i = 0; i < t.length; i++) if (t[i] === " " && (best < 0 || Math.abs(i - half) < Math.abs(best - half))) best = i;
  return [t.slice(0, best).trim(), t.slice(best + 1).trim()];
}

// 위쪽 자리를 쓰는 그래픽 — 이 동안 자막은 위로 가지 않는다
const TOP_GRAPHICS = new Set(["badge", "title", "chip", "notice", "stat", "split", "steps", "end_card"]);

function graphicHtml(g: TimedGraphic): string {
  const clip = `id="${g.id}" class="g clip" data-start="${g.start}" data-duration="${(g.end - g.start).toFixed(3)}"`;
  const p = g.g;
  switch (g.type) {
    case "badge": {
      const side = p.side === "right" ? "left:590px" : p.side === "center" ? "left:0;right:0;text-align:center" : "left:110px";
      const bg = p.tone === "cold" ? "#1F6FB2" : p.tone === "orange" ? "#E04E08" : p.tone === "dark" ? "#141414" : "#D9480F";
      return `<div ${clip} style="top:240px;${side}"><span class="big" style="background:${bg}">${esc(p.text)}</span></div>`;
    }
    case "title":
      return `<div ${clip} style="left:90px;top:240px;width:900px"><div class="card" style="padding:30px 44px 36px"><small class="ts">${esc(p.small)}</small><strong class="tb">${esc(p.text)}</strong><div class="tl" id="${g.id}_l"></div></div></div>`;
    case "chip":
      return `<div ${clip} style="left:0;right:0;top:230px;text-align:center"><span class="chip ${p.tone === "white" ? "white" : "orange"}">${esc(p.text)}</span></div>`;
    case "notice":
      return `<div ${clip} style="left:70px;top:190px;width:940px"><div class="card ntc"><div class="ic">!</div><div><small>${esc(p.small)}</small><strong>${esc(p.text)}</strong></div></div></div>`;
    case "stat":
      return `<div ${clip} style="left:340px;top:215px;width:400px;height:470px;text-align:center">
        <div class="disc"></div>
        <svg class="ringsvg" width="320" height="320" viewBox="0 0 320 320"><circle cx="160" cy="160" r="142" stroke="rgba(255,255,255,.22)" stroke-width="16" fill="none"/><circle id="${g.id}_a" cx="160" cy="160" r="142" stroke="#FF6A1A" stroke-width="16" stroke-linecap="round" fill="none" stroke-dasharray="892.2" stroke-dashoffset="892.2"/></svg>
        <div class="tnum"><b>${esc(p.number)}</b><i>${esc(p.unit)}</i></div>
        <div style="position:absolute;left:-200px;right:-200px;top:342px"><span class="chip orange">${esc(p.text)}</span></div></div>`;
    case "split":
      return `<div ${clip} style="left:180px;top:190px;width:720px;height:216px"><div class="card" style="position:absolute;inset:0"></div>
        <div class="splitrow"><div class="half"><div class="fill" id="${g.id}_l"></div><span>${esc(p.left)}</span></div><div class="half"><div class="fill" id="${g.id}_r"></div><span>${esc(p.right)}</span></div></div>
        ${p.note ? `<div class="snote">${esc(p.note)}</div>` : ""}</div>`;
    case "steps":
      return `<div ${clip} style="left:70px;top:200px;width:940px"><div class="card" style="padding:32px 40px 28px">
        ${p.items.slice(0, 3).map((t, i) => `<div class="step" id="${g.id}_${i}"><i>${i + 1}</i><span>${esc(t)}</span></div>`).join("")}
        ${p.note ? `<p class="stepn">${esc(p.note)}</p>` : ""}</div></div>`;
    case "ring": {
      const r = Math.max(0.05, Math.min(0.3, p.r || 0.15)) * 1080;
      return `<div ${clip} style="left:${Math.round(p.x * 1080 - r)}px;top:${Math.round(p.y * 1920 - r)}px;width:${Math.round(r * 2)}px;height:${Math.round(r * 2)}px;border:9px solid #FFD23F;border-radius:50%;box-shadow:0 0 0 3px rgba(0,0,0,.3)"></div>`;
    }
    case "arrow": {
      const x = p.x * 1080;
      const y = p.y * 1920;
      const dx = p.from === "left" ? -120 : p.from === "right" ? 120 : 0;
      const dy = p.from === "top" ? -120 : p.from === "left" || p.from === "right" ? 0 : 120;
      const a = Math.atan2(-dy, -dx);
      const wing = (d: number) => `${x + 38 * Math.cos(a + Math.PI + d)} ${y + 38 * Math.sin(a + Math.PI + d)}`;
      return `<div ${clip} style="left:0;top:0;width:1080px;height:1920px"><svg width="1080" height="1920" viewBox="0 0 1080 1920"><path d="M${x + dx} ${y + dy} L${x} ${y} M${wing(0.6)} L${x} ${y} L${wing(-0.6)}" stroke="#FFD23F" stroke-width="14" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg></div>`;
    }
    case "end_card":
      return `<div ${clip} style="left:70px;top:200px;width:940px"><div class="card ecard">${p.chip ? `<span class="chip orange" style="font-size:40px">${esc(p.chip)}</span>` : ""}<strong>${esc(p.text)}</strong>${p.sub ? `<p>${esc(p.sub)}</p>` : ""}${p.note ? `<em>${esc(p.note)}</em>` : ""}</div></div>`;
  }
}

function graphicMotion(g: TimedGraphic): string {
  const sel = `#${g.id}`;
  const start = g.start;
  const end = g.end;
  const out = g.type === "end_card" ? "" : `tl.to("${sel}",{opacity:0,duration:.1,ease:"power2.in"},${(end - 0.1).toFixed(3)});`;
  const fade = `tl.fromTo("${sel}",{opacity:0,y:-22},{opacity:1,y:0,duration:.18,ease:"power3.out"},${start});`;
  const pop = `tl.fromTo("${sel}",{opacity:0,scale:.72},{opacity:1,scale:1,duration:.22,ease:"back.out(2.2)"},${start});`;
  switch (g.type) {
    case "badge":
    case "chip":
      return pop + out;
    case "title":
      return `${fade}tl.fromTo("${sel}_l",{scaleX:0},{scaleX:1,duration:.35,ease:"power2.out"},${start + 0.12});${out}`;
    case "stat":
      return `${pop}tl.to("${sel}_a",{strokeDashoffset:0,duration:${Math.max(0.6, end - start - 0.3).toFixed(2)},ease:"none"},${start + 0.15});${out}`;
    case "split":
      return `${fade}tl.fromTo("${sel}_l",{scaleY:.02},{scaleY:${clamp01(g.g.left_value)},duration:.5,ease:"power1.out"},${start + 0.05});tl.fromTo("${sel}_r",{scaleY:.02},{scaleY:${clamp01(g.g.right_value)},duration:.5,ease:"power1.out"},${start + 0.25});${out}`;
    case "steps":
      return `${fade}${g.g.items.slice(0, 3).map((_, i) => `tl.fromTo("${sel}_${i}",{opacity:0,x:30},{opacity:1,x:0,duration:.16},${(start + 0.08 + i * 0.26).toFixed(3)});`).join("")}${out}`;
    case "ring":
      return `tl.fromTo("${sel}",{opacity:0,scale:1.25},{opacity:1,scale:1,duration:.22,ease:"power2.out"},${start});${out}`;
    case "arrow":
      return `tl.fromTo("${sel}",{opacity:0},{opacity:1,duration:.12},${start});${out}`;
    default:
      return fade + out;
  }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0.05, v || 0.05));
}

/** 프로젝트 파일을 쓴다. base.mp4 · mix.wav는 호출한 쪽이 assets에 둔다. */
export interface BehindWord {
  word: string;
  // 글자가 나오는 시각. 제품 레이어는 컷 전체(cutStart~end)에 깔아 원본과 어긋나지 않게 한다
  start: number;
  cutStart: number;
  end: number;
  // assets 안의 제품만 남은 투명 영상
  file: string;
}

export function writeProject(dir: string, tl: Timeline, opts: { look?: Look; zones?: CutZones[] | null; behind?: BehindWord | null } = {}): void {
  const look = opts.look ?? DEFAULT_LOOK;
  const zones = opts.zones ?? null;
  const hookAt: Zone = hookZone(zones, tl.hook.start, tl.hook.end, tl.hook.position);
  const blocks = tl.captions.map((c) => {
    const busy: Zone[] = [];
    if (c.start < tl.hook.end) busy.push(hookAt);
    if (tl.graphics.some((g) => TOP_GRAPHICS.has(g.type) && g.start < c.end && g.end > c.start)) busy.push("top");
    return captionBlock(c, look, captionZone(zones, c.start, c.end, busy));
  });
  const behind = opts.behind ?? null;
  // 제품 뒤 글자 구간에서 화면을 당기면 제품 레이어와 어긋난다
  const punches = look.punch ? blocks.map((b) => b.keyAt).filter((t): t is number => t != null && t > 1.3 && !(behind && t >= behind.cutStart - 0.4 && t < behind.end)) : [];
  const behindSize = behind ? Math.min(470, Math.floor(980 / Math.max(1, [...behind.word].length))) : 0;
  mkdirSync(join(dir, "assets", "fonts"), { recursive: true });
  mkdirSync(join(dir, "compositions"), { recursive: true });
  for (const f of ["Regular", "SemiBold", "ExtraBold"]) copyFileSync(editKitAsset("fonts", `Pretendard-${f}.woff2`), join(dir, "assets", "fonts", `Pretendard-${f}.woff2`));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "shoot-edit", private: true }));
  writeFileSync(join(dir, "hyperframes.json"), JSON.stringify({ paths: { blocks: "compositions", components: "compositions/components", assets: "assets" }, media: { autoProxy: false } }));

  const D = tl.duration;
  const caps = blocks.map((b) => b.html).join("\n    ");
  writeFileSync(
    join(dir, "compositions", "captions.html"),
    `<template>
  <style>
    ${FONT}
    #root { position: absolute; inset: 0; font-family: "Pretendard", sans-serif; pointer-events: none; }
    ${lookCss(look)}
  </style>
  <div id="root" data-composition-id="captions" data-width="1080" data-height="1920">
    ${caps}
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    ${blocks.map((b) => b.motion).join("\n    ")}
    window.__timelines["captions"] = tl;
  </script>
</template>
`,
  );

  const lines = hookLines(tl.hook.onScreen);
  writeFileSync(
    join(dir, "compositions", "graphics.html"),
    `<template>
  <style>
    ${FONT}
    #root { position: absolute; inset: 0; font-family: "Pretendard", sans-serif; pointer-events: none; color: #fff; }
    .g { position: absolute; opacity: 0; }
    ${lookCss(look)}
    .card { background: rgba(20,20,20,.86); border-radius: 30px; }
    .big { display: inline-block; font-weight: 800; font-size: 112px; letter-spacing: -3px; padding: 14px 46px 20px; border-radius: 30px; color: #fff; }
    .chip { display: inline-block; padding: 12px 28px; border-radius: 999px; font-weight: 800; font-size: 44px; letter-spacing: -1px; }
    .orange { background: var(--accent); color: var(--on-accent); } .white { background: #fff; color: #1b1b1b; }
    svg { overflow: visible; }
    .ts { display: block; font-size: 46px; font-weight: 600; color: #FFB48A; margin-bottom: 4px; }
    .tb { display: block; font-size: 96px; font-weight: 800; letter-spacing: -3px; line-height: 1.1; }
    .tl { height: 8px; background: #FF6A1A; margin-top: 14px; border-radius: 4px; transform-origin: 0 50%; }
    .ntc { padding: 28px 36px; display: flex; align-items: center; gap: 28px; }
    .ntc .ic { flex: none; width: 96px; height: 96px; border-radius: 50%; background: var(--accent); color: var(--on-accent); display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 66px; }
    .ntc small { display: block; font-size: 40px; font-weight: 600; color: #ddd; }
    .ntc strong { display: block; font-size: 62px; font-weight: 800; letter-spacing: -2px; color: var(--accent); }
    .disc { position: absolute; left: 40px; top: 0; width: 320px; height: 320px; border-radius: 50%; background: rgba(20,20,20,.86); }
    .ringsvg { position: absolute; left: 40px; top: 0; transform: rotate(-90deg); }
    .tnum { position: absolute; left: 40px; top: 0; width: 320px; height: 320px; display: flex; flex-direction: column; align-items: center; justify-content: center; font-weight: 800; }
    .tnum b { font-size: 104px; line-height: 1; letter-spacing: -3px; } .tnum i { font-style: normal; font-size: 46px; font-weight: 600; }
    .splitrow { position: absolute; inset: 18px; display: flex; gap: 8px; }
    .half { position: relative; flex: 1; border-radius: 14px; background: #3a3a3a; overflow: hidden; }
    .fill { position: absolute; inset: 0; background: linear-gradient(0deg,#FF4D0D,#FFB26B); transform-origin: 50% 100%; }
    .half span { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 54px; text-shadow: 0 2px 8px rgba(0,0,0,.65); }
    .snote { position: absolute; right: 0; bottom: -62px; padding: 4px 18px 6px; border-radius: 12px; background: rgba(20,20,20,.86); font-size: 32px; font-weight: 600; }
    .step { display: flex; align-items: center; gap: 22px; margin-bottom: 16px; font-size: 54px; font-weight: 800; letter-spacing: -1px; }
    .step i { flex: none; width: 66px; height: 66px; border-radius: 50%; background: var(--accent); color: var(--on-accent); display: flex; align-items: center; justify-content: center; font-style: normal; font-size: 40px; }
    .stepn { margin-top: 18px; font-size: 36px; font-weight: 600; color: #e6e6e6; letter-spacing: -1px; }
    .ecard { padding: 36px 44px 34px; }
    .ecard strong { display: block; margin: 16px 0 6px; font-size: 80px; font-weight: 800; letter-spacing: -3px; line-height: 1.12; }
    .ecard p { font-size: 44px; font-weight: 600; color: #eee; }
    .ecard em { display: block; margin-top: 18px; font-style: normal; font-size: 33px; font-weight: 400; color: #ccc; letter-spacing: -.5px; }
  </style>
  <div id="root" data-composition-id="graphics" data-width="1080" data-height="1920">
    <div id="hook" class="lk clip" data-start="0" data-duration="${tl.hook.end}" style="top:${ZONE_BOX[hookAt].top}px;height:${ZONE_BOX[hookAt].height}px">${bigText(lines, tl.hook.highlight, look, Math.max(112, Math.min(150, look.size * 1.7)), 950)}</div>
    ${tl.graphics.map(graphicHtml).join("\n    ")}
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    // 후킹은 첫 프레임부터 보인다 — 살짝 커지기만 하고, 말이 끝나면 사라진다
    tl.fromTo("#hook", { scale: 1 }, { scale: 1.035, duration: ${Math.max(0.4, tl.hook.end - 0.1).toFixed(3)}, ease: "none" }, 0);
    tl.to("#hook", { opacity: 0, duration: 0.1, ease: "power2.in" }, ${(tl.hook.end - 0.1).toFixed(3)});
    ${tl.graphics.map(graphicMotion).join("\n    ")}
    window.__timelines["graphics"] = tl;
  </script>
</template>
`,
  );

  const firstCutEnd = tl.cuts[0]?.end ?? 1;
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1080, height=1920" />
    <script src="${GSAP}"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1080px; height: 1920px; overflow: hidden; background: #000; }
      #root { position: relative; width: 100%; height: 100%; background: #000; overflow: hidden; }
      #stage { position: absolute; inset: 0; }
      #base { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
      ${FONT}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${D}" data-width="1080" data-height="1920">
      <div id="stage"><video id="base" class="clip" src="assets/base.mp4" muted data-start="0" data-duration="${D}" data-track-index="0"></video></div>
      ${
        behind
          ? `<div id="bwrap" class="clip" data-start="${behind.start}" data-duration="${(behind.end - behind.start).toFixed(3)}" data-track-index="5" style="position:absolute;inset:0"><div id="bword" style="position:absolute;left:0;right:0;top:430px;text-align:center;font-family:Pretendard,sans-serif;font-weight:800;font-size:${behindSize}px;line-height:1;letter-spacing:-.05em;color:${look.accent_color}">${esc(behind.word)}</div></div>
      <video id="bcut" class="clip" src="assets/${behind.file}" muted data-start="${behind.cutStart}" data-duration="${(behind.end - behind.cutStart).toFixed(3)}" data-track-index="6" data-layout-allow-occlusion style="position:absolute;inset:0;width:1080px;height:1920px"></video>`
          : ""
      }
      <div id="graphics" data-composition-id="graphics" data-composition-src="compositions/graphics.html" data-start="0" data-duration="${D}" data-track-index="1" data-track-kind="graphics" data-width="1080" data-height="1920"></div>
      <div id="captions" data-composition-id="captions" data-composition-src="compositions/captions.html" data-start="0" data-duration="${D}" data-track-index="2" data-track-kind="captions" data-width="1080" data-height="1920"></div>
      <audio id="mix" class="clip" src="assets/mix.wav" data-start="0" data-duration="${D}" data-track-index="3" data-volume="1"></audio>
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      // 첫 컷은 살짝 밀려 들어와 눈길을 끈다
      tl.fromTo("#stage", { scale: 1.1 }, { scale: 1, duration: ${Math.min(firstCutEnd, 1.2).toFixed(3)}, ease: "power2.out" }, 0);
      ${behind ? `tl.fromTo("#bword", { scale: 0.86, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: "expo.out" }, ${behind.start});` : ""}
      ${punches.map((t) => `tl.to("#stage", { scale: 1.035, duration: 0.09, ease: "power2.out" }, ${t.toFixed(3)}); tl.to("#stage", { scale: 1, duration: 0.26, ease: "power2.inOut" }, ${(t + 0.09).toFixed(3)});`).join("\n      ")}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`,
  );
}

/** 표지 프로젝트 — 프레임 위에 후킹보다 큰 글자. 피드에서 잘리지 않게 가운데 4:5 안에 둔다. */
export function writeCoverProject(dir: string, frame: string, plan: EditPlan["thumbnail"], look: Look = DEFAULT_LOOK): void {
  mkdirSync(join(dir, "assets", "fonts"), { recursive: true });
  copyFileSync(editKitAsset("fonts", "Pretendard-ExtraBold.woff2"), join(dir, "assets", "fonts", "Pretendard-ExtraBold.woff2"));
  copyFileSync(editKitAsset("fonts", "Pretendard-SemiBold.woff2"), join(dir, "assets", "fonts", "Pretendard-SemiBold.woff2"));
  copyFileSync(frame, join(dir, "assets", "frame.jpg"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "shoot-cover", private: true }));
  writeFileSync(join(dir, "hyperframes.json"), JSON.stringify({ paths: { assets: "assets" } }));
  const lines = hookLines(plan.title);
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html>
<html lang="ko"><head><meta charset="UTF-8" /><meta name="viewport" content="width=1080, height=1920" />
<script src="${GSAP}"></script>
<style>
  @font-face { font-family: "Pretendard"; font-weight: 800; src: url("assets/fonts/Pretendard-ExtraBold.woff2") format("woff2"); }
  @font-face { font-family: "Pretendard"; font-weight: 600; src: url("assets/fonts/Pretendard-SemiBold.woff2") format("woff2"); }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1080px; height: 1920px; overflow: hidden; background: #000; }
  #root { position: relative; width: 100%; height: 100%; font-family: "Pretendard", sans-serif; overflow: hidden; }
  #bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  #shade { position: absolute; left: 0; right: 0; ${plan.position === "lower" ? "bottom: 0; height: 1100px; background: linear-gradient(0deg, rgba(0,0,0,.55), rgba(0,0,0,0));" : "top: 0; height: 1000px; background: linear-gradient(180deg, rgba(0,0,0,.55), rgba(0,0,0,0));"} }
  ${lookCss(look)}
  #text { top: ${plan.position === "lower" ? 980 : 280}px; }
  #sub { display: inline-block; margin-top: 10px; padding: 8px 26px 12px; border-radius: 12px; background: var(--accent); color: var(--on-accent); font-weight: 800; font-size: 52px; letter-spacing: -1px; }
</style></head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="1" data-width="1080" data-height="1920">
  <img id="bg" class="clip" src="assets/frame.jpg" alt="" data-start="0" data-duration="1" data-track-index="0" />
  <div id="shade" class="clip" data-start="0" data-duration="1" data-track-index="1"></div>
  <div id="text" class="lk clip" data-start="0" data-duration="1" data-track-index="2">${bigText(lines, plan.highlight, look, 148, 950)}${plan.sub.trim() ? `<div><span id="sub">${esc(plan.sub.trim())}</span></div>` : ""}</div>
</div>
<script>window.__timelines["main"] = gsap.timeline({ paused: true });</script>
</body></html>
`,
  );
}
