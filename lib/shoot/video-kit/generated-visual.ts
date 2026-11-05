import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { MAX_VISUALS, VISUAL_KINDS, type EditPlan, type EditVisual } from "@/lib/agents/edit-plan";
import type { ProductFacts } from "@/lib/agents/product-facts";
import { agentModel } from "@/lib/agents/runner";
import { getOpenAI, OPENAI_IMAGE_MODEL } from "@/lib/openai";
import { callOptions } from "@/lib/products/analysis/analyze";
import { probe } from "@/lib/shoot/ffmpeg";
import type { KitClip } from "@/lib/shoot/video-kit/pipeline";
import { ffmpeg, imageDataUrl } from "@/lib/shoot/video-kit/tools";
import { runVisionTool } from "@/lib/shoot/video-kit/vision-tools";
import type { createServiceClient } from "@/lib/supabase/service";

// AI 이미지 컷 — 성분 · 원료 · 원리를 설명할 실제 화면이 없는 비트에 OpenAI 이미지와 코드 움직임을 넣는다(2026-11-05 사용자 결정).
// 원래 컷을 계획에 그대로 두고 렌더할 때만 바꾼다. 그림을 못 만들면 원래 컷으로 나가고, 다시 편집은 저장한 그림을 쓴다.
// 그림은 key로 라이브러리(generated_visuals, 0050)에 저장해 다시 쓴다. 같은 그림은 돈을 한 번만 낸다.

type Service = ReturnType<typeof createServiceClient>;

const BUCKET = "generated-visuals";
const IMAGE_SIZE = "1088x1920";
const IMAGE_QUALITY = "medium";
// 공식 단가(100만 토큰당 달러, 2026-11-05 확인). 기록용 어림값이다
const PRICE = { text: 5, image: 30 };
const MIN_SECONDS = 2;
const MAX_SECONDS = 6;
// 그림 내용은 AI가 정하고, 넣지 말아야 할 것은 코드가 항상 붙인다
const FIXED_PROMPT =
  " Vertical 9:16 macro photograph, photorealistic, soft studio light, shallow depth of field, clean premium mood. Leave calm empty space in the upper third. Absolutely no text, letters, numbers, logos, labels, packaging, bottles, jars, people, faces, hands, body parts or skin.";

export interface UsedVisual {
  key: string;
  subject: string;
  beat: number;
  reused: boolean;
  costUsd: number;
}

export async function loadVisualLibrary(db: Service | null | undefined): Promise<{ key: string; subject: string }[]> {
  if (!db) return [];
  const { data, error } = await db.from("generated_visuals").select("key, subject").order("created_at", { ascending: false }).limit(200);
  if (error) {
    console.warn(`[video-kit] AI 이미지 목록을 읽지 못함: ${error.message}`);
    return [];
  }
  return data ?? [];
}

