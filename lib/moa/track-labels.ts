// 유입 경로 이름 (lib/moa/track.ts detectSource 값). 화면(클라이언트)에서도 쓰려고 서버 전용 파일과 나눴다.
export const SOURCE_LABEL: Record<string, string> = {
  instagram: "인스타그램",
  threads: "스레드",
  facebook: "페이스북",
  kakao: "카카오톡",
  youtube: "유튜브",
  naver: "네이버",
  direct: "직접 · 알 수 없음",
  other: "기타",
};
