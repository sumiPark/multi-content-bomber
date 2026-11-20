import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { editKit, editKitAsset } from "@/lib/agents/ko-skills";
import { agentModel } from "@/lib/agents/runner";
import { getOpenAI } from "@/lib/openai";
import { callOptions } from "@/lib/products/analysis/analyze";
import { ffmpeg } from "@/lib/shoot/video-kit/tools";
import { warnIfError } from "@/lib/supabase/result";
import type { createServiceClient } from "@/lib/supabase/service";

// 영상마다 음악을 찾는다. 편집 에이전트가 설정 · 상품 · 장면을 읽고 검색어를 내면, Openverse에서 CC0만 찾아
// AI가 제목 · 태그로 음악 후보를 고르고, 코드가 내려받아 길이 · 무음 · 음량을 잰다. 통과한 첫 곡을 쓴다.
// 찾지 못하면 kit.json의 music_library에서 고른 곡을 쓴다. 다른 유료 서비스로 넘어가지 않는다.
// 소리를 귀로 듣지는 못한다. 쓴 곡의 출처는 완성본 기록에 남겨 사람이 확인할 수 있게 한다.
// 스타일 쇼츠만(judge를 넘긴 경우): 제목 · 태그로 고르면 분위기가 다른 곡 · 짧은 루프가 섞여(2026-11-20 사용자 지적)
// 후보를 한데 모아 내려받고, 소리를 재는 판정기(earshot, lib/style-shorts/music-fit.ts)가 통과시킨 곡만 쓴다.

type Service = ReturnType<typeof createServiceClient>;

const REPEAT_DAYS = 14;
const MIN_SECONDS = 30;
const MAX_SECONDS = 420;
const MAX_SILENCE = 0.15;
const MIN_LUFS = -38;
const TARGET_LUFS = -23;
// 판정기에 한 번에 들려줄 후보 수 · 한 곡을 내려받는 데 기다리는 시간 · 동시에 받는 수
const JUDGE_BATCH = 10;
// 한 번 고를 때 내려받아 들어 보는 묶음 수 상한(묶음 하나에 1~2분)
const JUDGE_ROUNDS = 4;
const DOWNLOAD_TIMEOUT_MS = 45_000;
const DOWNLOAD_PARALLEL = 5;
// 판정기를 쓸 때 검색어마다 보는 쪽 수(한 쪽 20곡). 첫 쪽만 보면 후보가 금방 바닥난다
// (2026-11-20 실측: "upbeat playful funk"의 첫 쪽 후보 27곡 중 24곡이 최근 14일 안에 쓴 곡이었다. "funk"만 240곡이 있다)
const JUDGE_PAGES = 3;
const PAGE_SIZE = 20;
// 곡을 바꿀 때: 먼저 고른 곡과 닮은 정도(0~1)를 점수에 더하는 크기
const LIKE_WEIGHT = 2;
// 효과음 · 현장음 · 노래처럼 배경음악으로 쓸 수 없는 것을 먼저 뺀다
const NOT_MUSIC = /ambien[ct]e|noise|wind\b|rain\b|water|stream|river|sfx|effect|birthday|vocal|voice|lyric|sing|speech|talk|field.?record|drum.?kit|one.?shot|kick|snare/i;

export interface MusicSource {
  provider: "Openverse";
  id: string;
  title: string;
  creator: string;
  source: string;
  landing: string;
  url: string;
  license: string;
  license_url: string;
}

export interface PickedMusic {
  name: string;
  in: number;
  gain_db: number;
  source: MusicSource | null;
  query: string | null;
}

export interface MusicToUse extends PickedMusic {
  file: string;
}

/** 판정기가 통과시킨 곡. score가 클수록 잘 맞는다. near · like는 다른 후보 · 먼저 고른 곡과 소리가 닮은 정도(0~1) */
export interface JudgedTrack {
  id: string;
  score: number;
  near: Record<string, number>;
  like: number | null;
}

