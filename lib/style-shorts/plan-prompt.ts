import { editKit } from "@/lib/agents/ko-skills";
import type { EditPlan, EditPlanContext } from "@/lib/agents/edit-plan";
import { captionLookText } from "@/lib/style-shorts/caption-look";
import { reactionLookLines } from "@/lib/shoot/video-kit/caption-skill";
import { CARD_SECTIONS, OVERLAY_KIND_LABEL, type StyleCard } from "@/lib/style-shorts/card";
import { SFX_PALETTE } from "@/lib/style-shorts/sfx-palette";

// 스타일 쇼츠 편집 지시문 — 직접 촬영 편집 에이전트(edit-plan.ts)가 ctx.style이 있을 때만 쓴다.
// 상품이 없는 순수 편집이다. 레퍼런스 스타일 카드를 기본 편집 규칙(kit.json)보다 먼저 따른다(사용자 결정 2026-11-19).
// 컨셉과 카드가 부딪히면 형식은 카드, 내용 · 말투는 컨셉을 따른다.

// 말소리 영상에서 원본(화면 + 말)을 돌리는 배수(2026-11-20 사용자 결정). 사람 편집본 해물모듬을 원본과 견줘 잰 값:
// 쉼 없이 이어지는 말이 원본 초당 6.2자 → 사람 편집 8.2자(약 1.3배). 배경음악 · 효과음은 그대로 둔다
export const STYLE_LIVE_SPEED = 1.3;

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
    n.sfxPer10s != null && `효과음 10초당 ${n.sfxPer10s}개${n.sfxIsMin ? " 이상" : ""}`,
    n.sfxOverBedDb != null && `효과음 크기 바로 앞 소리보다 ${n.sfxOverBedDb}dB`,
    n.endDropShare != null && `끝 직전에 음악을 끊는 레퍼런스 ${Math.round(n.endDropShare * 100)}%`,
    n.musicChangeShare != null &&
      `배경음악을 중간에 바꾸는 레퍼런스 ${Math.round(n.musicChangeShare * 100)}%${n.musicChangeShare >= 0.5 && n.musicChangeAt?.length ? `(영상 ${n.musicChangeAt.map((r) => `${Math.round(r * 100)}%`).join(" · ")} 지점, 곡은 코드가 장면 전환에 맞춰 바꾼다)` : ""}`,
    n.charsPerSec != null && `말 초당 ${n.charsPerSec}자`,
    n.maxPauseSec != null && `말 사이 가장 긴 빈틈 ${n.maxPauseSec}초 · 0.6초 넘는 빈틈 10초당 ${n.pausePer10s}개 · 빈틈 비율 ${Math.round((n.silentShare ?? 0) * 100)}%`,
    n.captionPer10s != null && `말 자막 10초당 ${n.captionPer10s}개 · 자막 하나 평균 ${n.captionChars}자 · 한 줄 ${Math.round((n.captionOneLine ?? 0) * 100)}% · 크게 강조 ${Math.round((n.captionBigShare ?? 0) * 100)}%${n.captionPlace ? ` · 주로 ${({ top: "위", mid: "가운데", lower: "아래" } as const)[n.captionPlace]}` : ""}${n.captionColors?.length ? ` · 색 ${n.captionColors.join(", ")}` : ""}`,
    n.sfxKinds.length && `효과음 종류 비율 ${n.sfxKinds.map((k) => `${k.kind} ${Math.round(k.share * 100)}%`).join(", ")}`,
    n.tempo != null && `음악 ${n.tempo}BPM`,
    `자막 방식 ${n.captionStyle}`,
    n.overlayPer10s != null && `화면 위 글자 · 그래픽(말 자막 제외) 10초당 ${n.overlayPer10s}개`,
    n.overlayKinds?.length && `그 종류 비율 ${n.overlayKinds.map((k) => `${OVERLAY_KIND_LABEL[k.kind]} ${Math.round(k.share * 100)}%`).join(", ")}`,
    n.overlayColors?.length && `화면 위 글자 색 ${n.overlayColors.join(", ")}`,
    n.zoomPer10s != null && `화면 확대 10초당 ${n.zoomPer10s}번`,
    n.endCardShare != null && `안내 카드로 끝나는 레퍼런스 ${Math.round(n.endCardShare * 100)}%`,
  ].filter(Boolean);
  const examples = n.overlayExamples?.length ? `화면 위 글자 예(형식만 참고, 글을 베끼지 않는다): ${n.overlayExamples.map((e) => `[${OVERLAY_KIND_LABEL[e.kind]}] ${e.text} ${e.color}`).join(" / ")}` : "";
  return [
    `요약: ${card.summary}`,
    `측정값: ${numbers.join(" · ")}`,
    ...(examples ? [examples] : []),
    ...CARD_SECTIONS.map((s) => `[${s.title}]\n${card.sections[s.key] || "-"}`),
    ...(card.captionLook ? [`[자막 모양]\n${captionLookText(card.captionLook)}\n글자색 · 강조색 · 상자 · 크기는 코드가 이 값으로 고정한다. 자막 자리(hook.position 포함)와 한 줄 길이를 이 값에 맞춘다.`] : []),
    `[배경음악] ${card.music.mood} (검색어: ${card.music.query})`,
  ].join("\n");
}

