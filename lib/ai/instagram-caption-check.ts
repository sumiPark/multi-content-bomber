import slop from "@/.claude/skills/ig-human-ko/slop_ko.json";
import { checkText, type ContentRule } from "@/lib/rules/check";

// 직접 업로드 인스타 캡션 점검. 기준은 .claude/skills/ig-caption-ko/caption_ko.py와 ig-human-ko/detect_ko.py다.
// 캡션 생성은 Vercel 서버 액션에서 돌아 파이썬을 부를 수 없어서, 필요한 검사만 옮겼다. 상투어 사전(slop_ko.json)은 같은 파일을 읽는다.

export const INSTAGRAM_HASHTAG_COUNT = 3;
const SAFE_FIRST_SENTENCE = 40;
const MAX_EMOJI_PER_100 = 4;
const MAX_SLOP_REPORTED = 6;

export interface CaptionIssue {
  // review: 재작성 뒤에도 남으면 사람에게 알린다 / style: 재작성 때만 고치도록 요청한다
  level: "review" | "style";
  message: string;
}

const EMOJI = /[\u{1F300}-\u{1FAFF}\u2600-\u27BF\u2190-\u21FF]/gu;
const GREETING = /^\s*(?:안녕하세요|안녕하십니까|여러분\s?안녕|반갑습니다|하이[!~,. ]|헬로)/;
const LINK =
  /https?:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]+\.(?:com|co\.kr|kr|co|io|net|org|ai|app|me|ly|shop)(?:\/\S*)?|smartstore\.naver\.com\S*|naver\.me\/\S+/i;
const INLINE_HASHTAG = /(?:^|\s)#[^\s#]+/;
const COMPLIANCE_FAIL =
  /치료|완치|(?<![가-힣])재생(?!\s?(?:버튼|목록|시간))|염증|질병\s?(?:예방|개선)|부작용\s?(?:없|제로|0)|특효|약효|아토피\s?(?:개선|치료)|여드름\s?(?:치료|개선)/g;
const COMPLIANCE_WARN = /최고|최상|(?<![가-힣])유일|100\s?%|백\s?퍼센트|(?<![\d])1위|최초|기적|완벽/g;

const ASKS: [RegExp, string][] = [
  [/댓글(?:에|로|란에)?\s?["“'‘]?[가-힣A-Za-z0-9]{1,10}["”'’]?\s?(?:이라고|라고)?\s?(?:남겨|달아|적어|써)/, "댓글 키워드"],
  [/(?:DM|디엠|dm|메시지)\s?(?:주세요|보내|주시면|으로|로|주시)/, "DM"],
  [/저장(?:해|하|각|\s?필수)/, "저장"],
  [/공유(?:해|하세요)|(?:친구|사람)(?:한테|에게)?\s?(?:보내|공유|태그)/, "공유·태그"],
  [/팔로우(?:도|를|\s?꼭)?\s?(?:하|해|부탁|필수)/, "팔로우"],
  [/프로필\s?(?:링크|상단|에\s?링크|에서)|링크는\s?프로필|바이오\s?링크|구매는|주문은/, "프로필 링크"],
  [/어떠세요\?|어느\s?(?:쪽|게|거)[^?\n]{0,10}\?|뭐(?:가|를)\s?[^?\n]{0,15}\?|알려\s?주세요/, "질문 답하기"],
];

const FILLER_TAGS = new Set([
  "#일상", "#데일리", "#소통", "#소통해요", "#맞팔", "#맞팔해요", "#선팔", "#선팔하면맞팔", "#좋아요",
  "#좋반", "#좋아요반사", "#팔로우", "#팔로우미", "#인친", "#인친해요", "#일상스타그램", "#인스타그램",
  "#릴스", "#추천", "#인기", "#팔로우환영", "#viral", "#fyp", "#explore", "#explorepage", "#foryou",
  "#trending", "#instagood", "#reels", "#reelsinstagram", "#daily", "#follow", "#like4like",
]);

interface SlopEntry {
  find: string;
  suggest: string;
  regex?: string;
}

function slopPattern(entry: SlopEntry): RegExp {
  if (entry.regex) return new RegExp(entry.regex, "m");
  const body = entry.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s*");
  return new RegExp(`(?<![가-힣])${body}`);
}

const SLOP = ([...slop.words, ...slop.phrases] as SlopEntry[]).map((entry) => ({ entry, pattern: slopPattern(entry) }));

/** 의미 없는 태그와 중복을 빼고 규칙 개수까지만 남긴다. */
export function cleanInstagramHashtags(tags: string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const tag of tags) {
    const key = tag.toLowerCase();
    if (FILLER_TAGS.has(key) || seen.has(key)) continue;
    seen.add(key);
    kept.push(tag);
  }
  return kept.slice(0, INSTAGRAM_HASHTAG_COUNT);
}

function hits(text: string, pattern: RegExp): string[] {
  return [...new Set([...text.matchAll(pattern)].map((m) => m[0]))];
}

function repeatedEnding(text: string): string | null {
  const sentences = (text.match(/[^.!?…\n]+[.!?…]*/g) ?? [])
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).filter((t) => /[가-힣A-Za-z0-9]/.test(t)).length >= 2);
  const endings = sentences.map((s) => {
    const syllables = s.replace(/[^가-힣]+$/, "").slice(-4).match(/[가-힣]/g) ?? [];
    return syllables.length >= 2 ? syllables.slice(-2).join("") : null;
  });
  for (let i = 0; i + 2 < endings.length; i += 1) {
    if (endings[i] && endings[i] === endings[i + 1] && endings[i] === endings[i + 2]) return endings[i];
  }
  return null;
}

