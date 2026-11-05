import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentModel } from "@/lib/agents/runner";
import { getOpenAI } from "@/lib/openai";
import { callOptions } from "@/lib/products/analysis/analyze";
import { DEFAULT_EDIT_STYLE } from "@/lib/shoot/edit-style";
import { probe, probeFrameSize, renderSegment } from "@/lib/shoot/ffmpeg";
import { ffmpeg, imageDataUrl } from "@/lib/shoot/video-kit/tools";
import { runVisionTool } from "@/lib/shoot/video-kit/vision-tools";
import type { createServiceClient } from "@/lib/supabase/service";

// 자사 촬영 아카이브(2026-11-05 사용자 결정) — "올렸어요"를 누른 촬영본에서 사람이 안 나오고 품질이 좋은 제품 컷만 남겨 AI 자동 영상에 다시 쓴다.
// 사람 판단은 AI가 두 번, 코드(얼굴 검출)가 한 번 본다. 하나라도 걸리거나 도구가 실패하면 남기지 않는다. 손 · 팔도 사람으로 본다.
// 소리는 남기지 않고, 원본 삭제 기간은 그대로다.

type Service = ReturnType<typeof createServiceClient>;
type Tokens = { input: number; output: number };

const BUCKET = "media";
const LEAD_SKIP = 0.3;
const MIN_SECONDS = 3;
const MAX_SECONDS = 8;
const MIN_QUALITY = 4;
const MAX_PER_PRODUCT = 12;
const OFFER_COUNT = 6;
const REUSE_DAYS = 14;
const DAY_MS = 86_400_000;

async function askVision<T>(prompt: string, images: string[], maxTokens: number): Promise<{ answer: T; tokens: Tokens }> {
  const model = agentModel();
  const completion = await getOpenAI().chat.completions.create({
    model,
    ...callOptions(model, maxTokens),
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...images.map((url) => ({ type: "image_url" as const, image_url: { url, detail: "high" as const } }))] }],
  });
  return {
    answer: JSON.parse(completion.choices[0]?.message?.content ?? "{}") as T,
    tokens: { input: completion.usage?.prompt_tokens ?? 0, output: completion.usage?.completion_tokens ?? 0 },
  };
}

/** 촬영본을 프레임 묶음 한 장으로 만든다. step초마다 한 프레임. */
function frameSheet(file: string, start: number, seconds: number, step: number, out: string): void {
  ffmpeg(["-y", "-v", "error", "-ss", start.toFixed(3), "-t", seconds.toFixed(3), "-i", file, "-an", "-vf", `fps=1/${step.toFixed(3)},scale=320:-2,tile=6x3`, "-frames:v", "1", "-q:v", "4", out]);
}

interface Segment {
  start: number;
  end: number;
  product: boolean;
  person: boolean;
  other_brand: boolean;
  text: boolean;
  stable: boolean;
  quality: number;
  what: string;
}

export interface ArchiveCandidate {
  start: number;
  seconds: number;
  quality: number;
  what: string;
}

