import type { VersionRequest, VersionTimeline } from "@/lib/style-shorts/jobs";

// 스타일 쇼츠 주석 수정(3단계, 사용자 결정 2026-11-19) — 완성본 위에 단 주석을 편집 에이전트가 읽을 글로 바꾼다.
// 주석 시각을 저장해 둔 시각표 요약(VersionTimeline)으로 그 순간의 장면 · 자막 · 그래픽 · 효과음에 맞춘다.
// 앱 · 워커가 함께 쓴다(Node 전용 모듈을 불러오지 않는다).

export type ReviseNote = Extract<VersionRequest, { kind: "revise" }>["notes"][number];

export const NOTE_MAX = 500;
export const NOTES_PER_VERSION = 30;

const sec = (n: number) => `${n.toFixed(1)}초`;

/** 주석 한 개가 가리키는 순간의 편집 내용. */
export function noteContext(note: ReviseNote, tl: VersionTimeline | null): string {
  if (note.at == null) return "영상 전체 의견";
  const t = note.at;
  const parts = [`${sec(t)}`];
  if (note.x != null && note.y != null) {
    const h = note.x < 0.34 ? "왼쪽" : note.x > 0.66 ? "오른쪽" : "가운데";
    const v = note.y < 0.34 ? "위" : note.y > 0.66 ? "아래" : "가운데";
    parts.push(`동그라미 자리: 화면 ${v === "가운데" && h === "가운데" ? "한가운데" : `${v} ${h}`} (x ${note.x.toFixed(2)}, y ${note.y.toFixed(2)})`);
  }
  if (tl) {
    const cut = tl.cuts.find((c) => c.start <= t && t < c.end) ?? tl.cuts[tl.cuts.length - 1];
    if (cut) parts.push(`장면: 촬영본 ${cut.clip}번 ${sec(cut.in + Math.max(0, t - cut.start))} 근처 (영상 ${sec(cut.start)}~${sec(cut.end)} 컷)`);
    const cap = tl.captions.find((c) => c.start <= t && t < c.end);
    // 지금 글은 〈 〉로 감싼다 — 따옴표로 감싸면 "따옴표 글자는 그대로" 규칙(quotedTexts)이 지금 글을 사람이 정한 글로 잘못 본다
    if (cap) parts.push(`그때 자막: 〈${cap.text}〉`);
    const gr = tl.graphics.filter((g) => g.start <= t && t < g.end);
    if (gr.length) parts.push(`그때 그래픽: ${gr.map((g) => `${g.type}${g.text ? ` 〈${g.text}〉` : ""}`).join(", ")}`);
    const fx = tl.sfx.filter((s) => Math.abs(s.t - t) <= 0.6);
    if (fx.length) parts.push(`가까운 효과음: ${fx.map((s) => `${s.name}(${sec(s.t)})`).join(", ")}`);
  }
  return parts.join(" · ");
}

/** 편집 에이전트에 넘기는 고칠 내용 전체와 줄별 항목. */
export function reviseRequestText(notes: ReviseNote[], tl: VersionTimeline | null): { request: string; items: string[] } {
  const items = notes.map((n) => `${n.no}번 [${noteContext(n, tl)}] ${n.body}`);
  return { request: items.join("\n"), items };
}

/** 음악 · 자막 모양을 바꾸라는 주석이 있는지 — 있으면 지난 곡 · 자막 디자인을 이어 쓰지 않고 새로 고른다. */
export function asksFor(notes: ReviseNote[]): { music: boolean; captionDesign: boolean } {
  const all = notes.map((n) => n.body).join(" ");
  return {
    music: /음악|bgm|배경\s*음|노래|곡|브금/i.test(all),
    // 자막 글자만 고치는 주석("자막 오타")은 모양을 다시 고르지 않는다
    captionDesign: /글꼴|폰트|글씨체|글자체|모션|자막\s*(?:의\s*)?(?:모양|디자인|움직임|스타일|효과|색|크기)/.test(all),
  };
}
