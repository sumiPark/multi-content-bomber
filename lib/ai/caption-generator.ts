import "server-only";
import { z } from "zod";
import { getOpenAI } from "@/lib/openai";
import type { Platform } from "@/lib/platforms";
import {
  PLATFORM_PROMPTS,
  REGENERATE_INSTRUCTION,
  SYSTEM_PROMPT,
} from "./prompts";

// Schema. 모든 플랫폼 필드 optional — 사용자가 선택한 플랫폼만 부분 객체로 저장.
export const captionsSchema = z.object({
  youtube: z
    .object({
      title: z.string(),
      description: z.string(),
      hashtags: z.array(z.string()),
      category: z.string().optional(),
    })
    .optional(),
  instagram: z
    .object({
      caption: z.string(),
      hashtags: z.array(z.string()),
      cover_text: z.string().optional(),
    })
    .optional(),
  tiktok: z
    .object({
      caption: z.string(),
      hashtags: z.array(z.string()),
    })
    .optional(),
});

export type Captions = z.infer<typeof captionsSchema>;

// 글자수 / 해시태그 한도. docs/caption-engine.md와 동기화.
const LIMITS = {
  youtube: { title: 100, description: 5000, hashtags: 15 },
  instagram: { caption: 2200, coverText: 50, hashtags: 20 },
  tiktok: { caption: 300, hashtags: 5 },
} as const;

const PLATFORM_KEYS: Record<Platform, "youtube" | "instagram" | "tiktok"> = {
  YOUTUBE: "youtube",
  INSTAGRAM: "instagram",
  TIKTOK: "tiktok",
};

const PROPERTY_DEFS = {
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
    required: ["caption", "hashtags"],
    properties: {
      caption: { type: "string" as const },
      hashtags: { type: "array" as const, items: { type: "string" as const } },
    },
  },
};

function buildSystemPrompt(platforms: Platform[]): string {
  const guides = platforms.map((p) => PLATFORM_PROMPTS[p]).join("\n\n");
  return `${SYSTEM_PROMPT}\n\n[플랫폼별 가이드 — 응답에 포함된 플랫폼만]\n\n${guides}`;
}

function buildResponseSchema(platforms: Platform[]) {
  const properties: Record<
    string,
    (typeof PROPERTY_DEFS)[keyof typeof PROPERTY_DEFS]
  > = {};
  const required: string[] = [];
  for (const p of platforms) {
    const key = PLATFORM_KEYS[p];
    properties[key] = PROPERTY_DEFS[key];
    required.push(key);
  }
  return {
    type: "object" as const,
    additionalProperties: false,
    required,
    properties,
  };
}

const ALL_PLATFORMS: Platform[] = ["YOUTUBE", "INSTAGRAM", "TIKTOK"];

interface GenerateCaptionsOptions {
  description?: string;
  presetInstructions?: string;
  platforms?: Platform[];
  /** 재생성 시 이전 응답을 assistant 메시지로 추가하고 다른 스타일을 요청한다. */
  previousCaptions?: Captions;
}

export async function generateCaptions(
  imageDataUrls: string[],
  options: GenerateCaptionsOptions = {},
): Promise<Captions> {
  if (imageDataUrls.length === 0) throw new Error("이미지가 없습니다.");
  if (imageDataUrls.length > 10)
    throw new Error("최대 10장까지 분석할 수 있습니다.");

  const platforms =
    options.platforms && options.platforms.length > 0
      ? Array.from(new Set(options.platforms))
      : ALL_PLATFORMS;

  const platformLabels = platforms
    .map((p) =>
      p === "YOUTUBE" ? "YouTube Shorts" : p === "INSTAGRAM" ? "Instagram" : "TikTok",
    )
    .join(", ");

  const baseInstruction =
    imageDataUrls.length > 1
      ? "이 이미지들의 흐름과 관계를 분석해 위 형식으로 캡션을 생성해주세요."
      : "이 이미지를 분석해 위 형식으로 캡션을 생성해주세요.";

  const description = options.description?.trim();
  const presetInstructions = options.presetInstructions?.trim();
  const userText = [
    presetInstructions ? `[캡션 스타일 가이드]\n${presetInstructions}` : null,
    description ? `[사용자 입력 기본 설명]\n${description}` : null,
    `[게시 대상 플랫폼]\n${platformLabels}`,
    baseInstruction,
  ]
    .filter(Boolean)
    .join("\n\n");

  const messages: Parameters<
    ReturnType<typeof getOpenAI>["chat"]["completions"]["create"]
  >[0]["messages"] = [
    { role: "system", content: buildSystemPrompt(platforms) },
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
  ];

  if (options.previousCaptions) {
    messages.push({
      role: "assistant",
      content: JSON.stringify(options.previousCaptions),
    });
    messages.push({ role: "user", content: REGENERATE_INSTRUCTION });
  }

  const completion = await getOpenAI().chat.completions.create({
    model: "gpt-4o",
    temperature: options.previousCaptions ? 0.85 : 0.7,
    max_tokens: 4000,
    messages,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "captions",
        strict: true,
        schema: buildResponseSchema(platforms),
      },
    },
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("OpenAI 응답이 비어있습니다.");

  const parsed = captionsSchema.parse(JSON.parse(content));
  return postProcess(parsed);
}