/**
 * 내려받은 후보를 들어 보고 쓸 수 있는 곡만 돌려준다(없으면 빈 배열).
 * 잴 수 없으면(도구 없음 · 실패) null — 그때는 예전처럼 제목 순위의 첫 곡을 쓴다.
 */
export type MusicJudge = (req: {
  query: string;
  intent: string;
  tracks: { id: string; file: string; start: number; title: string }[];
  like: { file: string; start: number } | null;
  // 이 곡을 이어서 쓰는 길이(초) — 곡의 앞부분이 잔잔한 도입이면 짧은 구간에서는 그 소리만 들린다
  seconds: number | null;
  workDir: string;
}) => Promise<JudgedTrack[] | null>;

interface FindOpts {
  service: Service | null;
  readService?: Service;
  query: string;
  intent: string;
  workDir: string;
  singleWords?: boolean;
  exclude?: string[];
  pool?: MusicPool;
  // 스타일 쇼츠만: 소리를 재서 고른다
  judge?: MusicJudge;
  // 곡을 바꿀 때 먼저 고른 곡 — 닮은 곡을 먼저 쓴다
  like?: { id: string | null; file: string; start: number };
  // 한 곡을 이어서 쓰는 가장 짧은 길이(초). 판정기가 그 구간의 소리로 분위기를 잰다
  seconds?: number;
}

interface Hit {
  id: string;
  title?: string;
  creator?: string;
  duration?: number;
  license?: string;
  license_url?: string;
  url?: string;
  source?: string;
  foreign_landing_url?: string;
  tags?: { name?: string }[];
}

function tagsOf(h: Hit): string {
  return (h.tags ?? []).map((t) => t.name).filter(Boolean).slice(0, 8).join(", ");
}

async function search(query: string, page = 1): Promise<Hit[]> {
  const params = new URLSearchParams({ q: query, license: "cc0", page_size: String(PAGE_SIZE), mature: "false", ...(page > 1 ? { page: String(page) } : {}) });
  const res = await fetch(`https://api.openverse.org/v1/audio/?${params}`, { headers: { "User-Agent": "MCB-Video/1.0" } });
  if (!res.ok) throw new Error(`Openverse ${res.status}`);
  return ((await res.json()) as { results?: Hit[] }).results ?? [];
}

/** 제목 · 태그만 보고 어울리는 순서로 고른다. 실패하면 검색 순서 그대로. */
async function rank(hits: Hit[], intent: string, max = 4): Promise<Hit[]> {
  if (hits.length <= 1 || !process.env.OPENAI_API_KEY) return max > 4 ? hits.slice(0, max) : hits;
  try {
    const model = agentModel();
    const completion = await getOpenAI().chat.completions.create({
      model,
      // id 하나가 20토큰쯤이다
      ...callOptions(model, 400 + Math.max(0, max - 4) * 30),
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: `릴스 배경음악 후보다. 원하는 분위기: ${intent}\n노래(가사), 효과음, 현장음, 드럼만 있는 소리는 뺀다. 어울리는 순서로 최대 ${max}개를 고른다.\nJSON만 답한다: {"ids":["..."]}\n${JSON.stringify(hits.map((h) => ({ id: h.id, title: h.title, seconds: Math.round((h.duration ?? 0) / 1000), tags: tagsOf(h) })))}`,
        },
      ],
    });
    const ids = (JSON.parse(completion.choices[0]?.message?.content ?? "{}") as { ids?: string[] }).ids ?? [];
    const picked = ids.map((id) => hits.find((h) => h.id === id)).filter((h): h is Hit => !!h);
    return picked.length ? picked : hits.slice(0, max);
  } catch (e) {
    console.warn("[video-kit] 음악 후보 고르기 실패:", e instanceof Error ? e.message : e);
    return hits.slice(0, max);
  }
}