/** 1차 — 촬영본에서 남길 구간을 고른다. 세로 영상이 아니면 잘려서 제품이 빠질 수 있어 고르지 않는다. */
export async function findArchiveCut(file: string, info: { productName: string; shot: string }, workDir: string, name: string): Promise<{ cut: ArchiveCandidate | null; tokens: Tokens }> {
  const none = { input: 0, output: 0 };
  const { duration } = probe(file);
  const usable = duration - LEAD_SKIP;
  if (usable < MIN_SECONDS) return { cut: null, tokens: none };
  const first = join(workDir, `${name}-first.jpg`);
  ffmpeg(["-y", "-v", "error", "-ss", LEAD_SKIP.toFixed(3), "-i", file, "-frames:v", "1", "-q:v", "4", first]);
  const size = probeFrameSize(first);
  if (size.height <= size.width) return { cut: null, tokens: none };
  const step = Math.max(1, usable / 18);
  const sheet = join(workDir, `${name}-sheet.jpg`);
  frameSheet(file, LEAD_SKIP, usable, step, sheet);
  const prompt = `쇼핑몰 직접 촬영본에서 다른 릴스에 다시 쓸 제품 컷을 고른다. 상품: "${info.productName}". 촬영 의도: ${info.shot || "없음"}
그림에 프레임이 왼쪽에서 오른쪽, 위에서 아래 순서로 있다. k번째 프레임의 시각은 ${LEAD_SKIP} + (k-1) x ${step.toFixed(2)}초다. 검은 칸은 없는 프레임이다.
이어지는 구간을 나누어 판단한다(시각은 원본 기준 초):
- product: 이 상품이 또렷이 보이는가
- person: 사람의 얼굴이나 몸 일부(손, 팔, 다리 포함)가 보이는가. 거울 · 유리 · 화면에 비친 모습도 포함한다
- other_brand: 이 상품이 아닌 브랜드 로고나 상표가 보이는가
- text: 자막 · 워터마크 · 메모처럼 제품 인쇄가 아닌 글자가 보이는가
- stable: 심하게 흔들리지 않는가
- quality: 초점 · 밝기 · 구도를 합쳐 1~5점
- what: 보이는 장면을 한국어 한 문장으로, 효과나 사용 결과를 말하지 않는다
애매하면 person, other_brand, text를 true로 답한다.
JSON만 답한다: {"segments":[{"start":0,"end":0,"product":true,"person":false,"other_brand":false,"text":false,"stable":true,"quality":1,"what":""}]}`;
  const { answer, tokens } = await askVision<{ segments?: Segment[] }>(prompt, [imageDataUrl(sheet)], 900);
  const fits = (answer.segments ?? [])
    .filter((s) => s.product && !s.person && !s.other_brand && !s.text && s.stable && s.quality >= MIN_QUALITY)
    .map((s) => {
      const start = Math.max(LEAD_SKIP, s.start);
      return { start, seconds: Math.min(MAX_SECONDS, Math.min(s.end, duration) - start), quality: s.quality, what: s.what.trim() };
    })
    .filter((s) => s.seconds >= MIN_SECONDS && s.what)
    .sort((a, b) => b.quality - a.quality || b.seconds - a.seconds);
  return { cut: fits[0] ?? null, tokens };
}

/** 2차 — 컷을 세로 규격으로 만들고 촘촘한 프레임으로 다시 본다. 통과 못 하면 file이 null이다. */
export async function verifyArchiveCut(input: string, cut: ArchiveCandidate, workDir: string, name: string): Promise<{ file: string | null; reason: string; tokens: Tokens }> {
  const none = { input: 0, output: 0 };
  const { hdrTransfer } = probe(input);
  const withSilence = join(workDir, `${name}-raw.mp4`);
  renderSegment({ input, start: cut.start, duration: cut.seconds, hasAudio: false, onScreen: "", subtitles: [], hdrTransfer, style: DEFAULT_EDIT_STYLE }, withSilence, workDir, name);
  const file = join(workDir, `${name}.mp4`);
  ffmpeg(["-y", "-v", "error", "-i", withSilence, "-an", "-c:v", "copy", "-movflags", "+faststart", file]);

  const dir = join(workDir, `${name}-frames`);
  mkdirSync(dir, { recursive: true });
  const step = Math.max(0.5, cut.seconds / 16);
  ffmpeg(["-y", "-v", "error", "-i", file, "-vf", `fps=1/${step.toFixed(3)}`, "-q:v", "3", join(dir, "f%02d.jpg")]);
  const frames = Array.from({ length: Math.max(1, Math.floor(cut.seconds / step)) }, (_, i) => join(dir, `f${String(i + 1).padStart(2, "0")}.jpg`));
  const list = join(workDir, `${name}-frames.json`);
  writeFileSync(list, JSON.stringify(frames));
  const faces = runVisionTool<number[]>("faces.py", [list]);
  if (!faces) return { file: null, reason: "얼굴 검출 도구 실패", tokens: none };
  if (faces.some((n) => n > 0)) return { file: null, reason: "얼굴로 보이는 부분이 있음", tokens: none };

  const sheet = join(workDir, `${name}-check.jpg`);
  frameSheet(file, 0, cut.seconds, step, sheet);
  const prompt = `제품 영상을 다른 광고에 다시 쓰기 전 마지막 점검이다. 프레임을 모두 본다. 한 프레임이라도 해당하면 true로 답한다.
- person: 사람의 얼굴이나 몸 일부(손, 팔, 손가락, 다리 포함), 거울 · 유리 · 화면에 비친 사람
- other_brand: 이 상품이 아닌 브랜드 로고나 상표
- text: 자막 · 워터마크 · 메모처럼 제품 인쇄가 아닌 글자
애매하면 true로 답한다. JSON만 답한다: {"person":false,"other_brand":false,"text":false,"reason":""}`;
  const { answer, tokens } = await askVision<{ person?: boolean; other_brand?: boolean; text?: boolean; reason?: string }>(prompt, [imageDataUrl(sheet)], 300);
  // 값이 빠진 답은 통과로 치지 않는다
  if (answer.person !== false || answer.other_brand !== false || answer.text !== false) return { file: null, reason: answer.reason?.trim() || "2차 점검에서 제외", tokens };
  return { file, reason: "", tokens };
}

