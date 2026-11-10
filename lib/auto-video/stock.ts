import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentModel } from "@/lib/agents/runner";
import { getOpenAI } from "@/lib/openai";
import { callOptions } from "@/lib/products/analysis/analyze";
import { warnIfError } from "@/lib/supabase/result";
import type { createServiceClient } from "@/lib/supabase/service";
import { ffmpeg, imageDataUrl } from "@/lib/shoot/video-kit/tools";
import type { Json } from "@/types/database";

// Pixabay 스톡 — Pexels는 2026-11 현재 신규 API 키 발급이 중단됐다.
// API 문서 조건: 요청은 24시간 저장해 다시 쓴다, 자동 요청을 많이 보내지 않는다, 대량 내려받기 금지.
// 약관: 알아볼 수 있는 인물 · 로고 · 브랜드는 상업 사용에 별도 동의가 필요할 수 있어 코드가 탈락시킨다.
// 그래서 검색 결과와 검수 결과를 DB(stock_searches · stock_videos, 0046)에 두고 재사용한다. 컷당 후보 3개만 받는다.

type Service = ReturnType<typeof createServiceClient>;

const DAY_MS = 86_400_000;
const CANDIDATES = 3;

type Rendition = { url: string; width: number; height: number; size: number };
interface Hit {
  id: number;
  pageURL: string;
  user: string;
  tags?: string;
  duration?: number;
  videos: Record<"large" | "medium" | "small" | "tiny", Rendition>;
}

export interface StockPick {
  file: string;
  shot: string;
  source: { provider: "Pixabay"; videoId: number; pageURL: string; user: string; tags: string; query: string };
  tokens: { input: number; output: number };
}

async function search(service: Service, query: string): Promise<Hit[]> {
  const key = query.trim().toLowerCase();
  const { data: cached } = await service.from("stock_searches").select("hits, fetched_at").eq("query", key).maybeSingle();
  if (cached && Date.now() - Date.parse(cached.fetched_at) < DAY_MS) return cached.hits as unknown as Hit[];
  const apiKey = process.env.PIXABAY_API_KEY;
  if (!apiKey) throw new Error("PIXABAY_API_KEY가 없어요");
  const q = new URLSearchParams({ key: apiKey, q: key, video_type: "film", safesearch: "true", min_height: "720", per_page: "8", order: "popular" });
  const res = await fetch(`https://pixabay.com/api/videos/?${q}`, { headers: { "User-Agent": "MCB-Video/1.0" } });
  if (!res.ok) throw new Error(`Pixabay ${res.status}`);
  const hits = ((await res.json()) as { hits: Hit[] }).hits ?? [];
  warnIfError(await service.from("stock_searches").upsert({ query: key, hits: hits as unknown as Json, fetched_at: new Date().toISOString() }), `스톡 검색 결과 저장 (query=${key})`);
  return hits;
}