/** 음량 · 앞 무음 · 무음 비율을 잰다. */
function measure(file: string, seconds: number): { lufs: number; start: number; silence: number } | null {
  const out = ffmpeg(["-hide_banner", "-i", file, "-af", "silencedetect=noise=-40dB:d=0.3,ebur128=framelog=quiet", "-f", "null", "-"]);
  const m = [...out.matchAll(/I:\s+(-?[0-9.]+) LUFS/g)].pop();
  if (!m) return null;
  const firstStart = out.match(/silence_start: ([0-9.]+)/);
  const firstEnd = out.match(/silence_end: ([0-9.]+)/);
  const start = firstStart && Number(firstStart[1]) < 0.05 && firstEnd ? Number(firstEnd[1]) : 0;
  const silent = [...out.matchAll(/silence_duration: ([0-9.]+)/g)].reduce((s, x) => s + Number(x[1]), 0);
  return { lufs: Number(m[1]), start, silence: silent / Math.max(seconds, 1) };
}

/** 검색해서 고른다. 없거나 실패하면 null. */
// exclude: 이미 고른 곡 id(스타일 쇼츠가 곡을 바꿀 때 같은 곡을 다시 고르지 않게). 받은 파일은 workDir에 둔다 — 여러 곡을 고르면 부르는 쪽이 폴더를 나눈다
// pool: 한 영상에서 곡을 여러 번 고를 때(스타일 쇼츠의 곡 바꿈) 검색 · AI 순위 결과를 이어 쓴다 — 같은 검색어 · 분위기면 다시 찾지 않고 순위의 다음 곡을 쓴다
// judge: 스타일 쇼츠만. 검색어별로 첫 곡을 쓰지 않고 후보를 모아 소리를 재서 고른다(findJudged)
export async function findMusic(opts: FindOpts): Promise<MusicToUse | null> {
  const words = opts.query.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  // 검색 결과는 낱말을 모두 포함한 것만 나와 긴 검색어는 비기 쉽다. 없으면 낱말을 줄여 다시 찾는다.
  // singleWords(스타일 쇼츠만): 두 낱말도 몇 곡뿐이라 최근 사용 · 무음 검사에서 다 빠질 수 있다
  // (2026-11-19 실측: "playful funk pop" 1곡, "funk pop" 6곡 → 대체 곡). 마지막엔 한 낱말씩 찾는다
  const tries = [...new Set([words.join(" "), words.slice(-2).join(" "), words.slice(0, 2).join(" "), ...(opts.singleWords ? words : [])])];
  if (opts.judge) return findJudged(opts, tries);
  for (const query of tries) {
    const found = await findWith({ ...opts, query });
    if (found) return found;
  }
  return null;
}

/**
 * 검색어 · 분위기별로 남은 순위. 값이 빈 배열이고 none이면 쓸 곡이 없던 검색어라 다시 찾지 않는다.
 * 순위를 다 쓴 검색어(none 아님)는 예전처럼 다시 검색한다.
 */
// 판정기를 쓸 때: left는 아직 듣지 않은 새 곡, recent는 최근 14일 안에 쓴 곡(오래전에 쓴 순서), ready는 통과한 곡
export type MusicPool = Map<string, { left: Hit[]; none: boolean; ready?: Ready[]; recent?: Hit[] }>;

/** 내려받아 재고 판정까지 통과한 곡 */
interface Ready extends JudgedTrack {
  hit: Hit;
  file: string;
  start: number;
  lufs: number;
}

function usable(h: Hit, exclude?: string[]): boolean {
  const sec = (h.duration ?? 0) / 1000;
  return h.license === "cc0" && !!h.url && !exclude?.includes(h.id) && sec >= MIN_SECONDS && sec <= MAX_SECONDS && !NOT_MUSIC.test(`${h.title ?? ""} ${tagsOf(h)}`);
}

function sourceOf(h: Hit): MusicSource {
  return { provider: "Openverse", id: h.id, title: h.title ?? "", creator: h.creator ?? "", source: h.source ?? "", landing: h.foreign_landing_url ?? "", url: h.url!, license: h.license ?? "", license_url: h.license_url ?? "" };
}

