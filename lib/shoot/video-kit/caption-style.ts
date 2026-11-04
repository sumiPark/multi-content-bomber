import { z } from "zod";

// 영상의 글자 디자인(look). 편집 에이전트가 계정 설정(말투 · 분위기 · 편집 스타일)을 읽고 영상마다 값을 만들고,
// 코드는 값을 안전한 범위로 고친 뒤 그대로 그린다. 정해진 틀을 고르는 방식이 아니라 값의 조합이다.
// 직접 촬영은 촬영 설정, AI 자동 콘텐츠는 자동 콘텐츠 설정을 읽는다(호출하는 쪽이 넘긴다).

export const lookSchema = z.object({
  reading: z.string().describe("계정 설정과 상품을 어떻게 읽었는지 한 문장"),
  align: z.enum(["center", "left"]).describe("글자 정렬"),
  treatment: z.enum(["stroke", "box", "pill", "shade"]).describe("글자 처리: stroke 두꺼운 외곽선, box 줄 뒤 띠, pill 낱말마다 말풍선, shade 글자 뒤 부드러운 어둠"),
  text_color: z.string().describe("기본 글자색 #RRGGBB"),
  accent_color: z.string().describe("강조색 #RRGGBB"),
  box_color: z.string().describe("box · pill 바탕색 #RRGGBB. 다른 처리면 #000000"),
  size: z.number().describe("기본 글자 크기 px, 48~96"),
  emphasis_scale: z.number().describe("핵심어 크기 배수, 1~2.8"),
  emphasis: z.enum(["color", "fill", "underline"]).describe("핵심어 표시: 글자색, 색 바탕, 밑줄"),
  layout: z.enum(["inline", "key_line"]).describe("inline 한 흐름, key_line 핵심어를 따로 한 줄로 크게"),
  reveal: z.enum(["line", "word"]).describe("line 한 번에, word 말하는 대로 낱말씩"),
  entrance: z.enum(["pop", "slam", "rise", "wipe", "fade"]).describe("글자가 나오는 움직임"),
  tilt: z.number().describe("낱말 기울기 도, 0~3. 0이면 반듯하게"),
  punch: z.boolean().describe("핵심어가 나올 때 화면을 살짝 당길지"),
  behind_word: z.string().describe("[제품컷]에서 제품 뒤로 크게 넣을 핵심어 2~4자, 그 컷의 자막에 있는 낱말. 설정 분위기와 맞을 때만, 안 쓰면 빈 문자열"),
  music_query: z.string().describe("이 영상에 맞는 배경음악 영어 검색어 2~4낱말. 악기 · 분위기로 쓴다(예: warm acoustic guitar). 상표 · 가수 이름 금지"),
  music_intent: z.string().describe("원하는 음악 분위기 한국어 한 문장"),
  music: z.string().describe("검색이 안 될 때 쓸 곡. music_library의 file 하나"),
});
export type Look = z.infer<typeof lookSchema>;

export const DEFAULT_LOOK: Look = {
  reading: "",
  align: "center",
  treatment: "stroke",
  text_color: "#FFFFFF",
  accent_color: "#FFD23F",
  box_color: "#111111",
  size: 62,
  emphasis_scale: 1,
  emphasis: "color",
  layout: "inline",
  reveal: "line",
  entrance: "fade",
  tilt: 0,
  punch: false,
  behind_word: "",
  music_query: "",
  music_intent: "",
  music: "",
};

const clamp = (n: number, min: number, max: number) => (Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min);
const hex = (s: unknown, fallback: string) => (typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s.trim()) ? s.trim().toUpperCase() : fallback);