/** 반응 · 속마음 글자 · 화면 확대 · 끝 카드 지시(2026-11-19 사용자 결정 — 레퍼런스에서 잰 빈도에 맞춘다). */
function reactionStep(card: StyleCard): string {
  const n = card.numbers;
  const per = n.overlayPer10s;
  const share = (kinds: string[]) => Math.round((n.overlayKinds ?? []).filter((k) => kinds.includes(k.kind)).reduce((s, k) => s + k.share, 0) * 100);
  const textShare = share(["reaction", "inner_voice", "sticker", "title"]);
  const freq =
    per != null
      ? `레퍼런스는 말 자막 말고 화면 위 글자 · 그래픽이 10초당 ${per}개다(그중 반응 · 속마음 · 스티커 · 제목 글자 ${textShare}%). 영상 길이에 맞춰 같은 빈도로 넣는다. 반응 · 속마음 글자는 reactions에, 동그라미 · 화살표는 ring · arrow 그래픽, 안내 · 가격 카드는 notice · chip 그래픽으로 넣는다.`
      : "레퍼런스 화면 위 글자 측정값이 없다. 카드의 그래픽 설명만큼 넣는다.";
  const zoom =
    n.zoomPer10s != null && n.zoomPer10s > 0
      ? `화면 확대(zooms): 레퍼런스는 10초당 ${n.zoomPer10s}번 같은 장면을 확 당긴다. 놀람 · 반응 · 강조하는 순간에 넣는다. 확대는 그 컷 끝까지 이어지고 다음 컷에서 풀린다.`
      : "화면 확대(zooms): 카드에 확대 설명이 없으면 빈 배열로 둔다.";
  const ending =
    n.endCardShare != null && n.endCardShare >= 0.5
      ? "끝맺음: 레퍼런스 대부분이 안내 카드로 끝난다. 마지막 비트에 end_card 그래픽을 넣고, 카드 글은 컨셉 · 대본에 있는 내용으로만 쓴다(없는 가격 · 혜택을 지어내지 않는다)."
      : "";
  return `   반응 · 속마음 글자(reactions): 사람이 놀라거나 웃거나 혼잣말하는 순간에 말 자막과 따로 화면에 툭 얹는 짧은 글자다(예: 헉!, 진짜?, (화난 거 아님)). 말 자막과 같은 말을 되풀이하지 않고, 프레임에서 보이는 표정 · 행동에 맞는 말만 쓴다. ${freq} 색은 카드의 화면 위 글자 색을 따르고, 맞는 예능 모양이 있으면 look에 그 이름을 쓴다. 스티커 · 이모지는 만들 수 없으니 반응 글자로 대신한다.
   ${zoom}${ending ? `\n   ${ending}` : ""}
   쓸 수 있는 예능 모양(이름: 생김새):
${reactionLookLines()}`;
}

