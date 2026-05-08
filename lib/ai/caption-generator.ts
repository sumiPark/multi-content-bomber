import "server-only";
import { z } from "zod";
import { openai } from "@/lib/openai";

// Schema (zod) for validating both AI responses AND existing DB rows.
// New fields are optional so older `contents.ai_captions` rows still parse.
export const captionsSchema = z.object({
  youtube: z.object({
    title: z.string(),
    description: z.string(),
    hashtags: z.array(z.string()),
    category: z.string().optional(),
  }),
  instagram: z.object({
    caption: z.string(),
    hashtags: z.array(z.string()),
    cover_text: z.string().optional(),
  }),
  tiktok: z.object({
    hook: z.string(),
    caption: z.string(),
    hashtags: z.array(z.string()),
    sound_recommendation: z.string().optional(),
  }),
});

export type Captions = z.infer<typeof captionsSchema>;

const SYSTEM_PROMPT = `당신은 멀티 채널 소셜 미디어 캡션 전문가입니다. 입력된 이미지를 분석해 YouTube Shorts, Instagram, TikTok 세 플랫폼에 최적화된 한국어 캡션을 JSON으로 출력합니다.

여러 장이면 이미지들 사이의 흐름과 관계를 파악해 일관된 스토리텔링 톤으로 작성하고, 단일 이미지면 핵심 피사체와 분위기를 살립니다.

플랫폼별 가이드:

YouTube Shorts
- title: 100자 이내, SEO 키워드 포함
- description: 5000자 이내, 타임스탬프와 CTA(구독/좋아요 유도) 포함
- hashtags: 최대 30개, 관련성 높은 순 (# 포함, #Shorts 권장)
- category: 영상 카테고리 1개 (예: "교육", "엔터테인먼트", "라이프스타일", "뷰티/패션", "테크")

Instagram
- caption: 2200자 이내 스토리텔링 형식, 이모지 자연스럽게 활용. 멀티 이미지면 "→ 마지막까지 확인" 같은 캐러셀 유도 멘트 포함.
- hashtags: 최대 30개, 트렌드 + 니치 태그 (# 포함)
- cover_text: 릴스 커버에 들어갈 짧은 문구(20자 이내). 이미지 게시물이면 빈 문자열로 응답.

TikTok
- hook: 첫 3초를 사로잡는 짧은 한 줄(질문/충격/호기심)
- caption: 본문. hook과 caption을 합쳐 300자 이내로 유지.
- hashtags: 최대 5개, 바이럴 트렌드 중심 (# 포함)
- sound_recommendation: 어울리는 사운드/음악 분위기 추천(예: "활기찬 K-pop 비트", "잔잔한 어쿠스틱"). 추천 어려우면 "트렌드 사운드 활용 추천"으로 응답.

해시태그는 모두 '#' 포함 문자열 배열로 반환합니다. 사용자가 추가 설명이나 캡션 스타일 가이드를 제공하면 그 맥락을 우선 반영해 캡션을 생성하세요. 출력은 반드시 주어진 JSON 스키마를 정확히 따릅니다.`;

const RESPONSE_SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  required: ["youtube", "instagram", "tiktok"],
  properties: {
    youtube: {
      type: "object" as const,
      additionalProperties: false,
      required: ["title", "description", "hashtags", "category"],
      properties: {
        title: { type: "string" as const },
        description: { type: "string" as const },
        hashtags: { type: "array" as const, items: { type: "string" as const } },
        category: { type: "string" as const },
      },
    },
    instagram: {
      type: "object" as const,
      additionalProperties: false,
      required: ["caption", "hashtags", "cover_text"],
      properties: {
        caption: { type: "string" as const },
        hashtags: { type: "array" as const, items: { type: "string" as const } },
        cover_text: { type: "string" as const },
      },
    },
    tiktok: {
      type: "object" as const,
      additionalProperties: false,
      required: ["hook", "caption", "hashtags", "sound_recommendation"],
      properties: {
        hook: { type: "string" as const },
        caption: { type: "string" as const },
        hashtags: { type: "array" as const, items: { type: "string" as const } },
        sound_recommendation: { type: "string" as const },
      },
    },
  },
};

interface GenerateCaptionsOptions {
  description?: string;
  presetInstructions?: string;
}

export async function generateCaptions(
  imageDataUrls: string[],
  options: GenerateCaptionsOptions = {},
): Promise<Captions> {
  if (imageDataUrls.length === 0) throw new Error("이미지가 없습니다.");
  if (imageDataUrls.length > 10)
    throw new Error("최대 10장까지 분석할 수 있습니다.");

  const baseInstruction =
    imageDataUrls.length > 1
      ? "이 이미지들의 흐름과 관계를 분석해 위 형식으로 캡션을 생성해주세요."
      : "이 이미지를 분석해 위 형식으로 캡션을 생성해주세요.";

  const description = options.description?.trim();
  const presetInstructions = options.presetInstructions?.trim();
  const userText = [
    presetInstructions ? `[캡션 스타일 가이드]\n${presetInstructions}` : null,
    description ? `[사용자 입력 기본 설명]\n${description}` : null,
    baseInstruction,
  ]
    .filter(Boolean)
    .join("\n\n");

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          ...imageDataUrls.map((url) => ({
            type: "image_url" as const,
            image_url: { url, detail: "low" as const },
          })),
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "captions",
        strict: true,
        schema: RESPONSE_SCHEMA,
      },
    },
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("OpenAI 응답이 비어있습니다.");

  return captionsSchema.parse(JSON.parse(content));
}
