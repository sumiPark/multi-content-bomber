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

type Service = ReturnType<typeof createServiceClient>;

const REPEAT_DAYS = 14;
const MIN_SECONDS = 30;
const MAX_SECONDS = 420;
const MAX_SILENCE = 0.15;
const MIN_LUFS = -38;
const TARGET_LUFS = -23;
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

async function search(query: string): Promise<Hit[]> {
  const params = new URLSearchParams({ q: query, license: "cc0", page_size: "20", mature: "false" });
  const res = await fetch(`https://api.openverse.org/v1/audio/?${params}`, { headers: { "User-Agent": "MCB-Video/1.0" } });
  if (!res.ok) throw new Error(`Openverse ${res.status}`);
  return ((await res.json()) as { results?: Hit[] }).results ?? [];
}

/** 제목 · 태그만 보고 어울리는 순서로 고른다. 실패하면 검색 순서 그대로. */
async function rank(hits: Hit[], intent: string): Promise<Hit[]> {
  if (hits.length <= 1 || !process.env.OPENAI_API_KEY) return hits;
  try {
    const model = agentModel();
    const completion = await getOpenAI().chat.completions.create({
      model,
      ...callOptions(model, 400),
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: `릴스 배경음악 후보다. 원하는 분위기: ${intent}\n노래(가사), 효과음, 현장음, 드럼만 있는 소리는 뺀다. 어울리는 순서로 최대 4개를 고른다.\nJSON만 답한다: {"ids":["..."]}\n${JSON.stringify(hits.map((h) => ({ id: h.id, title: h.title, seconds: Math.round((h.duration ?? 0) / 1000), tags: tagsOf(h) })))}`,
        },
      ],
    });
    const ids = (JSON.parse(completion.choices[0]?.message?.content ?? "{}") as { ids?: string[] }).ids ?? [];
    const picked = ids.map((id) => hits.find((h) => h.id === id)).filter((h): h is Hit => !!h);
    return picked.length ? picked : hits.slice(0, 4);
  } catch (e) {
    console.warn("[video-kit] 음악 후보 고르기 실패:", e instanceof Error ? e.message : e);
    return hits.slice(0, 4);
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
export async function findMusic(opts: { service: Service | null; readService?: Service; query: string; intent: string; workDir: string }): Promise<MusicToUse | null> {
  const words = opts.query.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  // 검색 결과는 낱말을 모두 포함한 것만 나와 긴 검색어는 비기 쉽다. 없으면 낱말을 줄여 다시 찾는다
  const tries = [...new Set([words.join(" "), words.slice(-2).join(" "), words.slice(0, 2).join(" ")])];
  for (const query of tries) {
    const found = await findWith({ ...opts, query });
    if (found) return found;
  }
  return null;
}

async function findWith(opts: { service: Service | null; readService?: Service; query: string; intent: string; workDir: string }): Promise<MusicToUse | null> {
  const query = opts.query;
  const read = opts.readService ?? opts.service;
  try {
    const hits = (await search(query)).filter((h) => {
      const sec = (h.duration ?? 0) / 1000;
      return h.license === "cc0" && h.url && sec >= MIN_SECONDS && sec <= MAX_SECONDS && !NOT_MUSIC.test(`${h.title ?? ""} ${tagsOf(h)}`);
    });
    if (!hits.length) return null;
    const { data: known } = read ? await read.from("stock_music").select("track_id, rejected, last_used_at").in("track_id", hits.map((h) => h.id)) : { data: [] };
    const cutoff = Date.now() - REPEAT_DAYS * 86_400_000;
    const blocked = new Set((known ?? []).filter((k) => k.rejected || (k.last_used_at && Date.parse(k.last_used_at) > cutoff)).map((k) => k.track_id));
    const ranked = await rank(hits.filter((h) => !blocked.has(h.id)), opts.intent || query);
    for (const [i, h] of ranked.entries()) {
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
    return null;
  } catch (e) {
    console.warn("[video-kit] 음악 검색 실패:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** 다시 편집: 처음 고른 곡을 그대로 쓴다. 받지 못하면 null. */
export async function reloadMusic(picked: PickedMusic, workDir: string): Promise<MusicToUse | null> {
  if (!picked.source?.url) return null;
  try {
    const res = await fetch(picked.source.url, { headers: { "User-Agent": "MCB-Video/1.0" } });
    if (!res.ok) return null;
    const file = join(workDir, "music-reuse");
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