/** 못 쓰는 곡으로 적힌 id와, 최근 14일 안에 쓴 곡의 마지막 사용 시각 */
async function knownTracks(read: Service | null | undefined, ids: string[]): Promise<{ rejected: Set<string>; recent: Map<string, number> }> {
  const { data: known } = read && ids.length ? await read.from("stock_music").select("track_id, rejected, last_used_at").in("track_id", ids) : { data: [] };
  const cutoff = Date.now() - REPEAT_DAYS * 86_400_000;
  const rejected = new Set<string>();
  const recent = new Map<string, number>();
  for (const k of known ?? []) {
    if (k.rejected) rejected.add(k.track_id);
    else if (k.last_used_at && Date.parse(k.last_used_at) > cutoff) recent.set(k.track_id, Date.parse(k.last_used_at));
  }
  return { rejected, recent };
}

async function recordTrack(service: Service | null, h: Hit, state: { rejected: boolean; reason: string | null; used: boolean }): Promise<void> {
  if (!service) return;
  const source = sourceOf(h);
  const saved = await service.from("stock_music").upsert({
    track_id: h.id,
    title: source.title,
    creator: source.creator,
    landing: source.landing,
    license: source.license,
    rejected: state.rejected,
    reason: state.reason,
    ...(state.used ? { last_used_at: new Date().toISOString() } : {}),
  });
  warnIfError(saved, `배경 음악 기록 (track=${h.id})`);
}

/** 순서를 지키며 한 번에 limit개씩 처리한다. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** 곡을 바꿀 때는 먼저 고른 곡과 닮은 곡을 앞에 둔다. */
export function orderReady<T extends JudgedTrack>(ready: T[], likeId: string | null | undefined): T[] {
  const like = (r: T) => (likeId ? (r.near[likeId] ?? r.like) : r.like);
  const value = (r: T) => r.score + LIKE_WEIGHT * (like(r) ?? 0);
  return [...ready].sort((a, b) => value(b) - value(a));
}

/**
 * 판정기로 고른다(스타일 쇼츠). 검색어를 줄여 가며 찾은 후보를 한데 모아 제목 순위를 매기고,
 * JUDGE_BATCH개씩 내려받아 무음 · 음량을 잰 뒤 판정기에 들려준다. 통과한 곡은 pool에 남겨 곡을 바꿀 때 다시 받지 않는다.
 * 최근 14일 안에 쓴 곡은 새 곡을 다 들어 본 뒤에만 듣는다 — 통과한 새 곡이 없으면 가장 오래전에 쓴 통과 곡을 다시 쓴다.
 * (무료 곡이 얇아 새 곡만 고집하면 분위기가 다른 곡 · 루프만 남는다. 2026-11-20 실측)
 */
