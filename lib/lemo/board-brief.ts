import type { EditGraphic } from "@/lib/agents/edit-plan";
import type { MotionSpec } from "@/lib/agents/source-plan";
import type { Storyboard } from "@/lib/agents/storyboard";
import type { Look } from "@/lib/shoot/video-kit/caption-style";

// 장면표(lib/agents/storyboard.ts)에서 lemo 경로가 쓸 것만 추린 값.
// 장면표는 사진 · 스톡 방식에 맞춰 쓰이지만, 말 · 화면 지시 · 화면 글자 · 자막 줄 · 강조어 · 글자 디자인은 lemo 화면에도 그대로 적용된다.
// 장면 번호 = 음성 줄 번호(0부터)다. 사진 경로(lib/auto-video/make.ts)가 장면표를 읽는 규칙과 같게 추린다.

type BoardScene = Storyboard["scenes"][number];

export interface BoardBriefScene {
  /** 음성으로 읽을 원고. 사진 경로와 같이 tts를 먼저 쓰고 없으면 say */
  speech: string;
  /** 화면 표기 문장(자막 · 점검용) */
  say: string;
  /** 이 장면의 역할(situation · worry · knowledge · product · difference · takeaway) */
  part: BoardScene["part"];
  /** 장면표가 고른 화면 종류(photo · gif · archive · visual · motion · stock) */
  source: BoardScene["source"];
  /** 이 장면에서 시청자가 보는 것 */
  shows: string;
  /** 설명 화면 · 그래픽 · AI 그림이 전하는 내용을 사람이 읽는 줄로 */
  screen: string[];
  /** 장면표가 이 장면 화면에 쓰기로 한 글자. lemo 화면 글자(word 소품)는 이 안에서만 쓴다 */
  texts: string[];
  /** 자막 줄 나눔. 빈 배열이면 장면표 값이 없어(첫 장면 · 말과 안 맞는 줄) 합성 단계가 스스로 나눈다 */
  captions: string[];
  /** 자막에서 강조할 핵심어 */
  emphasis: string[];
}

export interface BoardBrief {
  hook: { spoken: string; on_screen: string; highlight: string; position: "top" | "lower" };
  scenes: BoardBriefScene[];
  /** 끝 화면(마지막 장면의 end_card). 없으면 null */
  ending: { text: string; chip: string; sub: string; note: string } | null;
  /** 장면표가 정한 글자 디자인 */
  look: Look;
  /** 사진 경로와 같은 방식으로 고른 글꼴(스킬 글꼴 목록에서). 목록을 못 읽었으면 null — 자막 디자인 AI가 고른다 */
  fonts: { key_font: string; small_font: string } | null;
}

const squash = (t: string) => t.replace(/\s+/g, "");
const filled = (list: (string | undefined | null)[]) => list.map((t) => (t ?? "").trim()).filter(Boolean);

/** 설명 화면(코드 도식)에 들어가는 글자. storyboard.ts motionTexts와 같은 칸이다(강조색 제외). */
function motionWords(m: MotionSpec): string[] {
  return filled([m.title, m.left_label, m.right_label, m.left_value, ...m.right_values, m.number_to ? `${m.number_to}${m.unit}` : "", m.end_text, ...m.items, m.big ? `${m.big}${m.unit}` : ""]);
}

/** 설명 화면이 전하려는 내용 한 줄. */
function motionLine(m: MotionSpec): string {
  const title = m.title.trim() ? `(${m.title.trim()})` : "";
  if (m.kind === "compare") return `비교 화면${title}: 왼쪽 "${m.left_label}" = "${m.left_value}" / 오른쪽 "${m.right_label}" = "${filled(m.right_values).join(" → ")}"`;
  if (m.kind === "count") return `숫자 화면${title}: ${m.number_to}${m.unit}까지 차오름${m.end_text.trim() ? `, 끝나면 "${m.end_text.trim()}"` : ""}`;
  if (m.kind === "steps") return `순서 · 목록 화면${title}: ${filled(m.items).join(" → ")}`;
  return `큰 글자 화면${title}: "${m.big}${m.unit}"`;
}

/** 그래픽에 보이는 글자. ring · arrow는 글자 없이 가리키는 표시라 뺀다. */
function graphicWords(g: EditGraphic): string[] {
  if (g.type === "ring" || g.type === "arrow") return [];
  return filled([g.chip, g.small, g.text, g.sub, g.note, g.number ? `${g.number}${g.unit}` : g.unit, g.left, g.right, ...g.items]);
}

const GRAPHIC_LABEL: Record<EditGraphic["type"], string> = {
  badge: "큰 낱말",
  title: "제목",
  chip: "작은 표시",
  notice: "안내",
  stat: "숫자",
  split: "둘 비교",
  steps: "순서",
  ring: "가리킴",
  arrow: "가리킴",
  end_card: "끝 화면",
};

function graphicLine(g: EditGraphic): string | null {
  const words = graphicWords(g);
  if (!words.length) return null;
  if (g.type === "split") return `둘 비교 그래픽: 왼쪽 "${g.left}" / 오른쪽 "${g.right}"${g.note.trim() ? ` (${g.note.trim()})` : ""}`;
  return `${GRAPHIC_LABEL[g.type]} 그래픽: ${words.map((w) => `"${w}"`).join(" · ")}`;
}