function voiceBlock(g: StylePlanGuide): string {
  const script = g.script?.trim();
  const n = g.card.numbers;
  if (g.voiceMode === "LIVE") {
    // 레퍼런스에서 잰 말 사이 빈틈(2026-11-20 추가). 예전 카드는 없다
    const pause =
      n.maxPauseSec != null
        ? `\n- 말 사이 빈틈: 레퍼런스는 가장 긴 빈틈이 ${n.maxPauseSec}초, 0.6초 넘는 빈틈이 10초당 ${n.pausePer10s}개다. 비트 안이나 비트 사이에 이보다 긴 쉼이 남지 않게 in · out을 말 시작 · 끝에 붙여 자른다. 이야기 줄기(처음 소개 · 중간 사건 · 끝맺음 말)는 빼지 말고 쉼만 줄여 길이를 맞춘다.`
        : "";
    return `소리: 찍은 영상의 말소리를 그대로 쓴다. 모든 비트를 mode live로 쓰고 tts는 빈 문자열로 둔다.
- 말이 있는 촬영본은 받아쓰기(transcript)를 보고 NG · 말 더듬기 · 같은 말 되풀이 · 긴 침묵을 빼고, 가장 또렷하게 말한 구간만 고른다.
- 받아쓰기 문장의 words는 [낱말, 시작초, 끝초]다. in · out은 문장 시각이 아니라 낱말 시각으로 잡는다: in은 쓸 첫 낱말의 시작보다 0.05초 앞, out은 쓸 마지막 낱말의 끝보다 0.1초 뒤(쓰지 않을 다음 낱말의 시작은 넘지 않는다). 낱말 중간에서 자르지 않는다. words가 없는 문장만 문장 시각으로 잡는다.
- 길이를 문장을 통째로 빼는 것만으로 맞추지 않는다. 남기는 문장 안에서도 군말(어 · 음 · 그 · 이제) · 같은 말 되풀이 · 긴 쉼을 낱말 시각으로 잘라 내고, 그 앞뒤를 다른 비트로 나눠 바로 이어 붙인다(점프 컷). 뜻이 이어지는 구절 안에서는 자르지 않는다.
- 코드가 고른 구간(화면 + 말)을 ${STYLE_LIVE_SPEED}배속으로 돌린다. in · out과 낱말 시각은 원본 시각 그대로 쓴다. 영상 길이는 고른 구간 길이의 합을 ${STYLE_LIVE_SPEED}로 나눈 값에 약 0.3초를 더한 값이다(비트 사이에 틈이 들어가지 않는다). 계획을 내기 전에 구간 길이를 모두 더해 레퍼런스 길이 안인지 확인하고, 넘으면 덜 중요한 말부터 뺀다.${pause}
- 말이 없는 장면도 mode live로 쓴다(원본의 현장 소리가 그대로 나간다). live 비트는 컷이 정확히 1개다.
- live 비트는 컷이 1개라 비트 수가 곧 컷 수다. 레퍼런스 컷이 짧으면(점프 컷) 한 문장도 구절마다 다른 비트로 나누고, 구절 사이의 쉼 · "어 · 음" 같은 군말은 빼서 바로 이어 붙인다. 비트 5~14개 제한보다 레퍼런스 컷 속도가 먼저다.
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

/**
 * 주석 수정(3단계) 지시 — 사용자 메시지 끝에 붙는다. 직접 촬영 고치기와 달리 글 수정도 미리 적용하지 않고, 여기서 주석 전체를 처리한다.
 * frameNos: 촬영본 프레임 묶음 뒤에 붙인 주석 화면의 번호(보낸 차례대로).
 */
export function styleReviseBlock(revise: { plan: EditPlan; request: string; items: string[] }, frameNos: number[], g: StylePlanGuide): string {
  // 고른 음악 · 자막 디자인은 코드가 따로 이어 쓰고(바꾸라는 주석이 있으면 코드가 지운다), 지난 경고는 새 계획과 상관없다
  const past = Object.fromEntries(Object.entries(revise.plan).filter(([k]) => !["warnings", "pickedMusic", "pickedMusicExtra", "captionDesign", "redoCaptionLines"].includes(k)));
  const frames = frameNos.length
    ? `\n프레임 묶음 다음의 마지막 ${frameNos.length}장은 지난 완성본에서 주석 시각의 화면이다(차례대로 ${frameNos.map((n) => `${n}번`).join(", ")} 주석). 노란 동그라미가 관리자가 짚은 자리이고, 옆 숫자가 주석 번호, 왼쪽 위가 번호와 시각이다. 동그라미 안에 있는 것(자막 · 그래픽 · 사람 · 물건)이 주석이 말하는 대상이다.`
    : "";
  const live = g.voiceMode === "LIVE"
    ? "\n- 영상 내 음성 영상이라 자막은 받아쓰기로 코드가 넣는다. 자막 글자를 고치라는 주석은 그 말을 하는 구간을 바꾸거나 빼서 반영하고, 그래도 안 되면 warnings에 적는다."
    : g.script?.trim()
      ? "\n- 대본을 그대로 쓰는 규칙보다 주석이 먼저다. 주석이 말을 바꾸라고 하면 그 부분만 바꾸고 나머지 대본은 그대로 둔다."
      : "";
  return `

이미 만든 완성본을 관리자가 주석으로 고쳐 달라고 했다. 지난 편집 계획과 주석이 아래에 있다. 지난 계획을 바탕으로 주석이 말하는 것만 고친 계획 전체를 낸다.${frames}
- 주석마다 [ ] 안에 그 시각의 장면(촬영본 번호 · 구간) · 자막 · 그래픽 · 효과음이 적혀 있다. 이것과 주석 화면으로 지난 계획의 어느 비트 · 컷 · 자막 · 그래픽 · 효과음인지 찾는다. "영상 전체 의견"은 특정 시각이 없는 의견이다.
- 주석이 말하지 않은 것은 지난 계획 그대로 둔다: 후킹 · 표지 · 읽는 말 · 자막 · 비트 순서 · 컷 · 그래픽 · 효과음 · look · caption_style. 후킹 공식 · 채점 도구는 후킹을 고치라는 주석이 있을 때만 쓴다.
- 장면을 바꾸거나 더 넣으라는 주석은 촬영본 프레임을 다시 보고 고른다. 시각이 애매하면 look_closer로 확인한다.
- 효과음 · 그래픽을 넣으라 · 빼라는 주석은 그 시각의 비트에서 고친다. 효과음은 위 목록의 id만 쓴다.
- 반응 · 속마음 글자, 화면 확대를 넣으라 · 빼라 · 고치라는 주석은 reactions · zooms에서 고친다. 지난 계획의 reactions · zooms는 주석이 말하지 않으면 그대로 옮겨 적는다(지난 계획에 없으면 빈 배열).
- 지난 계획의 speakers(비트마다 말하는 사람)는 비트를 바꾸지 않았으면 그대로 옮겨 적고, 비트를 나누거나 뺐으면 새 비트 번호에 맞춰 다시 적는다. 지난 계획에 없으면 위 순서 7대로 새로 적는다. 말하는 사람이 틀렸다는 주석은 여기서 고친다.
- 글자 자리(위 · 가운데 · 아래)를 옮기라는 주석은 text_places로 정한다. 후킹 글자(첫 화면의 큰 글자)면 hook에, 말 자막이면 그 자막이 나오는 비트를 captions에 { beat, place }로 넣는다. 위 = top, 가운데 = mid, 아래 = lower. "가운데"가 좌우 정렬인지 위아래 자리인지 애매하면 위아래 자리로 본다(자막은 이미 좌우 가운데 정렬이다). 지난 계획의 text_places는 주석이 바꾸라고 하지 않으면 그대로 옮겨 적는다. 지난 계획에 text_places가 없으면 hook auto, captions 빈 배열에서 시작한다.
- 음악을 바꾸라는 주석이 있으면 look.music_query(영어 2~4낱말, 악기 · 분위기)와 look.music_intent를 주석대로 고친다. 코드가 그 검색어로 다른 곡을 찾는다. 없으면 지난 값 그대로 둔다.
- 레퍼런스 스타일 카드보다 주석이 먼저다. 주석이 없는 부분은 계속 카드를 따른다.
- 주석에서 따옴표로 적은 글자는 다듬지 않고 글자 그대로 쓴다.${live}${g.card.captionLook ? "\n- 자막 글자색 · 강조색 · 상자 · 크기는 레퍼런스 자막 모양으로 코드가 고정한다. 이것을 바꾸라는 주석은 warnings에 \"주석 N번: 자막 색 · 크기는 레퍼런스 자막 모양으로 고정돼 있어 바꾸지 않았어요\"라고 적는다. 글꼴 · 움직임은 코드가 주석을 보고 다시 고른다." : ""}
- 반영하지 못한 주석은 warnings에 "주석 N번: 이유" 형식으로 적는다(예: "주석 1번: 첫 화면 글자를 화면 가운데로 옮기지 못했어요."). 다 반영했으면 주석 얘기는 warnings에 쓰지 않는다.
- 새로 쓰거나 고친 말만 check_ai_tone${g.voiceMode === "AI" ? ", read_tts" : ""}로 점검한다.

주석:
"""
${revise.request}
"""

지난 계획:
${JSON.stringify(past)}`;
}

// 스타일 쇼츠에서 빼는 기본 규칙(2026-11-19 사용자 결정 — 레퍼런스대로 유연하게):
// 후킹의 흔한 말 금지 · 후킹이 가장 큰 글자, 그래픽 양(15초 3개 · 40%) · 가리지 않기, 효과음 15초 2~3개 · 힘줄 곳에만
const DROP_HOOK = ["흔한 말", "가장 큰 글자"];
const DROP_GRAPHICS = ["15초에 3개", "가리지 않게"];

function styleKitRules(kit: ReturnType<typeof editKit>) {
  return {
    hook: kit.hook_rules.filter((r) => !DROP_HOOK.some((d) => r.includes(d))),
    // 가리지 않기 규칙에 붙어 있던 "자막과 같은 말 되풀이 금지"는 남긴다
    graphics: [...kit.graphics_rules.filter((r) => !DROP_GRAPHICS.some((d) => r.includes(d))), "그래픽 글은 자막과 같은 말을 되풀이하지 않는다."],
  };
}

export function styleSystemPrompt(ctx: EditPlanContext, g: StylePlanGuide): string {
  const kit = editKit();
  const rules = styleKitRules(kit);
  const n = g.card.numbers;
  const concept = g.concept?.trim();
  const fixedScript = g.voiceMode === "AI" && !!g.script?.trim();
  const duration = fixedScript
    ? "길이는 넣은 대본을 그대로 읽은 길이다."
    : n.durationSec
      ? `영상 길이는 레퍼런스 길이(${n.durationSec[0]}~${n.durationSec[1]}초, 코드가 잰 값) 안에 맞춘다. ${g.voiceMode === "AI" ? "AI 음성은 읽는 글자(띄어쓰기 · 문장부호 제외) 약 6~7자가 1초다." : `영상 내 음성은 고른 구간을 ${STYLE_LIVE_SPEED}배속으로 돌리므로 고른 구간 길이의 합 ÷ ${STYLE_LIVE_SPEED}이 영상 길이다.`} 촬영본에 쓸 장면이 모자랄 때만 짧게 끝낸다.`
      : "내용에 맞게 15~60초.";
  const palette = SFX_PALETTE.map((s) => `${s.id} [${s.kind}] ${s.use}`).join("\n");
  const sfxDensity =
    n.sfxPer10s != null
      ? n.sfxIsMin
        ? `영상 10초마다 ${n.sfxPer10s}개 이상(레퍼런스 측정값은 최소값이라 더 많아도 된다)`
        : `영상 10초마다 약 ${n.sfxPer10s}개(레퍼런스 측정값)`
      : "카드에 적힌 만큼";
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
4. 대본과 컷: ${duration} 컷 길이 · 개수는 카드의 컷 · 속도를 따른다(평균 컷 ${n.avgShotSec ?? "-"}초${n.avgShotSec ? `, 영상 10초에 컷 약 ${Math.round(10 / n.avgShotSec)}개` : ""}). 레퍼런스 컷 수에는 같은 구도에서 말 사이를 잘라 붙인 점프 컷이 들어 있다. 같은 촬영본 안에서도 말이 바뀌는 곳마다 컷을 나눠 이 속도를 맞춘다(같은 구간을 두 번 쓰지는 않는다). 비트마다 한 가지만 말하고 장면과 말이 맞게 한다.
5. 자막 · 그래픽 · 효과음: 카드대로. caption_style은 ${n.captionStyle === "keyword" ? "keyword" : "sentence"}${n.captionStyle === "none" ? "로 두되, 레퍼런스가 말 자막을 쓰지 않으니 captions는 비워 두고 꼭 필요한 화면 글자만 그래픽으로 넣는다" : ""}. 효과음은 ${sfxDensity}, 카드의 효과음 종류 비율에 맞춰 아래 목록에서만 고른다. 효과음은 컷이 바뀌는 순간 · 반응 글자가 뜨는 순간 · 화면 확대 순간 · 카드가 나오는 순간에 붙인다.
${reactionStep(g.card)}
6. look: 카드의 자막 · 화면 설명대로 글자 디자인을 정한다. music_query는 "${g.card.music.query}", music_intent는 "${g.card.music.mood}"로 쓴다.
7. speakers: ${
    g.voiceMode === "LIVE"
      ? "말이 있는 비트마다 누가 말하는지 적는다. on_screen = 그 장면에 보이는 사람이 말한다, off_screen = 화면에 안 보이는 사람(카메라 뒤에서 말하는 사람 · 전화 상대)의 목소리다. 코드가 화면 속 사람의 말은 화면 위쪽 · 가운데에, 화면 밖 목소리는 아래에 자막을 둔다. 대본에 말하는 사람이 번갈아 적혀 있으면(줄 앞의 - 표시 등) 받아쓰기와 맞춰 보고 정하고, 프레임에서 그 구간에 보이는 사람이 말하는 모습(입 · 몸짓)인지 듣는 모습인지도 본다. 한 비트에는 한 사람의 말만 들어가게, 말하는 사람이 바뀌는 곳에서 비트를 나눈다. 말이 없는 비트는 적지 않는다."
      : "빈 배열로 둔다(AI 음성 영상)."
  }
   text_places는 hook을 auto, captions를 빈 배열로 둔다. 글자 자리는 코드가 상품 · 사람을 피해 정한다(사람이 자리를 정했을 때만 쓰는 칸이다).
8. 쓰는 말 전체를 check_ai_tone으로 점검하고${g.voiceMode === "AI" ? " read_tts로 읽기용 원고를 확인한다" : "다"}. visuals는 빈 배열로 둔다.

기본 편집 규칙(카드와 다르면 카드를 따른다):
글자 디자인:
${bullets(kit.look_rules)}
후킹:
${bullets(rules.hook)}
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
${bullets(rules.graphics)}

효과음 (이 id만 쓴다. at_word가 있으면 그 낱말을 말할 때, 없으면 비트 안 위치 at 0~1. 휙 · 상승음은 장면이 바뀌는 순간에, 팝 · 클릭은 글자 · 그래픽이 나올 때 둔다):
${palette}

절대 규칙:
- 대본 · 컨셉 · 화면에 없는 사실(숫자 · 효과 · 성분)을 지어내지 않는다. 체험담처럼 들리는 말을 대본에 없이 지어내지 않는다.
- 효과를 단정하지 않는다. 최고 · 유일 · 100% 같은 단정을 쓰지 않는다. em dash를 쓰지 않는다.
- 구간은 촬영본 길이 안에서만 고른다. 같은 구간을 두 번 쓰지 않는다.
- warnings에는 사람이 확인할 문제만 시각과 함께 쓴다(카드대로 못 한 것과 그 이유 포함).
- warnings는 사람이 화면에서 읽는 글이다. 해요체로 짧게 쓴다("~할 수 없다" 대신 "~하지 못했어요"). 칸 이름 · 값(top · lower · mid · hook · beat · captions · look · tts · text_places 같은 영어)과 비트 · 후킹 같은 내부 용어를 쓰지 않고 위 · 가운데 · 아래, 장면, 첫 화면 글자, 자막, 읽는 말이라고 쓴다.
- 숫자와 데이터를 설명할 때 구어를 쓰지 않는다: 세요 → 집계해요, (AI가 이미지 · 영상을) 읽어요 → 분석해요, 뺐어요 → 제외했어요, 돌아요 → 실행돼요.`;
}
