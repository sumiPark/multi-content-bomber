// 계정별로 고를 수 있는 Fish Audio 목소리. 화면(서버 · 클라이언트)과 워커가 같이 읽는다.
// 사용자가 무료 모델에서 들어 보고 고른 목소리만 넣는다. 라이선스가 확인된 목소리만 넣고, 실존 인물을 복제한 목소리는 넣지 않는다.
// 모델은 여기 두지 않는다. 무료 모델 고정 값은 .claude/skills/ig-edit-ko/kit.json 한 곳에 있다.

export interface VoiceChoice {
  id: string;
  title: string;
}

export const VOICE_CHOICES: VoiceChoice[] = [{ id: "46939387dd944a45a399bd92b8de52cb", title: "20대 여지_내돈내산 쇼츠" }];

// 무료 모델 제공 종료 예정일(안내 기준). 종료 7일 전부터 대시보드에 알린다(2026-11-05 사용자 결정).
export const FREE_VOICE_ENDS_ON = "2026-11-30";
const FREE_VOICE_NOTICE_DAYS = 7;
const DAY_MS = 24 * 3600_000;

/** 알릴 때가 아니면 null. now는 ms, 날짜는 KST 기준. */
export function freeVoiceNotice(now: number): { level: "error" | "warn"; message: string } | null {
  const today = new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
  const days = Math.round((Date.parse(FREE_VOICE_ENDS_ON) - Date.parse(today)) / DAY_MS);
  if (days > FREE_VOICE_NOTICE_DAYS) return null;
  if (days < 0) return { level: "error", message: `무료 음성 모델 제공 예정일(${FREE_VOICE_ENDS_ON})이 지났어요. 다음 음성 방법을 정해 주세요.` };
  return { level: "warn", message: `무료 음성 모델 제공이 ${days === 0 ? "오늘" : `${days}일 뒤`}(${FREE_VOICE_ENDS_ON}) 끝날 예정이에요. 다음 음성 방법을 정해 주세요.` };
}

/** 목록에 있는 목소리만 통과시킨다. 없거나 비었으면 null(기본 목소리). */
export function voiceIdOf(saved: string | null | undefined): string | null {
  const id = saved?.trim();
  return id && VOICE_CHOICES.some((v) => v.id === id) ? id : null;
}
