// 스레드 글 · 주제 태그 규칙. 발행 어댑터(threads.ts)와 업로드 마법사(스레드 글 칸)가 같이 쓴다.
// 화면에서도 불러야 해서 server-guard 없이 순수 함수만 둔다.

// 스레드 규격: 글 500자, 주제 태그 1개(1~50자, 마침표 · & · 공백 불가).
export const THREADS_MAX_TEXT = 500;
export const THREADS_MAX_TAG = 50;

/** 태그 하나를 스레드 주제 태그로 쓸 수 있게 다듬는다. 못 쓰면 null. */
export function cleanTopicTag(raw: string): string | null {
  const tag = raw.replace(/^#+/, "").trim();
  if (!tag || tag.length > THREADS_MAX_TAG || /[.&\s]/.test(tag)) return null;
  return tag;
}

/** 해시태그 목록에서 스레드 주제 태그로 쓸 수 있는 첫 번째. */
export function pickTopicTag(hashtags: string[]): string | null {
  for (const raw of hashtags) {
    const tag = cleanTopicTag(raw);
    if (tag) return tag;
  }
  return null;
}

// 글을 스레드 500자에 맞춘다. 본문 안의 #해시태그는 스레드가 첫 하나만 태그로
// 쓰고 나머지는 글자로 남아 지저분하니 지우고, 태그는 topic_tag로 하나만 보낸다.
// 넘치면 문장 · 줄 경계에서 자르고 말줄임표를 붙인다.
export function buildThreadsText(caption: string | null): string {
  const body = (caption ?? "")
    .replace(/(^|\s)#[^\s#]+/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (body.length <= THREADS_MAX_TEXT) return body;
  const room = THREADS_MAX_TEXT - 1;
  const cut = body.slice(0, room);
  const boundary = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "));
  const head = boundary > room * 0.6 ? cut.slice(0, boundary + 1) : cut;
  return `${head.trimEnd()}…`;
}