const squash = (t: string) => t.replace(/[\s.,!?~·…'"()[\]]+/g, "");

/** 계획의 그림 가운데 코드 규칙을 지키는 것만 고른다. 근거 문구가 상품 자료에 없으면 쓰지 않는다. */
export function usableVisuals(plan: EditPlan, facts: ProductFacts): EditVisual[] {
  if (!VISUAL_KINDS.includes(facts.kind)) return [];
  const source = squash([facts.sourceText, facts.oneLine ?? "", ...facts.claims.flatMap((c) => [c.claim, c.quote])].join(" "));
  const last = plan.beats.length - 1;
  const chosen: EditVisual[] = [];
  for (const v of plan.visuals ?? []) {
    const beat = plan.beats[v.beat];
    const why =
      !beat || v.beat <= 0 || v.beat >= last ? "첫 · 마지막 비트"
      : beat.mode !== "tts" ? "사람이 말하는 비트"
      : !v.prompt.trim() ? "그림 설명 없음"
      : squash(v.evidence).length < 2 || !source.includes(squash(v.evidence)) ? `근거 문구가 상품 자료에 없음("${v.evidence}")`
      : chosen.some((c) => Math.abs(c.beat - v.beat) < 2) ? "연달아 넣음"
      : chosen.length >= MAX_VISUALS ? `영상당 ${MAX_VISUALS}개 초과`
      : null;
    if (why) console.log(`[video-kit] AI 이미지 제외(${v.subject}): ${why}`);
    else chosen.push(v);
  }
  return chosen;
}

function cleanKey(v: EditVisual, beat: number): string {
  const key = v.key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return key || `visual-${beat}`;
}

const reviewSchema = z.object({
  problems: z.array(z.string()).describe("실제로 보이는 문제. 없으면 빈 배열"),
});

/** 만든 그림을 저장 · 사용하기 전에 본다. 글자가 망가지거나 상품처럼 보이는 그림을 막는다. */
async function reviewImage(file: string, v: EditVisual, workDir: string): Promise<{ problems: string[]; tokens: { input: number; output: number } }> {
  const small = join(workDir, "review.jpg");
  ffmpeg(["-y", "-v", "error", "-i", file, "-vf", "scale=540:-2", "-q:v", "3", small]);
  const model = agentModel();
  const completion = await getOpenAI().chat.completions.parse({
    model,
    ...callOptions(model, 800),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `릴스 중간에 넣을 그림이다. 보여 주려는 것: ${v.subject}\n실제로 보이는 문제만 적는다: 글자 · 숫자 · 로고, 사람 · 손 · 피부 · 몸, 용기 · 포장, 크림 · 세럼처럼 실제 상품 제형으로 오해할 질감, 보여 주려는 것과 다른 그림.` },
          { type: "image_url", image_url: { url: imageDataUrl(small), detail: "high" } },
        ],
      },
    ],
    response_format: zodResponseFormat(reviewSchema, "visual_review"),
  });
  return {
    problems: completion.choices[0]?.message?.parsed?.problems ?? [],
    tokens: { input: completion.usage?.prompt_tokens ?? 0, output: completion.usage?.completion_tokens ?? 0 },
  };
}

async function savedImage(db: Service | null, key: string, file: string): Promise<boolean> {
  if (!db) return false;
  const { data: row } = await db.from("generated_visuals").select("path, use_count").eq("key", key).maybeSingle();
  if (!row) return false;
  const { data, error } = await db.storage.from(BUCKET).download(row.path);
  if (error || !data) {
    console.warn(`[video-kit] 저장한 AI 이미지를 받지 못함(${key}): ${error?.message ?? "빈 응답"}`);
    return false;
  }
  writeFileSync(file, Buffer.from(await data.arrayBuffer()));
  return true;
}

