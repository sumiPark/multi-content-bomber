import { editKit } from "@/lib/agents/ko-skills";
import type { EditPlanContext } from "@/lib/agents/edit-plan";
import { captionLookText } from "@/lib/style-shorts/caption-look";
import { CARD_SECTIONS, type StyleCard } from "@/lib/style-shorts/card";
import { SFX_PALETTE } from "@/lib/style-shorts/sfx-palette";

// 스타일 쇼츠 편집 지시문 — 직접 촬영 편집 에이전트(edit-plan.ts)가 ctx.style이 있을 때만 쓴다.
// 상품이 없는 순수 편집이다. 레퍼런스 스타일 카드를 기본 편집 규칙(kit.json)보다 먼저 따른다(사용자 결정 2026-11-19).
// 컨셉과 카드가 부딪히면 형식은 카드, 내용 · 말투는 컨셉을 따른다.

export interface StylePlanGuide {
  card: StyleCard;
  voiceMode: "AI" | "LIVE";
  script: string | null;
  concept: string | null;
}

function bullets(lines: string[]): string {
  return lines.map((l) => `- ${l}`).join("\n");
}

/** 카드를 지시문용 글로. 숫자는 레퍼런스에서 코드가 잰 값이다. */
export function cardText(card: StyleCard): string {
  const n = card.numbers;
  const numbers = [
    n.durationSec && `레퍼런스 길이 ${n.durationSec[0]}~${n.durationSec[1]}초`,
    n.avgShotSec != null && `평균 컷 ${n.avgShotSec}초`,
    n.cutsPer10s != null && `10초당 컷 ${n.cutsPer10s}개`,
    n.sfxPer10s != null && `효과음 10초당 ${n.sfxPer10s}개`,
    n.sfxKinds.length && `효과음 종류 비율 ${n.sfxKinds.map((k) => `${k.kind} ${Math.round(k.share * 100)}%`).join(", ")}`,
    n.tempo != null && `음악 ${n.tempo}BPM`,
    `자막 방식 ${n.captionStyle}`,
  ].filter(Boolean);
  return [
    `요약: ${card.summary}`,
    `측정값: ${numbers.join(" · ")}`,
    ...CARD_SECTIONS.map((s) => `[${s.title}]\n${card.sections[s.key] || "-"}`),
    ...(card.captionLook ? [`[자막 모양]\n${captionLookText(card.captionLook)}\n글자색 · 강조색 · 상자 · 크기는 코드가 이 값으로 고정한다. 자막 자리(hook.position 포함)와 한 줄 길이를 이 값에 맞춘다.`] : []),
    `[배경음악] ${card.music.mood} (검색어: ${card.music.query})`,
  ].join("\n");
}

function voiceBlock(g: StylePlanGuide): string {
  const script = g.script?.trim();
  if (g.voiceMode === "LIVE") {
    return `소리: 찍은 영상의 말소리를 그대로 쓴다. 모든 비트를 mode live로 쓰고 tts는 빈 문자열로 둔다.
- 말이 있는 촬영본은 받아쓰기(transcript)를 보고 NG · 말 더듬기 · 같은 말 되풀이 · 긴 침묵을 빼고, 가장 또렷하게 말한 구간만 고른다. 한 문장이 끊기지 않게 낱말 시각에 맞춰 in · out을 잡는다.
- 말이 없는 장면도 mode live로 쓴다(원본의 현장 소리가 그대로 나간다). live 비트는 컷이 정확히 1개다.
- 자막은 코드가 받아쓰기로 넣는다. captions는 빈 배열로 둔다.${script ? `\n- 아래 대본은 찍을 때 말하려던 내용이다. 받아쓰기의 맞춤법 · 고유명사를 맞출 때와 어떤 구간을 어떤 순서로 쓸지 정할 때 참고한다. 대본에 없는 말을 새로 넣지 않는다.\n"""\n${script}\n"""` : ""}`;
  }
  if (script) {
    return `소리: AI 음성이 읽는다. 모든 비트를 mode tts로 쓴다. 찍은 영상의 소리는 쓰지 않는다.
- 아래 대본을 그대로 쓴다. 내용 · 순서 · 말투를 바꾸지 않고, 비트로 나누기와 숫자 · 기호를 읽는 대로 바꾸기만 한다. 문장을 새로 지어 넣거나 빼지 않는다. 대본의 첫 문장이 후킹이다(hook.spoken).
- 대본 길이가 촬영본보다 길면 장면을 아껴 나눠 쓰고, 짧으면 대본을 늘이지 말고 영상을 짧게 끝낸다.
"""
${script}
"""`;
  }
  return `소리: AI 음성이 읽는다. 모든 비트를 mode tts로 쓴다. 찍은 영상의 소리는 쓰지 않는다.
- 대본은 네가 쓴다. 아래 컨셉과 레퍼런스 스타일 카드의 말 · 말투, 그리고 프레임에서 실제로 보이는 장면으로 쓴다. 보이지 않는 장면을 말하지 않는다.`;
}

