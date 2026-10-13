import "server-only";
import { z } from "zod";
import { getOpenAI } from "@/lib/openai";
import { TEMPLATE_MAX_LENGTH, validateTemplates } from "@/lib/episode-alerts/templates";

// 시리즈 댓글 자동화 — 답글 문구 AI 생성.
// 문구 수정 화면의 "AI로 새로 만들기"가 부른다. 누를 때마다 새 문구 묶음으로 바꾼다.
//
// 인스타 스팸 제한에 걸리지 않게(공개 기준은 없고 실무 관찰 기준):
//   · 링크·도메인·해시태그·다른 계정 멘션 금지, 홍보성 단어 금지
//   · 문구마다 시작과 구조를 다르게 — 같은 문장 반복이 가장 흔한 스팸 신호
//   · 이모지는 일부 문구에만 1개
// 프롬프트로 요구하고, 결과도 아래 후처리에서 한 번 더 걸러 규칙을 어긴 문구는 버린다.

export const AI_TEMPLATE_COUNT = 5;
// 이보다 적게 남으면 실패로 보고 다시 누르게 한다.
const MIN_VALID = 3;
const MAX_EMOJI = 1;

// 누를 때마다 분위기를 조금씩 바꿔 매번 다른 문구가 나오게 한다.
const MOOD_HINTS = [
  "설레고 기대되는 느낌",
  "댓글 남겨줘서 고마운 마음",
  "다음 내용이 궁금해지게 살짝 자극",
  "반가운 친구에게 소식 전하듯",
  "짧고 경쾌하게",
  "다정하고 포근하게",
  "가볍게 수다 떨듯",
  "기다려준 것에 대한 감사",
];

const responseSchema = z.object({ templates: z.array(z.string()) });

// 홍보·스팸으로 읽히기 쉬운 단어. 하나라도 있으면 그 문구는 버린다.
const BANNED_WORDS = [
  "dm",
  "디엠",
  "링크",
  "클릭",
  "무료",
  "이벤트",
  "할인",
  "구매",
  "구독",
  "팔로우",
  "선착순",
  "광고",
];

const EMOJI = /\p{Extended_Pictographic}/gu;

function pickHints(n: number): string[] {
  const pool = [...MOOD_HINTS];
  const out: string[] = [];
  while (out.length < n && pool.length > 0) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}

function buildPrompt(seriesName: string, current: string[]): string {
  const name = seriesName.trim() || "시리즈";
  const avoid = current.map((t) => t.trim()).filter(Boolean);
  return [
    `인스타그램 시리즈 "${name}"의 새 회차가 올라왔어. 이전 화에 댓글을 남겨준 사람에게, 그 댓글의 대댓글로 새 회차 소식을 알려주는 짧은 문구를 ${AI_TEMPLATE_COUNT}개 써줘.`,
    "",
    "[자리표시자 — 글자 그대로 써야 함]",
    "- {username}: 댓글 단 사람 아이디. 모든 문구를 \"@{username} \"으로 시작하고 그 뒤로는 다시 쓰지 마.",
    "- {episode}: 새 회차 번호. 모든 문구에 \"{episode}화\" 형태로 한 번 넣어.",
    `- {series}: 시리즈 이름. 넣고 싶을 때만 한 번까지. "${name}"처럼 이름을 직접 쓰지 말고 반드시 {series}로 써.`,
    "- 그 밖의 중괄호는 쓰지 마.",
    "",
    "[톤]",
    "- 친근한 해요체 존댓말. 반말·과장·딱딱한 공지 말투 금지.",
    "- 크리에이터가 직접 손으로 단 것처럼 자연스럽게.",
    `- 이번 분위기: ${pickHints(2).join(", ")}.`,
    "",
    "[형식]",
    "- 문구 하나는 25~70자(자리표시자 포함), 한두 문장.",
    `- 이모지는 ${AI_TEMPLATE_COUNT}개 중 2~3개 문구에만 1개씩. 이모지 2개 이상 금지.`,
    "- 새 게시물 위치는 링크 대신 \"프로필에서\", \"최신 게시물에서\" 같은 말로 안내.",
    "",
    "[인스타 스팸 제한에 걸리지 않게 — 꼭 지켜]",
    "- 링크·URL·도메인, 해시태그(#), 다른 계정 멘션 금지.",
    "- \"DM\", \"링크\", \"클릭\", \"무료\", \"이벤트\", \"할인\", \"구매\", \"구독\", \"팔로우\" 같은 홍보성 단어 금지.",
    "- 느낌표·물음표를 두 개 이상 연달아 쓰지 마.",
    `- ${AI_TEMPLATE_COUNT}개 문구는 시작 말과 문장 구조가 서로 달라야 해. 같은 표현 반복 금지.`,
    ...(avoid.length > 0
      ? ["", "[지금 쓰고 있는 문구 — 이것들과 겹치지 않게 새로 써]", ...avoid.map((t) => `- ${t}`)]
      : []),
    "",
    `JSON으로 {"templates": [문구 ${AI_TEMPLATE_COUNT}개]} 형태로만 답해.`,
  ].join("\n");
}

