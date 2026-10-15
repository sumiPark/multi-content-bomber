import { z } from "zod";
import { getOpenAI } from "@/lib/openai";
import { TEMPLATE_MAX_LENGTH, validateTemplates } from "@/lib/episode-alerts/templates";

// server-only는 쓰지 않는다 — 새 화가 발행 워커(tsx + plain Node)에서 추가될 때도 문구를 새로
// 쓰는데, 워커에서 import하면 throw한다. 브라우저 번들에 끌려가면 여기서 바로 막는다.
if (typeof window !== "undefined") {
  throw new Error("reply-template-generator는 서버(Server Action / 워커)에서만 import해야 합니다.");
}

// 시리즈 댓글 자동화 — 답글 문구 AI 생성.
//   · 새 화를 추가하면 자동으로(lib/episode-alerts/auto-templates.ts)
//   · 문구 수정 화면의 "AI로 새로 만들기"를 누를 때
//
// AI 티가 나지 않게: 계정 주인이 직접 단 답글을 말투 예시로 주고(있을 때), 짧고 말하듯 쓰게 하고,
// AI가 즐겨 쓰는 포장 표현은 결과에서 한 번 더 걸러 버린다.
// 인스타 스팸 제한에 걸리지 않게(공개 기준은 없고 실무 관찰 기준):
//   · 링크·도메인·해시태그·다른 계정 멘션 금지, 홍보성 단어 금지
//   · 문구마다 시작과 구조를 다르게 — 같은 문장 반복이 가장 흔한 스팸 신호
// 프롬프트로 요구하고, 규칙을 어긴 문구는 후처리에서 버린다.

export const AI_TEMPLATE_COUNT = 5;
// 넉넉히 받아 거른 뒤 AI_TEMPLATE_COUNT개를 고른다.
const AI_REQUEST_COUNT = 8;
// 이보다 적게 남으면 실패로 본다(버튼은 다시 누르게, 자동은 기존 문구 유지).
const MIN_VALID = 3;
const MAX_EMOJI = 1;
const MAX_EXCLAMATION = 1;
// @{username}을 뺀 실제 길이(자리표시자는 예시 값으로 바꿔 잼). 길면 공지처럼 읽힌다.
const MAX_BODY_LENGTH = 50;

// 매번 분위기를 조금씩 바꿔 다른 문구가 나오게 한다.
const MOOD_HINTS = [
  "친구한테 카톡 보내듯 편하게",
  "짧고 담백하게",
  "살짝 들뜬 느낌",
  "댓글 고마운 마음을 한마디 얹어서",
  "다음 내용이 궁금하게 살짝",
  "말 걸듯 가볍게",
];

