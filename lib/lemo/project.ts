import fs from "node:fs";
import path from "node:path";

import { characterSpecSchema, productionSchema, type CharacterSpec, type Production } from "./contract";

// lemo 렌더 프로젝트 폴더 만들기.
// <workDir>/film/ = 공통 엔진 + 그 production의 스타일 모듈 하나 + production.account_key 폴더의 캐릭터만 + production.json.
// lemo 라이브러리 렌더 도구는 저장소 밖 폴더를 /@film/에 마운트하므로, 페이지는 /core/lib.js(라이브러리)와 상대 경로(엔진)만 쓴다.

const LEMO_DIR = path.join(process.cwd(), "lib", "lemo");
export const ENGINE_DIR = path.join(LEMO_DIR, "engine");
export const LIBRARY_DIR = path.join(LEMO_DIR, "library");

// 엔진 공통 파일(스타일 폴더 · 계정 캐릭터는 따로 복사)
const ENGINE_FILES = ["index.html", "main.js", "timeline.js", "parametric.js", "props.js", "fx.js", "transitions.js", "geom.js", "sheet.js", "manifest.json", "LICENSE-lemo-opuscar"];

export function styleSlugs(): string[] {
  const dir = path.join(ENGINE_DIR, "styles");
  return fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, "style.js")));
}

export function accountDir(accountKey: string, libraryRoot = LIBRARY_DIR): string {
  if (!/^[A-Za-z0-9._-]+$/.test(accountKey)) throw new Error(`계정 이름 ${accountKey}에 쓸 수 없는 글자가 있어요`);
  return path.join(libraryRoot, "accounts", accountKey);
}

function copyEngine(film: string, slug: string): void {
  const styleSrc = path.join(ENGINE_DIR, "styles", slug);
  if (!/^[a-z0-9-]+$/.test(slug) || !fs.existsSync(path.join(styleSrc, "style.js"))) {
    throw new Error(`스타일 ${slug} 모듈이 엔진에 없어요(있는 것: ${styleSlugs().join(", ")})`);
  }
  fs.mkdirSync(film, { recursive: true });
  for (const f of ENGINE_FILES) fs.copyFileSync(path.join(ENGINE_DIR, f), path.join(film, f));
  fs.cpSync(path.join(ENGINE_DIR, "fonts"), path.join(film, "fonts"), { recursive: true });
  fs.cpSync(styleSrc, path.join(film, "styles", slug), { recursive: true });
}

// 캐릭터 한 명을 film/characters/<id>/로. module 리그면 rig.js가 반드시 있어야 한다
function copyCharacter(film: string, spec: CharacterSpec, srcDir: string | null): void {
  const dst = path.join(film, "characters", spec.id);
  fs.mkdirSync(dst, { recursive: true });
  fs.writeFileSync(path.join(dst, "spec.json"), JSON.stringify(spec, null, 2));
  if (spec.rig !== "module") return;
  const rig = srcDir ? path.join(srcDir, "rig.js") : null;
  if (!rig || !fs.existsSync(rig)) throw new Error(`캐릭터 ${spec.id}는 module 리그인데 rig.js가 없어요(${rig ?? "폴더 미지정"})`);
  fs.copyFileSync(rig, path.join(dst, "rig.js"));
}

/**
 * 영상 렌더 폴더를 만든다. 반환값은 film 폴더 경로(renderStills · renderVideo의 filmDir).
 * - production은 쓰기 전에 productionSchema.parse로 검사한다.
 * - cast가 다른 계정 캐릭터를 요구하면(또는 라이브러리에 없으면) throw — 다른 계정 캐릭터 폴더는 복사하지 않는다.
 * - 같은 workDir의 이전 film 폴더는 지우고 새로 만든다.
 */