async function download(url: string, file: string): Promise<void> {
  const res = await fetch(url, { headers: { "User-Agent": "MCB-Video/1.0" } });
  if (!res.ok) throw new Error(`스톡 내려받기 ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

interface Verdict {
  fits: boolean;
  real: boolean;
  logo: boolean;
  person: boolean;
  text: boolean;
  reason: string;
}

/** 후보를 프레임 묶음으로 보여 준다. 저장된 판단(문제 있음)은 다시 묻지 않는다. 의도 적합은 컷마다 다시 본다. */
async function vet(hits: Hit[], intent: string, workDir: string): Promise<{ verdicts: Verdict[]; tokens: { input: number; output: number } }> {
  const images: string[] = [];
  for (const h of hits) {
    const tiny = join(workDir, `${h.id}-tiny.mp4`);
    await download(h.videos.tiny.url, tiny);
    const sheet = join(workDir, `${h.id}-sheet.jpg`);
    const step = Math.max(0.5, (h.duration ?? 12) / 6);
    ffmpeg(["-y", "-v", "error", "-i", tiny, "-an", "-vf", `fps=1/${step.toFixed(3)},scale=256:-2,tile=6x1`, "-frames:v", "1", "-q:v", "4", sheet]);
    images.push(imageDataUrl(sheet));
  }
  const prompt = `인스타 릴스 광고에 넣을 분위기 영상 후보 ${hits.length}개를 검수한다. 후보마다 이미지 한 장에 프레임 6개가 가로로 있다.
컷 의도: ${intent}
후보마다 판단한다(순서대로):
- fits: 컷 의도와 맞는가
- real: 실제로 촬영한 영상인가. 그림, 3D, 애니메이션, AI 생성처럼 보이면 false
- logo: 브랜드 로고, 상표, 알아볼 수 있는 상품 포장이 보이는가
- person: 사람 얼굴이 한 프레임이라도 보이는가. 손 · 팔 · 뒷모습 · 얼굴이 화면 밖인 사람만 나오면 false
- text: 자막, 워터마크, 글자가 보이는가
- reason: 한국어 한 문장
애매하면 logo, person, text를 true로 답한다. 영상은 세로로 가운데를 잘라 쓴다.
JSON만 답한다: {"candidates":[{"fits":true,"real":true,"logo":false,"person":false,"text":false,"reason":""}]}`;
  const model = agentModel();
  const completion = await getOpenAI().chat.completions.create({
    model,
    ...callOptions(model, 900),
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...images.map((url) => ({ type: "image_url" as const, image_url: { url, detail: "high" as const } }))] }],
  });
  const parsed = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as { candidates?: Verdict[] };
  return { verdicts: parsed.candidates ?? [], tokens: { input: completion.usage?.prompt_tokens ?? 0, output: completion.usage?.completion_tokens ?? 0 } };
}

/** 검색 → 후보 검수 → 세로로 잘라 8초 컷. 통과 후보가 없으면 null(호출하는 쪽이 다른 소재를 쓴다). */
export async function stockClip(service: Service, query: string, intent: string, workDir: string, name: string, used: Set<number>): Promise<StockPick | null> {
  const all = await search(service, query);
  const { data: rejected } = await service.from("stock_videos").select("video_id").eq("provider", "pixabay").eq("rejected", true).in("video_id", all.map((h) => h.id));
  const bad = new Set((rejected ?? []).map((r) => r.video_id));
  const hits = all.filter((h) => !bad.has(h.id) && !used.has(h.id) && !/ai[ -]?generated/i.test(h.tags ?? "")).slice(0, CANDIDATES);
  if (!hits.length) return null;
  const { verdicts, tokens } = await vet(hits, intent, workDir);
  // 로고 · 사람 · 글자 · 실사가 아닌 영상은 어느 컷에서도 쓰지 않으니 저장해 다음부터 묻지 않는다
  const rows = hits
    .map((h, i) => ({ h, v: verdicts[i] }))
    .filter((x) => x.v && (x.v.logo || x.v.person || x.v.text || !x.v.real))
    .map((x) => ({ provider: "pixabay", video_id: x.h.id, rejected: true, reason: (x.v.reason ?? "").slice(0, 300), page_url: x.h.pageURL }));
  if (rows.length) warnIfError(await service.from("stock_videos").upsert(rows), `스톡 탈락 후보 저장 (query=${query})`);
  const idx = hits.findIndex((_, i) => {
    const v = verdicts[i];
    return v && v.fits && v.real && !v.logo && !v.person && !v.text;
  });
  if (idx < 0) return null;
  const hit = hits[idx];
  const best = hit.videos.large?.url && hit.videos.large.size < 150_000_000 ? hit.videos.large : hit.videos.medium;
  const raw = join(workDir, `${hit.id}-full.mp4`);
  await download(best.url, raw);
  const file = join(workDir, `${name}.mp4`);
  ffmpeg(["-y", "-v", "error", "-i", raw, "-t", "8", "-an", "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "18", "-preset", "fast", file]);
  used.add(hit.id);
  return {
    file,
    shot: `${intent} (무료 스톡 분위기 영상, 상품 아님)`,
    source: { provider: "Pixabay", videoId: hit.id, pageURL: hit.pageURL, user: hit.user, tags: hit.tags ?? "", query },
    tokens,
  };
}