export function checkInstagramCaption(caption: string, hashtags: string[], rules: ContentRule[] = []): CaptionIssue[] {
  const issues: CaptionIssue[] = [];
  const review = (message: string) => issues.push({ level: "review", message });
  const style = (message: string) => issues.push({ level: "style", message });
  const body = caption.trim();
  const published = `${body}\n\n${hashtags.join(" ")}`;

  const banned = hits(published, COMPLIANCE_FAIL);
  if (banned.length > 0) review(`의약품으로 오인될 수 있는 표현이 있어요: ${banned.join(", ")}`);
  const absolute = hits(published, COMPLIANCE_WARN);
  if (absolute.length > 0) review(`근거가 필요한 단정 표현이 있어요: ${absolute.join(", ")}`);
  for (const hit of checkText(published, "OTHER", rules.filter((r) => r.ruleType === "BANNED"))) {
    review(`광고 문구 규칙에 어긋나요: ${hit.matched}${hit.rule.suggestion ? ` (대신: ${hit.rule.suggestion})` : ""}`);
  }
  if (LINK.test(body)) review("캡션에 링크가 있어요. 캡션 링크는 눌리지 않아요");

  const firstLine = body.split("\n")[0]?.trim() ?? "";
  const firstSentence = body.split(/(?<=[.!?])\s|\n/)[0]?.trim() ?? "";
  if (/^[#@]/.test(firstLine)) style("첫 줄을 해시태그나 멘션으로 시작하지 않는다");
  else if (GREETING.test(firstLine)) style("첫 줄을 인사로 시작하지 않는다");
  else if (firstLine.search(EMOJI) === 0) style("첫 글자를 이모지로 시작하지 않는다");
  if (firstSentence.length > SAFE_FIRST_SENTENCE) {
    style(`첫 문장이 ${firstSentence.length}자다. ${SAFE_FIRST_SENTENCE}자 안에서 끝낸다`);
  }

  const asks = ASKS.filter(([pattern]) => pattern.test(body)).map(([, name]) => name);
  if (asks.length === 0) style("행동 요청이 없다. 저장, 댓글 키워드, DM 중 하나를 넣는다");
  else if (asks.length > 1) style(`요청이 ${asks.length}개다(${asks.join(", ")}). 하나만 남긴다`);

  if (hashtags.length !== INSTAGRAM_HASHTAG_COUNT) {
    style(`hashtags가 ${hashtags.length}개다. 상품·고민·품목을 가리키는 태그로 정확히 ${INSTAGRAM_HASHTAG_COUNT}개를 쓴다`);
  }
  if (INLINE_HASHTAG.test(body)) style("caption 안의 해시태그를 빼고 hashtags 배열에만 둔다");

  const emojiCount = body.match(EMOJI)?.length ?? 0;
  if ((emojiCount * 100) / Math.max(body.length, 1) > MAX_EMOJI_PER_100) {
    style(`이모지가 많다(${emojiCount}개). 100자당 ${MAX_EMOJI_PER_100}개 아래로 줄인다`);
  }

  const ending = repeatedEnding(body);
  if (ending) style(`같은 어미 "${ending}"가 세 문장 연속이다. 문장 끝을 바꾼다`);

  for (const { entry } of SLOP.filter(({ pattern }) => pattern.test(body)).slice(0, MAX_SLOP_REPORTED)) {
    style(`상투어 "${entry.find}"를 고친다: ${entry.suggest}`);
  }
  return issues;
}