function luminance(color: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(color.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export const readableOn = (bg: string): string => (luminance(bg) > 0.4 ? "#111111" : "#FFFFFF");

/** AI가 낸 값을 읽을 수 있는 범위로 고친다. 값이 없으면(예전 계획) 기본 모양. */
export function normalizeLook(raw: Partial<Look> | null | undefined): Look {
  if (!raw) return DEFAULT_LOOK;
  const treatment = raw.treatment ?? DEFAULT_LOOK.treatment;
  const box = hex(raw.box_color, DEFAULT_LOOK.box_color);
  let text = hex(raw.text_color, DEFAULT_LOOK.text_color);
  let accent = hex(raw.accent_color, DEFAULT_LOOK.accent_color);
  if ((treatment === "box" || treatment === "pill") && contrast(text, box) < 4.5) text = readableOn(box);
  if ((treatment === "box" || treatment === "pill") && contrast(accent, box) < 2.6) accent = readableOn(box) === "#FFFFFF" ? "#FFD23F" : "#D9480F";
  // 어두운 그림자 위 글자라서 너무 어두운 글자색은 쓰지 않는다
  if (treatment === "shade" && luminance(text) < 0.5) text = "#FFFFFF";
  if (treatment === "shade" && luminance(accent) < 0.18) accent = "#FFD23F";
  return {
    reading: raw.reading ?? "",
    align: raw.align === "left" ? "left" : "center",
    treatment,
    text_color: text,
    accent_color: accent,
    box_color: box,
    size: clamp(Number(raw.size), 48, 96),
    emphasis_scale: clamp(Number(raw.emphasis_scale), 1, 2.8),
    emphasis: raw.emphasis ?? "color",
    layout: raw.layout === "key_line" ? "key_line" : "inline",
    reveal: raw.reveal === "word" ? "word" : "line",
    entrance: raw.entrance ?? "fade",
    tilt: clamp(Number(raw.tilt), 0, 3),
    punch: !!raw.punch,
    behind_word: typeof raw.behind_word === "string" ? raw.behind_word.trim() : "",
    music_query: typeof raw.music_query === "string" ? raw.music_query : "",
    music_intent: typeof raw.music_intent === "string" ? raw.music_intent : "",
    music: typeof raw.music === "string" ? raw.music : "",
  };
}

// 글자를 놓는 세 자리. 인스타 위 · 아래 화면 요소를 피한다.
export type Zone = "top" | "mid" | "lower";
export const ZONE_BOX: Record<Zone, { top: number; height: number }> = {
  top: { top: 170, height: 430 },
  mid: { top: 660, height: 400 },
  lower: { top: 1100, height: 380 },
};

export interface CutZones {
  start: number;
  end: number;
  // 그 자리를 상품 · 사람이 얼마나 차지하는지 0~1
  cover: Record<Zone, number>;
}

const FREE = 0.18;

function worstCover(zones: CutZones[], start: number, end: number): Record<Zone, number> {
  const out: Record<Zone, number> = { top: 0, mid: 0, lower: 0 };
  for (const z of zones) {
    if (z.end <= start || z.start >= end) continue;
    for (const k of ["top", "mid", "lower"] as Zone[]) out[k] = Math.max(out[k], z.cover[k]);
  }
  return out;
}

/** 후킹 자리: 위부터 본다. 정보가 없으면 AI가 정한 자리. */
export function hookZone(zones: CutZones[] | null, start: number, end: number, fallback: "top" | "lower"): Zone {
  if (!zones?.length) return fallback === "lower" ? "lower" : "top";
  const cover = worstCover(zones, start, end);
  const order: Zone[] = ["top", "lower", "mid"];
  return order.find((z) => cover[z] < FREE) ?? order.reduce((a, b) => (cover[b] < cover[a] ? b : a));
}

/** 자막 자리: 아래부터 보되, 후킹 · 위쪽 그래픽이 쓰는 자리는 뺀다. */
export function captionZone(zones: CutZones[] | null, start: number, end: number, busy: Zone[]): Zone {
  const order = (["lower", "mid", "top"] as Zone[]).filter((z) => !busy.includes(z));
  const allowed = order.length ? order : (["lower"] as Zone[]);
  if (!zones?.length) return allowed[0];
  const cover = worstCover(zones, start, end);
  return allowed.find((z) => cover[z] < FREE) ?? allowed.reduce((a, b) => (cover[b] < cover[a] ? b : a));
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function units(text: string): number {
  return [...text].reduce((s, c) => s + (c === " " ? 0.32 : /[,.!?]/.test(c) ? 0.34 : /[가-힣]/.test(c) ? 0.98 : 0.62), 0);
}

const fit = (text: string, size: number, width: number) => Math.floor(Math.min(size, width / Math.max(units(text), 0.5)));
const TILTS = [-1, 0.7, -0.45, 1, -0.8, 0.55];

interface Token {
  text: string;
  key: boolean;
}

/** 강조어를 찾고, 한 글자짜리 낱말은 옆 낱말과 묶는다(말풍선 · 낱말 등장에서 '잘 / 때는'처럼 끊기지 않게). */
function tokenize(text: string, emphasis: string[]): Token[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: Token[] = [];
  for (const w of words) {
    const key = emphasis.some((m) => m && (w.includes(m) || m.includes(w)));
    const last = out[out.length - 1];
    const short = (s: string) => s.replace(/[,.!?]/g, "").length <= 1;
    if (last && (short(w) || short(last.text))) {
      last.text += ` ${w}`;
      last.key = last.key || key;
    } else out.push({ text: w, key });
  }
  return out;
}

export function lookCss(look: Look): string {
  const stroke = readableOn(look.text_color) === "#111111" ? "#0B0B0B" : "#FFFFFF";
  const onAccent = readableOn(look.accent_color);
  const center = look.align === "center";
  const base = `.lk { position: absolute; left: 0; right: 0; display: flex; flex-direction: column; justify-content: center; align-items: ${center ? "center" : "flex-start"}; padding: 0 64px; gap: 8px; overflow: visible; }
    .lk .row { position: relative; display: flex; flex-wrap: wrap; gap: 10px 14px; justify-content: ${center ? "center" : "flex-start"}; align-items: center; }
    .lk .w { display: inline-block; color: ${look.text_color}; font-weight: 800; line-height: 1.16; letter-spacing: -0.03em; white-space: nowrap; transform-origin: 50% 60%; }`;
  const treat = {
    stroke: `.lk .w { paint-order: stroke fill; -webkit-text-stroke: 0.2em ${stroke}; }`,
    box: `.lk .row { background: ${look.box_color}; padding: 8px 26px 14px; border-radius: 16px; }`,
    pill: `.lk .w { background: ${look.box_color}; padding: 10px 26px 16px; border-radius: 24px; box-shadow: 0 10px 26px rgba(0,0,0,.34); }`,
    shade: `.lk::before { content: ""; position: absolute; inset: -70px -40px; background: radial-gradient(ellipse at ${center ? "50%" : "26%"} 50%, rgba(0,0,0,.66), rgba(0,0,0,0) 72%); }`,
  }[look.treatment];
  const key = {
    color: `.lk .k { color: ${look.accent_color}; }`,
    fill: `.lk .k { color: ${onAccent}; background: ${look.accent_color}; padding: 6px 22px 12px; border-radius: 16px; -webkit-text-stroke: 0; }`,
    underline: `.lk .k { color: ${look.accent_color}; box-shadow: inset 0 -0.14em 0 ${look.accent_color}55; }`,
  }[look.emphasis];
  return `${base}\n    ${treat}\n    ${key}\n    #root { --accent: ${look.accent_color}; --on-accent: ${onAccent}; }`;
}

function word(id: string, t: Token, size: number, look: Look, i: number): string {
  const rotate = look.tilt ? `rotate:${(TILTS[i % TILTS.length] * look.tilt).toFixed(2)}deg;` : "";
  return `<span id="${id}" class="w${t.key ? " k" : ""}" style="font-size:${size}px;${rotate}">${esc(t.text)}</span>`;
}

const ENTER: Record<Look["entrance"], { from: string; to: string }> = {
  pop: { from: "{ scale: 0.4, opacity: 0, y: 24 }", to: '{ scale: 1, opacity: 1, y: 0, duration: 0.17, ease: "back.out(3)" }' },
  slam: { from: "{ scale: 1.7, opacity: 0 }", to: '{ scale: 1, opacity: 1, duration: 0.2, ease: "back.out(2.4)" }' },
  rise: { from: "{ y: 70, opacity: 0 }", to: '{ y: 0, opacity: 1, duration: 0.3, ease: "expo.out" }' },
  // 끝 상태를 바깥으로 넓혀 외곽선 · 그림자가 잘리지 않게 한다
  wipe: { from: '{ clipPath: "inset(-40% 100% -40% -10%)" }', to: '{ clipPath: "inset(-40% -10% -40% -10%)", duration: 0.24, ease: "power2.out" }' },
  fade: { from: "{ opacity: 0, y: 8 }", to: '{ opacity: 1, y: 0, duration: 0.09, ease: "power2.out" }' },
};

export interface CaptionInput {
  id: string;
  text: string;
  emphasis: string[];
  start: number;
  end: number;
}

/** 자막 한 묶음의 html과 움직임. 낱말 시각은 묶음 안에서 글자 수 비율로 나눈다. */
export function captionBlock(c: CaptionInput, look: Look, zone: Zone): { html: string; motion: string; keyAt: number | null } {
  const tokens = tokenize(c.text, c.emphasis);
  const box = ZONE_BOX[zone];
  const width = 952;
  const size = look.size;
  const big = look.size * look.emphasis_scale;
  const hasKey = tokens.some((t) => t.key);
  const ids = tokens.map((_, i) => `${c.id}w${i}`);
  let rows: string;
  if (look.layout === "key_line" && hasKey) {
    const first = tokens.findIndex((t) => t.key);
    const lastKey = tokens.length - 1 - [...tokens].reverse().findIndex((t) => t.key);
    const row = (from: number, to: number) => {
      const part = tokens.slice(from, to);
      const joined = part.map((t) => t.text).join(" ");
      const s = part.some((t) => t.key) ? fit(joined, big, width) : fit(joined, size, width);
      return part.length ? `<div class="row">${part.map((t, i) => word(ids[from + i], t, s, look, from + i)).join("")}</div>` : "";
    };
    rows = row(0, first) + row(first, lastKey + 1) + row(lastKey + 1, tokens.length);
  } else {
    rows = `<div class="row">${tokens.map((t, i) => word(ids[i], t, fit(t.text, t.key ? big : size, width), look, i)).join("")}</div>`;
  }
  const html = `<div id="${c.id}" class="lk clip" data-start="${c.start}" data-duration="${(c.end - c.start).toFixed(3)}" style="top:${box.top}px;height:${box.height}px">${rows}</div>`;

  const enter = ENTER[look.entrance];
  const total = tokens.reduce((s, t) => s + Math.max(t.text.length, 1), 0);
  const span = c.end - c.start;
  let t = c.start;
  const motion: string[] = [];
  let keyAt: number | null = null;
  tokens.forEach((tok, i) => {
    const at = look.reveal === "word" ? t : c.start;
    if (tok.key && keyAt === null) keyAt = at;
    motion.push(`tl.fromTo("#${ids[i]}", ${enter.from}, ${enter.to}, ${at.toFixed(3)});`);
    t += (span * Math.max(tok.text.length, 1)) / total;
  });
  return { html, motion: motion.join("\n    "), keyAt };
}

/** 후킹 · 표지의 큰 글자. 첫 프레임부터 보여야 하므로 등장 움직임을 넣지 않는다. */
export function bigText(lines: string[], highlight: string, look: Look, max: number, width: number): string {
  const size = Math.floor(Math.min(max, width / Math.max(1, ...lines.map(units))));
  return lines
    .map((line, n) => {
      const parts = highlight && line.includes(highlight) ? line.split(highlight) : [line];
      const tokens: string[] = [];
      parts.forEach((p, i) => {
        if (p.trim()) tokens.push(`<span class="w" style="font-size:${size}px;${look.tilt ? `rotate:${(TILTS[n % TILTS.length] * look.tilt).toFixed(2)}deg;` : ""}">${esc(p.trim())}</span>`);
        if (i < parts.length - 1) tokens.push(`<span class="w k" style="font-size:${size}px;${look.tilt ? `rotate:${(TILTS[(n + 1) % TILTS.length] * look.tilt).toFixed(2)}deg;` : ""}">${esc(highlight)}</span>`);
      });
      return `<div class="row">${tokens.join("")}</div>`;
    })
    .join("");
}
