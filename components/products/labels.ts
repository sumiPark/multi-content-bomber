// 상품 화면 공용 라벨 · 배지 색.

export const STOCK_LABEL: Record<string, string> = {
  available: "판매 중",
  temporarily_out: "일시 품절",
  discontinued: "판매 중지",
  unavailable: "노출 안 됨",
};

export const ANALYSIS_LABEL: Record<string, string> = {
  // 수집만 하고 아직 분석하지 않은 상품 — 쓰려고 고를 때 분석한다(0057)
  pending: "분석 전",
  queued: "분석 대기",
  analyzing: "분석 중",
  ready: "분석 완료",
  review: "확인 필요",
  insufficient: "근거 부족",
  failed: "분석 실패",
  skipped: "분석 안 함",
};

export const ANALYSIS_BADGE: Record<string, "secondary" | "outline" | "destructive" | "default"> = {
  pending: "outline",
  queued: "outline",
  analyzing: "outline",
  ready: "secondary",
  review: "default",
  insufficient: "outline",
  failed: "destructive",
  skipped: "outline",
};

/** 서버 · 클라이언트에서 같은 문자열이 나오게 로케일 없이 포맷. */
export function won(n: number | null): string {
  if (n == null) return "—";
  return `${n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}원`;
}