export function styleSystemPrompt(ctx: EditPlanContext, g: StylePlanGuide): string {
  const kit = editKit();
  const n = g.card.numbers;
  const concept = g.concept?.trim();
  const duration = n.durationSec ? `레퍼런스 길이(${n.durationSec[0]}~${n.durationSec[1]}초) 근처로 맞추되, 촬영본에 쓸 장면이 모자라면 짧게 끝낸다.` : "내용에 맞게 15~60초.";
  const palette = SFX_PALETTE.map((s) => `${s.id} [${s.kind}] ${s.use}`).join("\n");
  const sfxDensity = n.sfxPer10s != null ? `영상 10초마다 약 ${n.sfxPer10s}개(레퍼런스 측정값)` : "카드에 적힌 만큼";
  return `너는 숏폼 영상 편집자다. 사람이 찍은 원본 영상을 보고, 아래 "레퍼런스 스타일 카드"와 같은 스타일로 보이는 편집 계획을 세운다. 계획은 코드가 그대로 만든다.
이 영상은 상품 자료가 없는 편집이다. 사실은 대본 · 컨셉과 프레임에서 실제로 보이는 것에만 근거한다.

가장 중요한 규칙: 레퍼런스 스타일 카드를 꼭 따른다.
- 카드와 아래 "기본 편집 규칙"이 다르면 카드를 따른다(컷 길이 · 전환, 후킹 방식, 자막 방식 · 위치 · 모양, 그래픽 양 · 종류, 효과음 빈도 · 종류, 끝맺음).
- 컨셉과 카드가 부딪히면 형식(컷 · 자막 · 그래픽 · 소리)은 카드를, 내용 · 말투는 컨셉을 따른다.
- 레퍼런스의 장면 · 글 · 소리를 베끼지 않는다. 스타일만 따른다.

레퍼런스 스타일 카드:
"""
${cardText(g.card)}
"""
${concept ? `\n컨셉(내용 · 말투의 기준):\n"""\n${concept}\n"""\n` : ""}
${voiceBlock(g)}

순서:
1. 프레임 묶음에서 촬영본마다 쓸 구간과 뺄 구간을 판단한다(analysis). 시각이 애매하면 look_closer로 확인한다. components는 빈 배열로 둔다.
2. 후킹: 카드의 후킹 방식대로 첫 컷과 첫 화면 글자를 정한다.${g.voiceMode === "AI" && g.script?.trim() ? " 첫 말은 대본의 첫 문장이다." : " 필요하면 list_hook_formulas · score_hooks를 써도 된다."} hook.on_screen은 카드 자막 · 화면 글자 스타일에 맞춘다.
3. 표지: 카드 분위기에 맞는 프레임과 짧은 글자.
4. 대본과 컷: ${duration} 컷 길이 · 개수는 카드의 컷 · 속도를 따른다(평균 컷 ${n.avgShotSec ?? "-"}초). 비트마다 한 가지만 말하고 장면과 말이 맞게 한다.
5. 자막 · 그래픽 · 효과음: 카드대로. caption_style은 ${n.captionStyle === "keyword" ? "keyword" : "sentence"}${n.captionStyle === "none" ? "로 두되, 레퍼런스가 말 자막을 쓰지 않으니 captions는 비워 두고 꼭 필요한 화면 글자만 그래픽으로 넣는다" : ""}. 효과음은 ${sfxDensity}, 카드의 효과음 종류 비율에 맞춰 아래 목록에서만 고른다.
6. look: 카드의 자막 · 화면 설명대로 글자 디자인을 정한다. music_query는 "${g.card.music.query}", music_intent는 "${g.card.music.mood}"로 쓴다.
7. 쓰는 말 전체를 check_ai_tone으로 점검하고${g.voiceMode === "AI" ? " read_tts로 읽기용 원고를 확인한다" : "다"}. visuals는 빈 배열로 둔다.

기본 편집 규칙(카드와 다르면 카드를 따른다):
글자 디자인:
${bullets(kit.look_rules)}
후킹:
${bullets(kit.hook_rules)}
표지:
${bullets(kit.thumbnail_rules)}
컷:
${bullets(kit.cut_rules)}
자막:
${bullets(kit.caption_rules)}
음성:
${bullets(kit.tts_rules)}
검색이 안 될 때 쓸 곡(music):
${JSON.stringify(kit.music_library.map((m) => ({ file: m.file, mood: m.mood })))}

그래픽 틀 (이것만 쓴다. 쓰지 않는 칸은 빈 문자열, 숫자는 0):
${JSON.stringify(kit.graphics)}
${bullets(kit.graphics_rules)}

효과음 (이 id만 쓴다. at_word가 있으면 그 낱말을 말할 때, 없으면 비트 안 위치 at 0~1. 휙 · 상승음은 장면이 바뀌는 순간에, 팝 · 클릭은 글자 · 그래픽이 나올 때 둔다):
${palette}

절대 규칙:
- 대본 · 컨셉 · 화면에 없는 사실(숫자 · 효과 · 성분)을 지어내지 않는다. 체험담처럼 들리는 말을 대본에 없이 지어내지 않는다.
- 효과를 단정하지 않는다. 최고 · 유일 · 100% 같은 단정을 쓰지 않는다. em dash를 쓰지 않는다.
- 인사 · 자기소개로 시작하지 않는다(대본에 있으면 그대로 둔다).
- 구간은 촬영본 길이 안에서만 고른다. 같은 구간을 두 번 쓰지 않는다.
- warnings에는 사람이 확인할 문제만 시각과 함께 쓴다(카드대로 못 한 것과 그 이유 포함).`;
}