/**
 * 장면표에서 lemo가 쓸 것만 추린다.
 * fonts는 호출자가 사진 경로와 같은 방식(chosenFonts)으로 고른 글꼴 이름이다.
 */
export function boardBrief(board: Storyboard, fonts: { key_font: string; small_font: string } | null): BoardBrief {
  const last = board.scenes.length - 1;
  const endCard = board.scenes[last]?.graphics.find((g) => g.type === "end_card" && graphicWords(g).length > 0) ?? null;
  const scenes = board.scenes.map((s, i): BoardBriefScene => {
    // 첫 장면은 후킹 글자만 나온다(사진 경로도 첫 장면 그래픽을 쓰지 않는다). 끝 화면은 ending으로 따로 넘긴다
    const graphics = i === 0 ? [] : s.graphics.filter((g) => g.type !== "end_card");
    const motion = s.source === "motion" ? s.motion : null;
    const visual = s.source === "visual" ? board.visuals.find((v) => v.beat === i) : undefined;
    // 자막 줄은 이어 붙였을 때 말과 같아야 쓴다(사진 경로와 같은 조건). 아니면 합성 단계가 나눈다
    const captions = i === 0 ? [] : s.captions.length && squash(s.captions.join("")) === squash(s.say) ? s.captions.map((c) => c.trim()).filter(Boolean) : [];
    return {
      speech: s.tts || s.say,
      say: s.say,
      part: s.part,
      source: s.source,
      shows: s.shows.trim(),
      screen: [...(motion ? [motionLine(motion)] : []), ...(visual ? [`그림: ${visual.subject}`] : []), ...graphics.map(graphicLine).filter((l): l is string => !!l)],
      texts: [...new Set([...(motion ? motionWords(motion) : []), ...graphics.flatMap(graphicWords)])],
      captions,
      emphasis: s.emphasis.map((e) => e.trim()).filter(Boolean),
    };
  });
  return {
    hook: { spoken: board.hook.spoken, on_screen: board.hook.on_screen, highlight: board.hook.highlight, position: board.hook.position },
    scenes,
    ending: endCard ? { text: endCard.text.trim(), chip: endCard.chip.trim(), sub: endCard.sub.trim(), note: endCard.note.trim() } : null,
    look: board.look,
    fonts,
  };
}

/** 끝 화면에 쓸 수 있는 글자. */
export function endingTexts(brief: BoardBrief): string[] {
  return brief.ending ? filled([brief.ending.chip, brief.ending.text, brief.ending.sub, brief.ending.note]) : [];
}

/** 그 음성 줄 구간(from~to)의 장면에 쓸 수 있는 화면 글자. 마지막 줄이 들어 있으면 끝 화면 글자도 포함한다. */
export function allowedScreenTexts(brief: BoardBrief, from: number, to: number): string[] {
  const out = brief.scenes.slice(Math.max(0, from), to + 1).flatMap((s) => s.texts);
  if (to >= brief.scenes.length - 1) out.push(...endingTexts(brief));
  return [...new Set(out)];
}

// 글자 대조용: 띄어쓰기 · 기호를 빼고 본다
const plain = (t: string) => t.replace(/[^\p{L}\p{N}%]+/gu, "");

/** 화면 글자가 장면표 글자 안에서 온 것인지. 낱말마다 허용 글자 어딘가에 들어 있어야 한다(순서 · 기호는 달라도 된다). */
export function isBoardText(text: string, allowed: string[]): boolean {
  const pool = allowed.map(plain).filter(Boolean);
  const tokens = text.split(/[^\p{L}\p{N}%]+/u).filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => pool.some((a) => a.includes(t)));
}

const PART_LABEL: Record<BoardScene["part"], string> = {
  situation: "후킹",
  worry: "궁금증",
  knowledge: "상식",
  product: "우리 상품",
  difference: "우리 차이",
  takeaway: "마무리",
};

const SOURCE_LABEL: Record<BoardScene["source"], string> = {
  photo: "제품 사진",
  gif: "상세페이지의 움직이는 이미지",
  archive: "자사 촬영 컷",
  visual: "AI 그림",
  motion: "코드 설명 화면",
  stock: "스톡 영상",
};

const quoted = (list: string[]) => list.map((t) => `"${t}"`).join(" · ");

/** 연출 AI에게 줄 장면표 화면 지시. 줄 번호 = 음성 줄 번호. */
export function boardScreenLines(brief: BoardBrief): string {
  const lines = brief.scenes.map((s, i) => {
    const parts = [`보이는 것: ${s.shows || "(적혀 있지 않음)"} (장면표의 화면 종류: ${SOURCE_LABEL[s.source]})`, ...s.screen];
    if (i === 0) parts.push(`후킹 큰 글자 "${brief.hook.on_screen.replace(/\n+/g, " ")}"는 편집 키트가 얹는다(그리지 않는다)`);
    if (s.texts.length) parts.push(`화면 글자: ${quoted(s.texts)}`);
    return `${i}. [${PART_LABEL[s.part]}] ${parts.join(" | ")}`;
  });
  const ending = endingTexts(brief);
  if (ending.length) lines.push(`끝 화면(마지막 줄의 장면): ${quoted(ending)}`);
  return lines.join("\n");
}
