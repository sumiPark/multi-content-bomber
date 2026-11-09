import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { VideoFonts } from "@/lib/shoot/video-kit/compose";

// 영상 글꼴은 고정하지 않는다. 영상마다 AI가 내용에 맞게 자막 모션 스킬의 글꼴 중에서 고른다(2026-11-05 사용자 결정).
// 고딕으로 분류된 글꼴은 후보에서 뺀다(사용자 결정). 스킬이나 글꼴을 못 구하면 편집 키트의 기본 글꼴로 대체해 영상은 만든다.
// 글꼴 파일은 재배포 금지라 저장소 · 실행 기록에 넣지 않는다. 스킬 목록의 공식 주소에서 실행할 때 받아 작업 폴더에만 둔다.

export interface SkillFont {
  name: string;
  role: string;
  look: string;
  webfont: { weight: number | string; src: string }[];
}

// AI가 고른 값을 못 쓸 때의 스킬 기본 짝
const DEFAULT_KEY = "그리운 코코초이툰";
const DEFAULT_SMALL = "온글잎 박다현체";
const FAMILY = "MCB Video";
const MIN_BYTES = 10_000;
const TRIES = 3;

/** 고를 수 있는 글꼴: 한글이 있고 고딕이 아닌 것. */
export function loadSkillFonts(dir: string): SkillFont[] {
  const list = JSON.parse(readFileSync(join(dir, "references", "fonts.json"), "utf8")) as (SkillFont & { lang?: string })[];
  return list.filter((f) => f.lang === "ko" && f.webfont?.length && !/고딕/.test(`${f.name} ${f.role} ${f.look}`));
}

// 스킬 안내(SKILL.md 「폰트 바꾸기」 · 「디자인 자막 기본 짝꿍」)의 짝 고르는 규칙을 고딕 제외 목록에 맞춰 옮긴 것.
// 글꼴을 고르는 에이전트(자막 디자인 · 장면표)가 같은 규칙을 읽게 한 곳에 둔다. 특정 글꼴을 정하지 않는다.
export const FONT_PAIRING_RULES = [
  "강조어 글꼴(key_font)은 크게 한눈에 읽히는 디스플레이체로, 작은 줄 글꼴(small_font)은 곁들이는 말이 가볍게 읽히는 글꼴로 짝짓는다. 둘의 차이는 크기와 색으로도 낸다.",
  "강조어 줄은 그 글꼴의 가장 굵은 굵기, 작은 줄은 보통 굵기로 나온다. 굵기가 여럿인 글꼴은 굵기 범위를 보고 고른다. 한 굵기뿐인 글꼴은 그 모양 그대로 나온다.",
  "두 글꼴은 성격이 달라야 한다. 같은 글꼴을 두 번 고르지 않는다.",
  "후킹 글자 · 자막 · 설명 화면 · 끝 화면 · 표지가 모두 이 두 글꼴로 나온다. 한 영상의 한글 글꼴은 이 두 개뿐이다.",
];

/** 글꼴 목록 한 줄: 이름 · 종류 · 인상 · 굵기. 굵기를 보여 줘야 강조어가 얼마나 굵게 나올지 알고 고른다. */
export function fontChoiceLines(list: SkillFont[]): string {
  return list
    .map((f) => {
      const weights = f.webfont.map((w) => w.weight).filter((w): w is number => typeof w === "number");
      const range = weights.length > 1 ? `굵기 ${Math.min(...weights)}~${Math.max(...weights)}` : "한 굵기";
      return `- ${f.name} · ${f.role} · ${f.look} · ${range}`;
    })
    .join("\n");
}

/**
 * 강조어는 가장 굵은 파일, 작은 줄은 보통 굵기(400)에 가장 가까운 파일. 자막(스킬)과 도식 · 끝 화면(HyperFrames)이 같은 값을 쓴다.
 * 한 굵기뿐인 글꼴(스킬 목록의 'single')은 null — 굵기를 지정하지 않는다.
 */
export function fontWeight(font: SkillFont, heavy: boolean): number | null {
  const numeric = font.webfont.map((w) => w.weight).filter((w): w is number => typeof w === "number");
  if (!numeric.length) return null;
  return heavy ? Math.max(...numeric) : [...numeric].sort((a, b) => Math.abs(a - 400) - Math.abs(b - 400) || a - b)[0];
}

/** AI가 고른 이름을 목록과 대조한다. 목록에 없거나 예전 계획이면 스킬 기본 짝. */
export function chosenFonts(list: SkillFont[], picked: { key_font?: string; small_font?: string }): { key: SkillFont; small: SkillFont } {
  const find = (name: string | undefined, fallback: string) => list.find((f) => f.name === name) ?? list.find((f) => f.name === fallback) ?? list[0];
  const key = find(picked.key_font, DEFAULT_KEY);
  const small = find(picked.small_font, DEFAULT_SMALL);
  if (!key || !small) throw new Error("스킬 글꼴 목록이 비어 있어요");
  return { key, small };
}

/** fontWeight와 같은 굵기의 파일. 자막과 도식의 굵기가 달라 다른 글꼴처럼 보이지 않게 한다. */
function sourceOf(font: SkillFont, heavy: boolean): string {
  const weight = fontWeight(font, heavy);
  return (font.webfont.find((w) => w.weight === weight) ?? font.webfont[0]).src;
}

async function download(url: string, file: string): Promise<void> {
  let last = "";
  for (let i = 0; i < TRIES; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      if (statSync(file).size >= MIN_BYTES) return;
      throw new Error("글꼴 파일이 아니에요");
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`글꼴을 받지 못했어요: ${last}`);
}

const FORMATS: Record<string, string> = { ".woff2": "woff2", ".woff": "woff", ".ttf": "truetype", ".otf": "opentype" };

/** 도식 · 끝 화면처럼 스킬 자막 밖의 글자도 고른 글꼴로 쓰게 받는다. 굵은 글자(800)는 강조어 글꼴, 나머지는 작은 줄 글꼴로 나온다. */
export async function downloadVideoFonts(fonts: { key: SkillFont; small: SkillFont }, workDir: string): Promise<VideoFonts> {
  const dir = join(workDir, "video-fonts");
  mkdirSync(dir, { recursive: true });
  const parts = [
    { role: "key", url: sourceOf(fonts.key, true) },
    { role: "small", url: sourceOf(fonts.small, false) },
  ].map((p) => {
    const ext = extname(new URL(p.url).pathname).toLowerCase();
    return { ...p, ext, name: `video-${p.role}${ext}`, from: join(dir, `video-${p.role}${ext}`) };
  });
  for (const p of parts) await download(p.url, p.from);
  const [key, small] = parts;
  const face = (family: string, weight: number | null, p: (typeof parts)[number]) =>
    `@font-face { font-family: "${family}";${weight ? ` font-weight: ${weight};` : ""} src: url("assets/fonts/${p.name}")${FORMATS[p.ext] ? ` format("${FORMATS[p.ext]}")` : ""}; }`;
  return {
    css: [face(FAMILY, 400, small), face(FAMILY, 600, small), face(FAMILY, 800, key), face(`${FAMILY} Small`, null, small)].join("\n    "),
    // 강조어 글꼴에 없는 기호(· 화살표 등)는 작은 줄 글꼴에서 찾는다
    family: `"${FAMILY}", "${FAMILY} Small", sans-serif`,
    files: parts.map((p) => ({ from: p.from, name: p.name })),
  };
}
