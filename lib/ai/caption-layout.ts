// 인스타 캡션 줄 나눔 — 직접 생성(콘텐츠 생성 마법사)과 AI 자동 · 직접 촬영 캡션이 같이 쓴다.
// 2026-11-12: AI 캡션이 한 문단에 문장 2~3개를 한 줄로 이어 써서(한 줄 90자) 휴대폰에서 읽기 어렵다는 지적.
// 사람이 쓴 캡션은 한 줄 15~25자로 끊고 2~4줄마다 빈 줄을 둔다. 워커에서도 쓰므로 server-only를 넣지 않는다.

/** 캡션을 쓰는 프롬프트에 넣는 줄 나눔 규칙. */
export const CAPTION_LINE_RULE =
  "줄 나눔: 휴대폰에서 읽기 쉽게 한 줄에 한 문장만 쓴다. 문장 둘을 한 줄에 이어 쓰지 않는다. 문장이 공백 포함 25자를 넘으면 쉼표나 말이 끊기는 자리에서 줄을 바꾼다(첫 문장은 더 보기 전에 보이도록 한 줄로 둔다). 2~4줄씩 묶어 문단을 만들고, 첫 문장 뒤 · 문단 사이 · 요청 앞 · 해시태그 앞에는 빈 줄을 하나 둔다.";

const HASHTAG_LINE = /^(?:#[^\s#]+\s*)+$/u;

/**
 * AI가 줄 나눔 규칙을 어겼을 때의 안전망. 한 줄에 이어 쓴 문장을 문장 끝(. ! ?)에서 나누고,
 * 끝의 해시태그 줄 앞에 빈 줄을 둔다. 문장 안을 임의로 자르지는 않는다(말이 끊기는 자리는 AI가 정한다).
 */
export function breakCaptionLines(text: string): string {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .flatMap((line) =>
      HASHTAG_LINE.test(line.trim())
        ? [line.trimEnd()]
        : line
            .split(/(?<=[.!?])\s+(?=[^\s#.!?])/u)
            .map((s) => s.trimEnd()),
    );
  // 끝의 해시태그 줄 앞에 빈 줄
  const last = lines.length - 1;
  if (last > 0 && HASHTAG_LINE.test(lines[last].trim()) && lines[last - 1].trim() !== "") {
    lines.splice(last, 0, "");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