// 시리즈 이름을 글자 그대로 넣었으면 {series}로 바꾼다 — 나중에 이름을 바꿔도 따라가게.
function replaceSeriesName(t: string, seriesName: string): string {
  const name = seriesName.trim();
  if (!name) return t;
  let out = t;
  for (const q of [["\"", "\""], ["'", "'"], ["“", "”"], ["‘", "’"], ["「", "」"]]) {
    out = out.split(`${q[0]}${name}${q[1]}`).join("{series}");
  }
  return out.split(name).join("{series}");
}

// 규칙을 어긴 문구는 고치지 않고 버린다(고치다 어색해지느니 다른 문구를 쓰는 게 낫다).
function clean(raw: string[], current: string[], seriesName: string): string[] {
  const seen = new Set(current.map((t) => t.trim()));
  const out: string[] = [];
  for (const r of raw) {
    let t = r.replace(/\s+/g, " ").trim().replace(/^["'“”]+|["'“”]+$/g, "");
    if (!t) continue;
    t = replaceSeriesName(t, seriesName);
    // {series}는 한 번까지.
    if ((t.match(/\{series\}/g) ?? []).length > 1) continue;
    if (!t.includes("{username}")) t = `@{username} ${t}`;

    const lower = t.toLowerCase();
    if (/https?:|www\.|\.(com|kr|net|co|me|ly)\b|#/.test(lower)) continue;
    if (t.replace(/@\{username\}/g, "").includes("@")) continue;
    if (BANNED_WORDS.some((w) => lower.includes(w))) continue;
    if (/[!?！？]{2,}/.test(t)) continue;
    if (!t.includes("{episode}")) continue;
    if ((t.match(EMOJI) ?? []).length > MAX_EMOJI) continue;
    if (t.length > TEMPLATE_MAX_LENGTH) continue;
    if (validateTemplates([t]).errors.length > 0) continue;
    if (seen.has(t)) continue;

    seen.add(t);
    out.push(t);
  }
  return out.slice(0, AI_TEMPLATE_COUNT);
}

export async function generateReplyTemplates(args: {
  seriesName: string;
  current: string[];
}): Promise<string[]> {
  const completion = await getOpenAI().chat.completions.create({
    model: "gpt-4o",
    // 누를 때마다 다른 문구가 나오도록 높게.
    temperature: 1,
    max_tokens: 800,
    messages: [
      {
        role: "system",
        content:
          "너는 인스타그램 크리에이터 대신 댓글에 대댓글을 다는 카피라이터야. 친근하고 자연스러운 한국어로, 스팸처럼 보이지 않게 쓴다.",
      },
      { role: "user", content: buildPrompt(args.seriesName, args.current) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "reply_templates",
        strict: true,
        schema: {
          type: "object",
          properties: {
            templates: { type: "array", items: { type: "string" } },
          },
          required: ["templates"],
          additionalProperties: false,
        },
      },
    },
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("AI 응답이 비어 있어요. 다시 눌러주세요.");
  const parsed = responseSchema.parse(JSON.parse(content));
  const templates = clean(parsed.templates, args.current, args.seriesName);
  if (templates.length < MIN_VALID) {
    throw new Error("쓸 만한 문구가 충분히 안 나왔어요. 한 번 더 눌러주세요.");
  }
  return templates;
}
