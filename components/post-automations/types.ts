// 댓글 · DM 자동화 화면이 서버 페이지에서 받는 데이터 형태.
import type { ProductOption } from "@/app/(dashboard)/post-automations/actions";
import type { AutomationConfig } from "@/lib/post-automations/config";

export type AutomationStatus = "WAITING" | "ACTIVE" | "PAUSED" | "ENDED";
export type PausedReason = "MANUAL" | "SOLDOUT" | "ACCOUNT" | "PUBLISH_FAILED";
export type FirstCommentStatus = "NONE" | "PENDING" | "SENT" | "FAILED";
export type AutomationSource = "MENU" | "WIZARD" | "SHOOT";

/** 설정 하나의 누적 집계 (post_automation_events · post_automation_links) */
export interface AutomationStats {
  /** 반응 대상 — 건너뛴 이유(skip_reason)가 없는 기록 */
  target: number;
  dmSent: number;
  replySent: number;
  /** DM 결과 모름(UNKNOWN) — 사람 확인 필요 */
  unknown: number;
  /** DM · 답글 · 두 번째 DM 중 하나라도 실패 */
  failed: number;
  skipped: number;
  /** DM 버튼 클릭 합계 (MCB 주소로 집계) */
  clicks: number;
}

export type ProductView = ProductOption;

export interface AutomationView {
  id: string;
  status: AutomationStatus;
  pausedReason: PausedReason | null;
  platformPostId: string | null;
  permalink: string | null;
  caption: string | null;
  postedAt: string | null;
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
  productId: string | null;
  publishJobId: string | null;
  contentId: string | null;
  source: AutomationSource;
  config: AutomationConfig;
  firstStatus: FirstCommentStatus;
  firstAt: string | null;
  firstError: string | null;
  stats: AutomationStats;
}

export interface TemplateView {
  id: string;
  name: string;
  config: AutomationConfig;
}

export interface AccountView {
  id: string;
  name: string | null;
  isActive: boolean;
  /** 진행 중 탭(ACTIVE · PAUSED · WAITING) 설정 수 */
  liveCount: number;
}
