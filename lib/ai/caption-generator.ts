import "server-only";
import { z } from "zod";
import { getOpenAI, OPENAI_TEXT_MODEL } from "@/lib/openai";
import type { ContentPlatform as Platform } from "@/lib/platforms";
import { callOptions } from "@/lib/products/analysis/analyze";
import type { ContentRule } from "@/lib/rules/check";
import type { MediaItemKind } from "@/lib/upload/media-kind";
import { breakCaptionLines } from "./caption-layout";
import {
  checkInstagramCaption,
  cleanInstagramHashtags,
  type CaptionIssue,
} from "./instagram-caption-check";
import {
  buildCaptionSystemPrompt,
  captionFixInstruction,
  REGENERATE_INSTRUCTION,
  type CaptionAccount,
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
  instagram: { caption: 2200 },
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
    required: ["caption", "hashtags"],
    properties: {
      caption: { type: "string" as const },
      hashtags: { type: "array" as const, items: { type: "string" as const } },
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

// 2026-11-04 비교(같은 상품 · 같은 프롬프트 각 4회): gpt-4o는 4회 모두 설명에 없는 효과 · 사용법을 지어냈고,
// gpt-6.1-terra는 한 번도 지어내지 않았다. 추론 모델이라 temperature를 받지 않아 callOptions를 쓴다.

// 재작성은 첫 응답이 이 시간 안에 끝났을 때만 한다 — Vercel 함수 제한(60초) 안에서 두 번째 호출까지 마치려고.
const CAPTION_FIX_BUDGET_MS = 25_000;

interface GenerateCaptionsOptions {
  mediaType: "IMAGE" | "VIDEO";
  description?: string;
  presetInstructions?: string;
  platforms?: Platform[];
  /** 재생성 시 이전 응답을 assistant 메시지로 추가하고 다른 스타일을 요청한다. */
  previousCaptions?: Captions;
  /** 캡션이 올라갈 인스타 계정. 비어 있으면 계정 맞춤 없이 쓴다. */
  instagramAccounts?: CaptionAccount[];
  /** 광고 문구 규칙(0026). 어떤 상품인지 모르니 모든 상품 공통(ALL) 규칙만 검사한다. */
  contentRules?: ContentRule[];
  /**
   * imageDataUrls와 같은 순서로 장마다 사진/영상. 사진 게시물에 섞인 영상(인스타 캐러셀)은
   * 첫 프레임 이미지로 넘어오므로, 어느 장이 영상인지 알려 사진 게시물처럼 쓰지 않게 한다.
   */
  itemKinds?: MediaItemKind[];
}

export interface GenerateCaptionsOutput {
  captions: Captions;
  /** 재작성 뒤에도 인스타 캡션에 남아 사람이 확인할 표현. */
  reviewNotes: string[];
}

function severity(issues: CaptionIssue[]): number {
  return issues.reduce((sum, i) => sum + (i.level === "review" ? 100 : 1), 0);
}

export async function generateCaptions(
  imageDataUrls: string[],
  options: GenerateCaptionsOptions,
): Promise<GenerateCaptionsOutput> {
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

  // 장 순서와 종류가 맞을 때만 섞인 캐러셀로 본다 — 어긋나면 잘못된 구성을 알리느니 전처럼 쓴다.
  const kinds =
    options.mediaType === "IMAGE" && options.itemKinds?.length === imageDataUrls.length
      ? options.itemKinds
      : null;
  const mixedCarousel = !!kinds?.includes("VIDEO");
  const videoCount = kinds?.filter((k) => k === "VIDEO").length ?? 0;
  const composition = mixedCarousel
    ? `[게시물 구성]\n사진 ${imageDataUrls.length - videoCount}장 · 영상 ${videoCount}개를 넘겨 보는 캐러셀\n${kinds!
        .map((k, i) => `${i + 1}번째: ${k === "VIDEO" ? "영상(첫 장면 이미지)" : "사진"}`)
        .join("\n")}`
    : null;

  const baseInstruction = mixedCarousel
    ? "이 사진 · 영상들의 흐름과 관계를 분석해 위 형식으로 캡션을 생성해주세요. 영상은 첫 장면 이미지만 첨부했어요."
    : imageDataUrls.length > 1
      ? "이 이미지들의 흐름과 관계를 분석해 위 형식으로 캡션을 생성해주세요."
      : "이 이미지를 분석해 위 형식으로 캡션을 생성해주세요.";

  const description = options.description?.trim();
  const presetInstructions = options.presetInstructions?.trim();
  const userText = [
    presetInstructions ? `[캡션 스타일 가이드]\n${presetInstructions}` : null,
    description ? `[사용자 입력 기본 설명]\n${description}` : null,
    `[게시 대상 플랫폼]\n${platformLabels}`,
    composition,
    baseInstruction,
  ]
    .filter(Boolean)
    .join("\n\n");

  const messages: Parameters<
    ReturnType<typeof getOpenAI>["chat"]["completions"]["create"]
  >[0]["messages"] = [
    {
      role: "system",
      content: buildCaptionSystemPrompt(
        platforms,
        options.mediaType,
        options.instagramAccounts ?? [],
        mixedCarousel,
      ),
    },
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

  const responseSchema = buildResponseSchema(platforms);
  const requestCaptions = async (
    conversation: typeof messages,
  ): Promise<{ captions: Captions; raw: string }> => {
    const completion = await getOpenAI().chat.completions.create({
      model: OPENAI_TEXT_MODEL,
      ...callOptions(OPENAI_TEXT_MODEL, 4000),
      messages: conversation,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "captions",
          strict: true,
          schema: responseSchema,
        },
      },
    });
    const raw = completion.choices[0]?.message?.content;
    if (!raw) throw new Error("OpenAI 응답이 비어있습니다.");
    return { captions: postProcess(captionsSchema.parse(JSON.parse(raw))), raw };
  };
  const inspect = (c: Captions): CaptionIssue[] =>
    c.instagram
      ? checkInstagramCaption(
          c.instagram.caption,
          c.instagram.hashtags,
          options.contentRules,
        )
      : [];

  const startedAt = Date.now();
  const first = await requestCaptions(messages);
  let captions = first.captions;
  let issues = inspect(captions);

  if (issues.length > 0 && Date.now() - startedAt < CAPTION_FIX_BUDGET_MS) {
    try {
      const fixed = await requestCaptions([
        ...messages,
        { role: "assistant", content: first.raw },
        {
          role: "user",
          content: captionFixInstruction(issues.map((i) => i.message)),
        },
      ]);
      const fixedIssues = inspect(fixed.captions);
      if (severity(fixedIssues) <= severity(issues)) {
        captions = fixed.captions;
        issues = fixedIssues;
      }
    } catch (err) {
      // 재작성이 실패해도 첫 결과는 쓸 수 있다. 남은 표현은 reviewNotes로 알린다.
      console.warn("[generateCaptions] 인스타 캡션 재작성 실패:", err);
    }
  }

  return {
    captions,
    reviewNotes: issues.filter((i) => i.level === "review").map((i) => i.message),
  };
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
      breakCaptionLines(stripTrailingHashtags(c.caption).replace(/[ \t]*[—―][ \t]*/g, ", ")),
      LIMITS.instagram.caption,
    ),
    hashtags: cleanInstagramHashtags(ensureHash(c.hashtags)),
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
