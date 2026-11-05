// 계정별로 고를 수 있는 Fish Audio 목소리. 화면(서버 · 클라이언트)과 워커가 같이 읽는다.
// 사용자가 무료 모델에서 들어 보고 고른 목소리만 넣는다(2026-11-05 사용자 목록, title은 화면에 보이는 이름). 실존 인물을 복제한 목소리는 넣지 않는다.
// 모델은 여기 두지 않는다. 무료 모델 고정 값은 .claude/skills/ig-edit-ko/kit.json 한 곳에 있다.

export interface VoiceChoice {
  id: string;
  title: string;
}

export const VOICE_CHOICES: VoiceChoice[] = [
  { id: "46939387dd944a45a399bd92b8de52cb", title: "여성 · 솔직한 리뷰" },
  { id: "4e118bfbb83e401c84699c09b5f08257", title: "여성 · 나긋한 설명" },
  { id: "54f52a4d2b994612a30306b4a2a95758", title: "여성 · 인플루언서 톤" },
  { id: "120a8fd495b7416db5e6cb59acbb50b7", title: "여성 · 편안한 리뷰" },
  { id: "753e7e75671d4479a7aec0e574fbc353", title: "여성 · 친근한 살림 이야기" },
  { id: "03a79d68ca184930a1215f9b1b8eb5b5", title: "여성 · 성우 내레이션" },
  { id: "cf29a0584a4341259729577595fe96a3", title: "남성 · 경쾌한 쇼츠" },
  { id: "6bb94bd3a2414816a913b67dd340ef3a", title: "남성 · 캐주얼 릴스" },
  { id: "3fb0982238a342d9b2bac71413a62287", title: "남성 · 제품 소개" },
  { id: "50e39eaaf046410698c9f803f23474f3", title: "남성 · 인터뷰 진행" },
];

// 설정을 비워 둔 계정이 쓰는 기본 목소리. 실제 값은 kit.json의 voice.id와 같아야 한다
export const DEFAULT_VOICE_TITLE = "여성 · 나긋한 설명";

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