async function findJudged(opts: FindOpts, tries: string[]): Promise<MusicToUse | null> {
  const key = `judged\n${opts.query}\n${opts.intent}`;
  const pool: MusicPool = opts.pool ?? new Map();
  try {
    let state = pool.get(key);
    if (!state) {
      const hits: Hit[] = [];
      for (const query of tries) {
        try {
          for (let page = 1; page <= JUDGE_PAGES; page++) {
            const found = await search(query, page);
            for (const h of found) if (usable(h, opts.exclude) && !hits.some((x) => x.id === h.id)) hits.push(h);
            if (found.length < PAGE_SIZE) break;
          }
        } catch (e) {
          console.warn(`[video-kit] 음악 검색 실패 ("${query}"):`, e instanceof Error ? e.message : e);
        }
      }
      const known = await knownTracks(opts.readService ?? opts.service, hits.map((h) => h.id));
      const fresh = hits.filter((h) => !known.rejected.has(h.id) && !known.recent.has(h.id));
      const recent = hits.filter((h) => known.recent.has(h.id)).sort((a, b) => known.recent.get(a.id)! - known.recent.get(b.id)!);
      console.log(`[video-kit] 음악 후보 ${hits.length}곡(새 곡 ${fresh.length} · 최근 쓴 곡 ${recent.length} · 제외 ${known.rejected.size})`);
      // 제목 순위에서 빠진 곡도 뒤에 남긴다 — 앞 묶음에서 통과한 곡이 없으면 듣는다
      const ranked = await rank(fresh, opts.intent || opts.query, JUDGE_BATCH * 2);
      state = { left: [...ranked, ...fresh.filter((h) => !ranked.includes(h))], none: false, ready: [], recent };
      pool.set(key, state);
    }
    for (let round = 0; ; ) {
      const ready = orderReady((state.ready ?? []).filter((r) => !opts.exclude?.includes(r.id)), opts.like?.id);
      const pick = ready[0];
      if (pick) {
        state.ready = (state.ready ?? []).filter((r) => r.id !== pick.id);
        await recordTrack(opts.service, pick.hit, { rejected: false, reason: null, used: true });
        const gain = Math.max(-18, Math.min(8, TARGET_LUFS - pick.lufs));
        return { name: pick.hit.title || pick.id, file: pick.file, in: Number(pick.start.toFixed(2)), gain_db: Number(gain.toFixed(1)), source: sourceOf(pick.hit), query: opts.query };
      }
      if (!state.left.length && state.recent?.length) {
        console.log(`[video-kit] 통과한 새 곡이 없어 최근 쓴 곡 ${state.recent.length}곡을 들어 봐요`);
        state.left = state.recent;
        state.recent = [];
      }
      if (!state.left.length || round++ >= JUDGE_ROUNDS) return null;
      const batch = state.left.splice(0, JUDGE_BATCH).filter((h) => !opts.exclude?.includes(h.id));
      if (!batch.length) continue;
      const got = await mapLimit(batch, DOWNLOAD_PARALLEL, async (h) => {
        try {
          const res = await fetch(h.url!, { headers: { "User-Agent": "MCB-Video/1.0" }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
          if (!res.ok) return null;
          const file = join(opts.workDir, `music-${h.id}`);
          writeFileSync(file, Buffer.from(await res.arrayBuffer()));
          const m = measure(file, (h.duration ?? 0) / 1000);
          const ok = !!m && m.silence <= MAX_SILENCE && m.lufs >= MIN_LUFS;
          if (!ok) await recordTrack(opts.service, h, { rejected: true, reason: `무음 ${(((m?.silence ?? 0) * 100) | 0)}% · ${m?.lufs ?? "?"} LUFS`, used: false });
          return ok && m ? { hit: h, file, start: m.start, lufs: m.lufs } : null;
        } catch {
          return null;
        }
      });
      const heard = got.filter((g): g is NonNullable<typeof g> => !!g);
      if (!heard.length) continue;
      const judged = await opts.judge!({
        query: opts.query,
        intent: opts.intent,
        tracks: heard.map((g) => ({ id: g.hit.id, file: g.file, start: g.start, title: g.hit.title ?? "" })),
        like: opts.like ? { file: opts.like.file, start: opts.like.start } : null,
        seconds: opts.seconds ?? null,
        workDir: opts.workDir,
      });
      // 잴 수 없으면 예전처럼 제목 순위대로 쓴다
      const passed: JudgedTrack[] = judged ?? heard.map((g, i) => ({ id: g.hit.id, score: -i, near: {}, like: null }));
      state.ready = passed.flatMap((j) => {
        const g = heard.find((x) => x.hit.id === j.id);
        return g ? [{ ...j, ...g }] : [];
      });
    }
  } catch (e) {
    console.warn("[video-kit] 음악 검색 실패:", e instanceof Error ? e.message : e);
    return null;
  }
}

async function findWith(opts: FindOpts): Promise<MusicToUse | null> {
  const query = opts.query;
  const read = opts.readService ?? opts.service;
  const key = `${query}\n${opts.intent}`;
  try {
    const kept = opts.pool?.get(key);
    if (kept?.none) return null;
    let ranked = kept?.left.filter((h) => !opts.exclude?.includes(h.id)) ?? [];
    const fromPool = ranked.length > 0;
    if (!ranked.length) {
      const hits = (await search(query)).filter((h) => {
        const sec = (h.duration ?? 0) / 1000;
        return h.license === "cc0" && h.url && !opts.exclude?.includes(h.id) && sec >= MIN_SECONDS && sec <= MAX_SECONDS && !NOT_MUSIC.test(`${h.title ?? ""} ${tagsOf(h)}`);
      });
      if (!hits.length) {
        opts.pool?.set(key, { left: [], none: true });
        return null;
      }
      const { data: known } = read ? await read.from("stock_music").select("track_id, rejected, last_used_at").in("track_id", hits.map((h) => h.id)) : { data: [] };
      const cutoff = Date.now() - REPEAT_DAYS * 86_400_000;
      const blocked = new Set((known ?? []).filter((k) => k.rejected || (k.last_used_at && Date.parse(k.last_used_at) > cutoff)).map((k) => k.track_id));
      ranked = await rank(hits.filter((h) => !blocked.has(h.id)), opts.intent || query);
    }
    for (const [i, h] of ranked.entries()) {
      // 써 본 곡은 순위에서 뺀다 — 다음에 고를 때 그 뒤 곡부터 본다
      opts.pool?.set(key, { left: ranked.slice(i + 1), none: false });
      const file = join(opts.workDir, `music-${i}`);
      const res = await fetch(h.url!, { headers: { "User-Agent": "MCB-Video/1.0" } });
      if (!res.ok) continue;
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      const seconds = (h.duration ?? 0) / 1000;
      const m = measure(file, seconds);
      const ok = !!m && m.silence <= MAX_SILENCE && m.lufs >= MIN_LUFS;
      const source: MusicSource = { provider: "Openverse", id: h.id, title: h.title ?? "", creator: h.creator ?? "", source: h.source ?? "", landing: h.foreign_landing_url ?? "", url: h.url!, license: h.license ?? "", license_url: h.license_url ?? "" };
      if (opts.service) {
        const saved = await opts.service.from("stock_music").upsert({
          track_id: h.id,
          title: source.title,
          creator: source.creator,
          landing: source.landing,
          license: source.license,
          rejected: !ok,
          reason: ok ? null : `무음 ${(((m?.silence ?? 0) * 100) | 0)}% · ${m?.lufs ?? "?"} LUFS`,
          ...(ok ? { last_used_at: new Date().toISOString() } : {}),
        });
        warnIfError(saved, `배경 음악 기록 (track=${h.id})`);
      }
      if (!ok || !m) continue;
      const gain = Math.max(-18, Math.min(8, TARGET_LUFS - m.lufs));
      return { name: source.title || h.id, file, in: Number(m.start.toFixed(2)), gain_db: Number(gain.toFixed(1)), source, query };
    }
    // 이어 쓰던 순위가 다 떨어졌으면 예전처럼 한 번 새로 검색한다
    if (fromPool) {
      opts.pool?.delete(key);
      return findWith(opts);
    }
    return null;
  } catch (e) {
    console.warn("[video-kit] 음악 검색 실패:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** 다시 편집: 처음 고른 곡을 그대로 쓴다. 받지 못하면 null. */
export async function reloadMusic(picked: PickedMusic, workDir: string, fileName = "music-reuse"): Promise<MusicToUse | null> {
  if (!picked.source?.url) return null;
  try {
    const res = await fetch(picked.source.url, { headers: { "User-Agent": "MCB-Video/1.0" } });
    if (!res.ok) return null;
    const file = join(workDir, fileName);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    return { ...picked, file };
  } catch {
    return null;
  }
}

/** 검색이 안 될 때 쓰는 곡(kit.json). */
export function libraryMusic(name: string): MusicToUse {
  const kit = editKit();
  const m = kit.music_library.find((x) => x.file === name) ?? kit.music;
  return { name: m.file, file: editKitAsset("music", `${m.file}.mp3`), in: m.in, gain_db: m.gain_db, source: null, query: null };
}