export function buildFilmProject(opts: { workDir: string; production: Production; library: CharacterSpec[]; libraryRoot?: string }): string {
  const production = productionSchema.parse(opts.production);
  const root = opts.libraryRoot ?? LIBRARY_DIR;
  const accDir = accountDir(production.account_key, root);
  const byId = new Map(opts.library.map((c) => [c.id, c]));
  const used = new Map<string, CharacterSpec>();
  for (const c of production.cast) {
    const raw = byId.get(c.character);
    if (!raw) throw new Error(`배역 ${c.id}의 캐릭터 ${c.character}가 라이브러리 목록에 없어요`);
    const spec = characterSpecSchema.parse(raw);
    if (spec.account_key !== production.account_key) {
      throw new Error(`캐릭터 ${spec.id}는 ${spec.account_key} 계정 것이라 ${production.account_key} 영상에 쓸 수 없어요`);
    }
    used.set(spec.id, spec);
  }
  const film = path.join(opts.workDir, "film");
  fs.rmSync(film, { recursive: true, force: true });
  copyEngine(film, production.style.slug);
  for (const spec of used.values()) {
    const dir = path.join(accDir, "characters", spec.id);
    copyCharacter(film, spec, fs.existsSync(dir) ? dir : null);
  }
  const acc = path.join(accDir, "account.json");
  if (fs.existsSync(acc)) fs.copyFileSync(acc, path.join(film, "account.json"));
  fs.writeFileSync(path.join(film, "characters.json"), JSON.stringify([...used.values()], null, 2));
  fs.writeFileSync(path.join(film, "production.json"), JSON.stringify(production, null, 2));
  return film;
}

// 시트용 최소 production의 배경(스타일 첫 배경)
function firstBackground(slug: string): string {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(ENGINE_DIR, "manifest.json"), "utf8")) as { styles: Record<string, { backgrounds: { kind: string }[] }> };
    return m.styles[slug]?.backgrounds?.[0]?.kind ?? "paper";
  } catch {
    return "paper";
  }
}

/**
 * 캐릭터 시트 렌더 폴더(<workDir>/sheet-<id>/)를 만든다. still로 `--q sheet=<id>`(renderStills의 query { sheet: id })를 찍는다.
 * 새로 만든 캐릭터가 아직 라이브러리 밖에 있으면 characterDir(rig.js가 있는 폴더)를 준다. 없으면 계정 라이브러리 폴더에서 찾는다.
 * 시트 폴더도 일반 렌더가 되는 3초짜리 production(가만히 서 있는 장면)을 함께 쓴다.
 */
export function buildSheetProject(opts: { workDir: string; accountKey: string; character: CharacterSpec; characterDir?: string; style: string; brand: Production["brand"]; libraryRoot?: string }): string {
  const spec = characterSpecSchema.parse(opts.character);
  if (spec.account_key !== opts.accountKey) throw new Error(`캐릭터 ${spec.id}는 ${spec.account_key} 계정 것이라 ${opts.accountKey} 시트에 쓸 수 없어요`);
  const production = productionSchema.parse({
    version: 1,
    size: { w: 1080, h: 1920 },
    fps: 30,
    duration: 3,
    account_key: opts.accountKey,
    series: spec.series,
    style: { slug: opts.style, params: {} },
    brand: opts.brand,
    cast: [{ id: "c", character: spec.id, role: "시트" }],
    backgrounds: [{ id: "bg", kind: firstBackground(opts.style), params: {} }],
    scenes: [
      {
        id: "s1", beat: 0, start: 0, end: 3, purpose: "캐릭터 시트 확인용으로 서 있음", background: "bg",
        camera: { from: { x: 0.5, y: 0.5, zoom: 1, rot: 0 }, to: { x: 0.5, y: 0.5, zoom: 1, rot: 0 }, ease: "linear" },
        actors: [{ cast: "c", from: { x: 0.5, y: 0.7, scale: 1.5, facing: "front" }, to: null, expr: spec.expressions[0] ?? "neutral", expr_to: null, expr_at: null, action: "idle", look: null, enter_at: null, exit_at: null }],
        props: [], fx: [], transition_in: "cut", caption_place: "lower",
      },
    ],
    sfx: [],
  });
  const dir = path.join(opts.workDir, `sheet-${spec.id}`);
  fs.rmSync(dir, { recursive: true, force: true });
  copyEngine(dir, opts.style);
  const libDir = path.join(accountDir(opts.accountKey, opts.libraryRoot ?? LIBRARY_DIR), "characters", spec.id);
  const src = opts.characterDir ?? (fs.existsSync(libDir) ? libDir : null);
  copyCharacter(dir, spec, src);
  fs.writeFileSync(path.join(dir, "characters.json"), JSON.stringify([spec], null, 2));
  fs.writeFileSync(path.join(dir, "production.json"), JSON.stringify(production, null, 2));
  return dir;
}

/** 계정 라이브러리의 캐릭터 명세를 모두 읽는다(spec.json마다 characterSpecSchema 검사). */
export function loadAccountLibrary(accountKey: string, libraryRoot = LIBRARY_DIR): CharacterSpec[] {
  const dir = path.join(accountDir(accountKey, libraryRoot), "characters");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => fs.existsSync(path.join(dir, n, "spec.json")))
    .map((n) => characterSpecSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, n, "spec.json"), "utf8"))));
}
