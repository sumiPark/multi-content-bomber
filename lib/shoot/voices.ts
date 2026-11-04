// 계정별로 고를 수 있는 Fish Audio 목소리. 화면(서버 · 클라이언트)과 워커가 같이 읽는다.
// 사용자가 무료 모델에서 들어 보고 고른 목소리만 넣는다. 라이선스가 확인된 목소리만 넣고, 실존 인물을 복제한 목소리는 넣지 않는다.
// 모델은 여기 두지 않는다. 무료 모델 고정 값은 .claude/skills/ig-edit-ko/kit.json 한 곳에 있다.

export interface VoiceChoice {
  id: string;
  title: string;
}

export const VOICE_CHOICES: VoiceChoice[] = [{ id: "46939387dd944a45a399bd92b8de52cb", title: "20대 여지_내돈내산 쇼츠" }];

/** 목록에 있는 목소리만 통과시킨다. 없거나 비었으면 null(기본 목소리). */
export function voiceIdOf(saved: string | null | undefined): string | null {
  const id = saved?.trim();
  return id && VOICE_CHOICES.some((v) => v.id === id) ? id : null;
}