export async function buildVisualClips(input: {
  plan: EditPlan;
  clips: KitClip[];
  // 비트마다 말 길이(초). 컷 길이를 말에 맞춘다
  lengths: number[];
  facts: ProductFacts;
  // 시험(dry-run)은 service가 null이라 저장하지 않는다
  service: Service | null;
  readService?: Service;
  workDir: string;
}): Promise<{ plan: EditPlan; clips: KitClip[]; used: UsedVisual[]; realClipOf: Map<number, number>; warnings: string[]; tokens: { input: number; output: number } }> {
  const { plan, service } = input;
  const used: UsedVisual[] = [];
  const realClipOf = new Map<number, number>();
  const warnings: string[] = [];
  const tokens = { input: 0, output: 0 };
  const chosen = process.env.OPENAI_API_KEY ? usableVisuals(plan, input.facts) : [];
  if (!chosen.length) return { plan, clips: input.clips, used, realClipOf, warnings, tokens };

  const dir = join(input.workDir, "visuals");
  mkdirSync(dir, { recursive: true });
  const db = service ?? input.readService ?? null;
  const beats = [...plan.beats];
  const clips = [...input.clips];
  let no = Math.max(0, ...clips.map((c) => c.no)) + 1;
  for (const v of chosen) {
    const key = cleanKey(v, v.beat);
    try {
      const file = join(dir, `${key}.png`);
      const reused = await savedImage(db, key, file);
      let costUsd = 0;
      if (!reused) {
        const res = await getOpenAI().images.generate({ model: OPENAI_IMAGE_MODEL, prompt: v.prompt.trim() + FIXED_PROMPT, size: IMAGE_SIZE as "1024x1536", quality: IMAGE_QUALITY, n: 1 });
        const b64 = res.data?.[0]?.b64_json;
        if (!b64) throw new Error("이미지 응답이 비어 있음");
        writeFileSync(file, Buffer.from(b64, "base64"));
        costUsd = ((res.usage?.input_tokens ?? 0) * PRICE.text + (res.usage?.output_tokens ?? 0) * PRICE.image) / 1_000_000;
        const review = await reviewImage(file, v, dir);
        tokens.input += review.tokens.input;
        tokens.output += review.tokens.output;
        if (review.problems.length) throw new Error(`그림 점검: ${review.problems.join(" / ")}`);
        if (service) {
          const path = `${key}.png`;
          const { error: upErr } = await service.storage.from(BUCKET).upload(path, Buffer.from(b64, "base64"), { contentType: "image/png", upsert: true });
          if (upErr) throw new Error(`이미지 저장 실패: ${upErr.message}`);
          const { error: rowErr } = await service.from("generated_visuals").upsert(
            { key, subject: v.subject, prompt: v.prompt, model: OPENAI_IMAGE_MODEL, quality: IMAGE_QUALITY, path, input_tokens: res.usage?.input_tokens ?? 0, output_tokens: res.usage?.output_tokens ?? 0, cost_usd: Number(costUsd.toFixed(5)) },
            { onConflict: "key" },
          );
          if (rowErr) console.warn(`[video-kit] AI 이미지 기록 실패(${key}): ${rowErr.message}`);
        }
      }
      const seconds = Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, (input.lengths[v.beat] ?? 3) + 0.4));
      const clipFile = join(dir, `${key}-${v.beat}.mp4`);
      const made = runVisionTool<{ seconds: number }>("image_motion.py", [file, clipFile, seconds.toFixed(2), v.motion, String(1000 + v.beat)]);
      if (!made) throw new Error("움직임을 넣지 못함");
      const info = probe(clipFile);
      clips.push({ no, file: clipFile, duration: info.duration, hasAudio: false, hdrTransfer: null, shot: `[AI 이미지] ${v.subject}` });
      realClipOf.set(no, plan.beats[v.beat].cuts[0].clip);
      beats[v.beat] = { ...beats[v.beat], cuts: [{ clip: no, in: 0, out: info.duration, what: `[AI 이미지] ${v.subject}` }] };
      used.push({ key, subject: v.subject, beat: v.beat, reused, costUsd });
      console.log(`[video-kit] AI 이미지 ${v.beat}번 비트: ${v.subject} (${key}, ${reused ? "저장한 그림" : `새로 생성 $${costUsd.toFixed(4)}`})`);
      no++;
    } catch (e) {
      // 그림이 없어도 영상은 원래 컷으로 만든다
      warnings.push(`AI 이미지를 쓰지 못해 원래 컷으로 만들었어요. (${v.subject}: ${e instanceof Error ? e.message : e})`.slice(0, 300));
    }
  }
  if (used.length && service) {
    const { data: rows } = await service.from("generated_visuals").select("key, use_count").in("key", used.map((u) => u.key));
    for (const r of rows ?? []) await service.from("generated_visuals").update({ use_count: r.use_count + 1, last_used_at: new Date().toISOString() }).eq("key", r.key);
  }
  return { plan: { ...plan, beats }, clips, used, realClipOf, warnings, tokens };
}