// ─────────────────────────────────────────────────────────────────────────────
// 후처리 검증 — AI가 글자수/포맷을 어겼을 때 안전망. docs/caption-engine.md.
// ─────────────────────────────────────────────────────────────────────────────

function ensureHash(tags: string[]): string[] {
  return tags
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (t.startsWith("#") ? t : `#${t}`));
}

function trimByWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > max * 0.7 ? lastSpace : slice.length;
  return slice.slice(0, cut).trimEnd() + "…";
}

function trimByParagraph(text: string, max: number): string {
  if (text.length <= max) return text;
  const paragraphs = text.split(/\n\n+/);
  const result: string[] = [];
  let length = 0;
  for (const p of paragraphs) {
    if (length + p.length + 2 > max) break;
    result.push(p);
    length += p.length + 2;
  }
  return result.length > 0 ? result.join("\n\n") : trimByWord(text, max);
}

function extractInlineHashtags(text: string): string[] {
  const matches = text.match(/#[^\s#]+/g);
  return matches ?? [];
}

// Instagram 안전망: 해시태그는 hashtags 배열이 단일 출처이고 게시 시 본문 뒤에
// 자동으로 붙는다(lib/platforms/instagram.ts). 모델이 프롬프트를 어기고 본문 끝에
// 해시태그 블록을 넣으면 중복 노출되므로, 본문 말미의 해시태그 묶음을 제거한다.
function stripTrailingHashtags(text: string): string {
  return text.replace(/(?:\s*#[^\s#]+)+\s*$/u, "").trimEnd();
}

function postProcessYoutube(
  c: NonNullable<Captions["youtube"]>,
): NonNullable<Captions["youtube"]> {
  return {
    title: trimByWord(c.title, LIMITS.youtube.title),
    description: trimByParagraph(c.description, LIMITS.youtube.description),
    hashtags: ensureHash(c.hashtags).slice(0, LIMITS.youtube.hashtags),
    category: c.category,
  };
}

function postProcessInstagram(
  c: NonNullable<Captions["instagram"]>,
): NonNullable<Captions["instagram"]> {
  return {
    caption: trimByParagraph(
      stripTrailingHashtags(c.caption),
      LIMITS.instagram.caption,
    ),
    hashtags: ensureHash(c.hashtags).slice(0, LIMITS.instagram.hashtags),
    cover_text: c.cover_text
      ? c.cover_text.length <= LIMITS.instagram.coverText
        ? c.cover_text
        : c.cover_text.slice(0, LIMITS.instagram.coverText)
      : undefined,
  };
}

function postProcessTiktok(
  c: NonNullable<Captions["tiktok"]>,
): NonNullable<Captions["tiktok"]> {
  // TikTok은 caption(해시태그 인라인)이 단일 진실. AI가 별도 hashtags를 줘도
  // 실제 게시되는 본문에 들어 있는 #만 인정한다.
  let caption = c.caption;
  if (caption.length > LIMITS.tiktok.caption) {
    caption = trimByWord(caption, LIMITS.tiktok.caption);
  }
  const inline = extractInlineHashtags(caption);
  const hashtags = ensureHash(inline.length > 0 ? inline : c.hashtags).slice(
    0,
    LIMITS.tiktok.hashtags,
  );
  return { caption, hashtags };
}

function postProcess(captions: Captions): Captions {
  return {
    youtube: captions.youtube ? postProcessYoutube(captions.youtube) : undefined,
    instagram: captions.instagram
      ? postProcessInstagram(captions.instagram)
      : undefined,
    tiktok: captions.tiktok ? postProcessTiktok(captions.tiktok) : undefined,
  };
}
