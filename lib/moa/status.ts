import type { MoaBlockView, MoaPageView } from "./types";

// 모아링크 화면 표시 판정 — 관리자 켜짐 + 공개 기간 + 판매 상태 (기획서 2장).
// 판매 상태는 광고 랜딩 기준(landingStatus): 목록에 안 보이는 광고 전용 상품도 링크로 살 수 있으면 판매 중.

export type SaleDisplay =
  | { kind: "normal" }
  | { kind: "gray"; label: string } // 회색 + 문구, 구매 버튼 꺼짐
  | { kind: "hidden"; label: string };

// 판매 상태 → 기본 표시. 조회 전(null) · 알 수 없음(unknown) · 등급 · 앱 제한(restricted)은 품절로 단정하지 않는다.
export function saleDisplay(landingStatus: string | null, hideSoldOut: boolean): SaleDisplay {
  switch (landingStatus) {
    case "sold_out":
      return hideSoldOut ? { kind: "hidden", label: "품절" } : { kind: "gray", label: "품절" };
    case "suspended":
    case "sale_ended":
      return hideSoldOut ? { kind: "hidden", label: "판매 종료" } : { kind: "gray", label: "판매 종료" };
    case "not_open":
      return hideSoldOut ? { kind: "hidden", label: "오픈 예정" } : { kind: "gray", label: "오픈 예정" };
    case "deleted":
      return { kind: "hidden", label: "몰에서 삭제됨" };
    default:
      return { kind: "normal" };
  }
}

/** 관리 화면에 띄울 판매 상태 이름 */
export const LANDING_STATUS_LABEL: Record<string, string> = {
  on_sale: "판매 중",
  sold_out: "품절",
  suspended: "판매 중지",
  sale_ended: "판매 기간 끝",
  not_open: "오픈 전",
  deleted: "몰에서 삭제됨",
  restricted: "등급 · 선물 전용",
  unknown: "확인 필요",
};

/** 조회가 연속으로 이만큼 실패하면 관리 화면에 "확인 실패"로 알린다 */
export const STATUS_FAIL_ALERT = 3;

export function inSchedule(b: Pick<MoaBlockView, "startsAt" | "endsAt">, now: number): boolean {
  if (b.startsAt && Date.parse(b.startsAt) > now) return false;
  if (b.endsAt && Date.parse(b.endsAt) <= now) return false;
  return true;
}

export interface VisibleBlock extends MoaBlockView {
  sale: SaleDisplay;
}

/**
 * 공개 페이지에 그릴 블록 — 메인 목록과 자동 구역 카드로 나눈다.
 * 자동 구역 카드: 고정 먼저, 그다음 최근 소개 순, 페이지 상한(autoLimit)까지(고정은 상한과 상관없이).
 */
export function visibleBlocks(page: MoaPageView, now: number) {
  const shown: VisibleBlock[] = [];
  for (const b of page.blocks) {
    if (!b.enabled || !inSchedule(b, now)) continue;
    const sale: SaleDisplay = b.shopCode ? saleDisplay(b.product?.landingStatus ?? null, page.hideSoldOut) : { kind: "normal" };
    if (sale.kind === "hidden") continue;
    shown.push({ ...b, sale });
  }
  const main = shown.filter((b) => !b.inAutoSection).sort((a, b) => a.position - b.position);
  const autoAll = shown
    .filter((b) => b.inAutoSection && b.kind === "PRODUCT")
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.surfacedAt) - Date.parse(a.surfacedAt));
  const pinned = autoAll.filter((b) => b.pinned);
  const rest = autoAll.filter((b) => !b.pinned).slice(0, Math.max(0, page.autoLimit - pinned.length));
  return { main, auto: [...pinned, ...rest] };
}

export function formatPrice(price: number | null): string | null {
  return price == null ? null : `${price.toLocaleString("ko-KR")}원`;
}
