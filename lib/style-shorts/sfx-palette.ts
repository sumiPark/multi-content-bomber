// 스타일 쇼츠 효과음 — earshot 소리 묶음(252개) 가운데 숏폼 편집에 쓸 만한 것을 골라 둔 목록(사용자 결정 2026-11-19).
// 편집 에이전트는 이 id 중에서만 고르고, 워커가 earshot으로 그 자리에서 만든다(파일을 저장소에 두지 않는다).
// 직접 촬영 · AI 자동 영상은 지금처럼 kit.json 효과음을 쓴다. 이 목록은 스타일 쇼츠에만 쓴다.
// kind는 earshot timeline이 레퍼런스에서 찾은 분류(UI · WHOOSH · RISER · HIT …)와 맞춰, 카드의 효과음 비율대로 고르게 한다.

export interface PaletteSound {
  id: string;
  kind: "WHOOSH" | "UI" | "CLICK" | "HIT" | "RISER" | "BELL" | "KEY" | "GLITCH" | "DROP" | "FOLEY";
  use: string;
}

export const SFX_PALETTE: readonly PaletteSound[] = [
  { id: "swish/soft", kind: "WHOOSH", use: "부드러운 휙. 장면 전환 · 글자 등장" },
  { id: "swish/bright", kind: "WHOOSH", use: "밝고 짧은 휙. 빠른 전환" },
  { id: "whoosh_fast/crisp", kind: "WHOOSH", use: "또렷한 휙. 컷 전환" },
  { id: "whoosh_fast/tight", kind: "WHOOSH", use: "짧고 단단한 휙. 빠른 컷" },
  { id: "swipe/glide", kind: "WHOOSH", use: "미끄러지는 휙. 화면이 밀려 들어올 때" },
  { id: "swipe/paper", kind: "WHOOSH", use: "종이 넘기는 듯한 휙" },
  { id: "whoosh_big/thump_airy", kind: "WHOOSH", use: "묵직한 휙 + 쿵. 큰 글자 · 반전" },
  { id: "ui_pop/soft", kind: "UI", use: "둥근 팝. 칩 · 숫자 · 글자 등장" },
  { id: "ui_pop/blip", kind: "UI", use: "짧은 블립. 작은 표시 등장" },
  { id: "ui_pop/step", kind: "UI", use: "단계가 하나씩 나올 때" },
  { id: "pro_pop/bloop", kind: "UI", use: "말랑한 팝" },
  { id: "drip/plink", kind: "UI", use: "물방울 같은 플링. 귀여운 강조" },
  { id: "pro_click/soft", kind: "CLICK", use: "부드러운 클릭. 버튼 · 선택" },
  { id: "tap/finger", kind: "CLICK", use: "손가락 톡. 화면을 짚을 때" },
  { id: "knock/wood", kind: "CLICK", use: "나무 똑. 가벼운 강조" },
  { id: "toggle/on", kind: "CLICK", use: "스위치 딸깍" },
  { id: "shutter/snap", kind: "CLICK", use: "카메라 셔터. 멈춘 장면 · 순간 포착" },
  { id: "cut_hit/punch", kind: "HIT", use: "짧은 타격. 핵심 낱말 · 컷 강조" },
  { id: "pro_impact/short", kind: "HIT", use: "짧은 충격음. 반전 · 결과" },
  { id: "cut_hit/sub", kind: "HIT", use: "낮은 쿵. 무게감 있는 강조" },
  { id: "riser/snatch", kind: "RISER", use: "짧은 상승음. 공개 직전" },
  { id: "pro_riser/air_gate", kind: "RISER", use: "공기 상승음. 긴장을 올릴 때" },
  { id: "reverse_swell/short", kind: "RISER", use: "역재생 스웰. 컷 직전 빨아들임" },
  { id: "pro_notify/ding_2045", kind: "BELL", use: "맑은 딩. 정답 · 완성" },
  { id: "mallet/glock", kind: "BELL", use: "글로켄 음. 밝은 강조" },
  { id: "notify/mid_tine", kind: "BELL", use: "부드러운 딩. 확인" },
  { id: "pro_shimmer/m1", kind: "BELL", use: "반짝임. 깨끗함 · 완성" },
  { id: "pro_typing_run/soft", kind: "KEY", use: "타자 소리. 글자가 타이핑될 때" },
  { id: "glitch/mid", kind: "GLITCH", use: "글리치. 화면이 튀는 연출" },
  { id: "pro_sub_drop/quick", kind: "DROP", use: "떨어지는 저음. 분위기 전환" },
  { id: "fit/land.light/finger_wood", kind: "FOLEY", use: "손끝이 나무에 닿는 소리. 생활 소리" },
  { id: "fit/hit/bamboo_tok", kind: "FOLEY", use: "대나무 톡. 생활 소리" },
] as const;

export const SFX_IDS = SFX_PALETTE.map((s) => s.id) as [string, ...string[]];

export function paletteSound(id: string): PaletteSound | undefined {
  return SFX_PALETTE.find((s) => s.id === id);
}
