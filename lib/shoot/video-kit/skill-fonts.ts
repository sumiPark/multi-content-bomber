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

/** AI가 고른 이름을 목록과 대조한다. 목록에 없거나 예전 계획이면 스킬 기본 짝. */
export function chosenFonts(list: SkillFont[], picked: { key_font?: string; small_font?: string }): { key: SkillFont; small: SkillFont } {
  const find = (name: string | undefined, fallback: string) => list.find((f) => f.name === name) ?? list.find((f) => f.name === fallback) ?? list[0];
  const key = find(picked.key_font, DEFAULT_KEY);
  const small = find(picked.small_font, DEFAULT_SMALL);
  if (!key || !small) throw new Error("스킬 글꼴 목록이 비어 있어요");
  return { key, small };
}

/** 강조어는 가장 굵은 파일, 작은 줄은 보통 굵기에 가장 가까운 파일. */
function sourceOf(font: SkillFont, heavy: boolean): string {
  const weight = (w: number | string) => (typeof w === "number" ? w : 400);
  const sorted = [...font.webfont].sort((a, b) => (heavy ? weight(b.weight) - weight(a.weight) : Math.abs(weight(a.weight) - 400) - Math.abs(weight(b.weight) - 400)));
  return sorted[0].src;
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