/** 완성한 컷을 저장한다. 상품당 개수를 넘으면 오래된 컷부터 지운다. */
export async function saveArchiveCut(
  service: Service,
  row: { organizationId: string; productId: string; shootRequestId: string; sourcePath: string; start: number; seconds: number; what: string },
  file: string,
): Promise<void> {
  const path = `archive/${row.organizationId}/${row.productId}/${randomUUID()}.mp4`;
  const { error: upErr } = await service.storage.from(BUCKET).upload(path, readFileSync(file), { contentType: "video/mp4" });
  if (upErr) throw new Error(`아카이브 저장 실패: ${upErr.message}`);
  const { error } = await service.from("shoot_archive_clips").insert({
    organization_id: row.organizationId,
    product_id: row.productId,
    shoot_request_id: row.shootRequestId,
    source_path: row.sourcePath,
    source_start: row.start,
    seconds: row.seconds,
    what: row.what,
    path,
  });
  if (error) {
    await service.storage.from(BUCKET).remove([path]);
    // 같은 구간을 이미 남겼으면 실패가 아니다
    if (error.code === "23505") return;
    throw new Error(`아카이브 기록 실패: ${error.message}`);
  }
  const { data: all } = await service
    .from("shoot_archive_clips")
    .select("id, path")
    .eq("organization_id", row.organizationId)
    .eq("product_id", row.productId)
    .order("created_at", { ascending: false });
  const old = (all ?? []).slice(MAX_PER_PRODUCT);
  if (old.length) {
    await service.storage.from(BUCKET).remove(old.map((o) => o.path));
    await service.from("shoot_archive_clips").delete().in("id", old.map((o) => o.id));
  }
}

export interface ArchiveChoice {
  id: string;
  rowId: string;
  file: string;
  sheet: string;
  what: string;
  seconds: number;
}

/** 소재 에이전트에게 보여 줄 컷. 같은 컷이 며칠 사이 반복되지 않게 최근에 쓴 컷은 뺀다. 저장 전이거나 받기에 실패하면 빈 목록이다. */
export async function loadArchiveChoices(service: Service, organizationId: string, productId: string, workDir: string): Promise<ArchiveChoice[]> {
  const since = new Date(Date.now() - REUSE_DAYS * DAY_MS).toISOString();
  const { data, error } = await service
    .from("shoot_archive_clips")
    .select("id, path, what, seconds")
    .eq("organization_id", organizationId)
    .eq("product_id", productId)
    .or(`last_used_at.is.null,last_used_at.lt.${since}`)
    .order("use_count", { ascending: true })
    .order("created_at", { ascending: false })
    .limit(OFFER_COUNT);
  if (error) {
    console.warn(`  아카이브 조회 실패: ${error.message}`);
    return [];
  }
  const dir = join(workDir, "archive");
  mkdirSync(dir, { recursive: true });
  const out: ArchiveChoice[] = [];
  for (const row of data ?? []) {
    try {
      const { data: blob, error: dlErr } = await service.storage.from(BUCKET).download(row.path);
      if (dlErr || !blob) throw new Error(dlErr?.message ?? "빈 파일");
      const id = `a${out.length + 1}`;
      const file = join(dir, `${id}.mp4`);
      writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
      const seconds = Number(row.seconds);
      const sheet = join(dir, `${id}.jpg`);
      ffmpeg(["-y", "-v", "error", "-i", file, "-vf", `fps=3/${seconds.toFixed(3)},scale=256:-2,tile=3x1`, "-frames:v", "1", "-q:v", "4", sheet]);
      out.push({ id, rowId: row.id, file, sheet, what: row.what, seconds });
    } catch (e) {
      console.warn(`  아카이브 컷 받기 실패(${e instanceof Error ? e.message : e})`);
    }
  }
  return out;
}

export async function markArchiveUsed(service: Service, rowIds: string[]): Promise<void> {
  if (!rowIds.length) return;
  const { data } = await service.from("shoot_archive_clips").select("id, use_count").in("id", rowIds);
  const at = new Date().toISOString();
  await Promise.all((data ?? []).map((r) => service.from("shoot_archive_clips").update({ use_count: r.use_count + 1, last_used_at: at }).eq("id", r.id)));
}