// 느낌 예시 — 그대로 나오면 버린다(모든 계정이 같은 문장을 쓰게 되므로).
const STYLE_EXAMPLES = [
  "@{username} {episode}화 올렸어요 ㅎㅎ",
  "@{username} 오늘 {episode}화 나왔어요! 프로필에 있어요",
  "@{username} {episode}화도 봐주세요~ 이번 편 좀 재밌어요",
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

// AI가 쓴 티가 나는 표현 — 크리에이터가 폰으로 다는 대댓글엔 거의 안 나온다. 있으면 버린다.
const AI_TELLS = [
  "드디어",
  "기다리던",
  "새로운",
  "업데이트",
  "보셨나요",
  "짜잔",
  "두근",
  "설레",
  "특별한",
  "새로운 이야기",
  "만나보세요",
  "놓치지",
  "함께해",
  "기대해 주세요",
  "기대해주세요",
  "기다리고 있어요",
  "준비됐",
  "준비되었",
  "공개되었습니다",
  "업로드되었습니다",
  "바랍니다",
  "답니다",
  "여러분",
  "감상",
  "선사",
  "✨",
  "🎉",
  "📢",
  "💫",
  "🌟",
  "📷",
];

const EMOJI = /\p{Extended_Pictographic}/gu;

// 한 묶음 안에 같은 버릇이 몰려도 기계 같다(실측: "~"로 끝나는 문구가 몰리고 "확인해보세요"가
// 반복됐다). 버릇마다 한 묶음에 넣을 수 있는 개수를 둔다.
const HABIT_CAPS: { pattern: RegExp; max: number }[] = [
  { pattern: /~/, max: 2 },
  { pattern: /[!！]/, max: 2 },
  { pattern: /ㅎㅎ|ㅋㅋ/, max: 2 },
  { pattern: /확인/, max: 1 },
  { pattern: /프로필|최신 (글|게시물)/, max: 2 },
];

// 버릇 상한을 지키며 고르고, 그러다 너무 적어지면 남은 것으로 최소 개수만 채운다.
function pickVaried(candidates: string[]): string[] {
  const counts = HABIT_CAPS.map(() => 0);
  const picked: string[] = [];
  const skipped: string[] = [];
  for (const t of candidates) {
    if (picked.length >= AI_TEMPLATE_COUNT) break;
    const hits = HABIT_CAPS.map((h) => h.pattern.test(t));
    if (hits.some((hit, i) => hit && counts[i] >= HABIT_CAPS[i].max)) {
      skipped.push(t);
      continue;
    }
    hits.forEach((hit, i) => {
      if (hit) counts[i]++;
    });
    picked.push(t);
  }
  return [...picked, ...skipped.slice(0, Math.max(0, MIN_VALID - picked.length))];
}

function pickHints(n: number): string[] {
  const pool = [...MOOD_HINTS];
  const out: string[] = [];
  while (out.length < n && pool.length > 0) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}

function buildPrompt(seriesName: string, current: string[], voiceSamples: string[]): string {
  const name = seriesName.trim() || "시리즈";
  const avoid = current.map((t) => t.trim()).filter(Boolean);
  const n = AI_REQUEST_COUNT;
  return [
    `인스타그램 시리즈 "${name}"의 새 회차가 올라왔어. 이전 화에 댓글 단 사람한테, 그 댓글의 대댓글로 새 회차 소식을 알리는 짧은 답글을 ${n}개 써줘.`,
    "계정 주인이 폰으로 직접 단 답글처럼 보여야 해. AI나 마케팅 문구 같은 티가 나면 안 돼.",
    "",
    "[자리표시자 — 글자 그대로 써야 함]",
    "- {username}: 댓글 단 사람 아이디. 모든 문구를 \"@{username} \"으로 시작하고 그 뒤로는 다시 쓰지 마.",
    "- {episode}: 새 회차 번호. 모든 문구에 \"{episode}화\" 형태로 한 번 넣어.",
    `- {series}: 시리즈 이름. 사람은 답글에 시리즈 이름을 잘 안 쓰니 거의 쓰지 마(${n}개 중 1개까지). "${name}"처럼 이름을 직접 쓰지 말고 반드시 {series}로.`,
    "- 그 밖의 중괄호는 쓰지 마.",
    "",
    "[사람이 쓴 것처럼]",
    "- @{username} 뒤 내용은 8~35자. 한 문장, 길어도 두 문장.",
    "- 말하듯 쓰는 해요체(\"올렸어요\", \"나왔어요\", \"봐주세요\"). 공지·광고 말투(~습니다, ~바랍니다, ~답니다)와 반말 금지.",
    `- 끝맺음을 섞어: "~요", "~요!", "~요 ㅎㅎ", "~요~". 마침표는 거의 찍지 말고, 느낌표는 ${n}개 중 3개 이하.`,
    `- "ㅎㅎ"나 "~"는 자연스러울 때만 ${n}개 중 2~3개에.`,
    `- 이모지는 ${n}개 중 많아야 2개 문구에 1개씩. ✨🎉📢📷 같은 홍보 느낌 이모지 금지.`,
    "- 이런 AI 티 나는 표현 금지: 드디어, 짜잔, 두근두근, 설레는, 특별한, 새로운 이야기, 만나보세요, 놓치지 마세요, 함께해요, 기대해 주세요, 기다리고 있어요, 준비됐어요, 여러분.",
    "- 꾸밈말 없이 담백하게. 위치 안내(\"프로필에 있어요\", \"최신 글에 올렸어요\")는 일부 문구에만 짧게.",
    `- "확인해보세요"는 ${n}개 중 1개까지. 매번 뭘 하라고 권하지 말고 그냥 소식만 전하는 문구도 섞어.`,
    "- 질문으로 끝내지 마(\"보셨나요?\", \"궁금하시죠?\" 같은 것). 새 소식을 알려주는 거야.",
    `- ${n}개는 시작 말과 문장 구조가 서로 달라야 해. 같은 표현 반복 금지.`,
    `- 이번 분위기: ${pickHints(2).join(", ")}.`,
    "",
    "[느낌 예시 — 그대로 쓰지 말고 이런 결로]",
    ...STYLE_EXAMPLES.map((t) => `- ${t}`),
    "",
    "[인스타 스팸 제한에 걸리지 않게 — 꼭 지켜]",
    "- 링크·URL·도메인, 해시태그(#), 다른 계정 멘션 금지.",
    "- \"DM\", \"링크\", \"클릭\", \"무료\", \"이벤트\", \"할인\", \"구매\", \"구독\", \"팔로우\" 같은 홍보성 단어 금지.",
    "- 느낌표·물음표를 두 개 이상 연달아 쓰지 마.",
    ...(voiceSamples.length > 0
      ? [
          "",
          "[계정 주인이 직접 단 답글 — 이 말투·길이·끝맺음·ㅎㅎ/이모지 쓰는 습관을 따라 써. 내용은 베끼지 마]",
          ...voiceSamples.map((t) => `- ${t}`),
        ]
      : []),
    ...(avoid.length > 0
      ? [
          "",
          "[지금 쓰고 있는 문구 — 이것들과 겹치지 않게 새로 써. 말투도 따라 하지 마]",
          ...avoid.map((t) => `- ${t}`),
        ]
      : []),
    "",
    `JSON으로 {"templates": [문구 ${n}개]} 형태로만 답해.`,
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

// @{username}을 뺀 실제로 보일 길이.
function bodyLength(t: string, seriesName: string): number {
  return t
    .replace(/@\{username\}\s*/g, "")
    .replace(/\{episode\}/g, "12")
    .replace(/\{series\}/g, seriesName.trim() || "시리즈").length;
}

// 규칙을 어긴 문구는 고치지 않고 버린다(고치다 어색해지느니 다른 문구를 쓰는 게 낫다).
function clean(raw: string[], current: string[], seriesName: string): string[] {
  const seen = new Set([...current, ...STYLE_EXAMPLES].map((t) => t.trim()));
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
    if (AI_TELLS.some((w) => t.includes(w))) continue;
    if (/[!?！？]{2,}/.test(t)) continue;
    if ((t.match(/[!！]/g) ?? []).length > MAX_EXCLAMATION) continue;
    if (!t.includes("{episode}")) continue;
    if ((t.match(EMOJI) ?? []).length > MAX_EMOJI) continue;
    if (bodyLength(t, seriesName) > MAX_BODY_LENGTH) continue;
    if (t.length > TEMPLATE_MAX_LENGTH) continue;
    if (validateTemplates([t]).errors.length > 0) continue;
    if (seen.has(t)) continue;

    seen.add(t);
    out.push(t);
  }
  return pickVaried(out);
}

export async function generateReplyTemplates(args: {
  seriesName: string;
  current: string[];
  // 계정 주인이 직접 단 답글 — 말투 예시. 없으면 빈 배열.
  voiceSamples?: string[];
}): Promise<string[]> {
  const completion = await getOpenAI().chat.completions.create({
    model: "gpt-4o",
    // 매번 다른 문구가 나오도록 높게.
    temperature: 1,
    max_tokens: 800,
    messages: [
      {
        role: "system",
        content:
          "너는 인스타그램 크리에이터 본인이야. 자기 게시물 댓글에 폰으로 짧게 대댓글을 단다. 마케터나 AI처럼 매끈하게 포장하지 않고, 평소 말투로 담백하게 쓴다.",
      },
      {
        role: "user",
        content: buildPrompt(args.seriesName, args.current, args.voiceSamples ?? []),
      },
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
