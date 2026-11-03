// 계정 점검 — 프로필 점수(profile_reviews, 0034)의 JSON 칸 모양. 화면과 워커가 같이 쓴다.

/** 사람이 넣는 것 — API에 없거나(하이라이트 · 고정 · 스토리 · 연락 · 카테고리) API가 안 줄 때(이름 칸 · 소개 · 링크). */
export interface ProfileManualInput {
  highlights?: string[] | null;
  pinnedCount?: number | null;
  storyDaysPerWeek?: number | null;
  contact?: boolean | null;
  category?: string | null;
  name?: string | null;
  bio?: string | null;
  links?: string[] | null;
}

/** 채점에 쓴 프로필 — profile_ko.py 입력과 같은 이름(snake_case)으로 저장한다. */
export interface ProfileSnapshot {
  handle: string;
  name: string | null;
  bio: string | null;
  links: string[];
  account_type: string | null;
  category: string | null;
  contact: boolean | null;
  highlights: string[] | null;
  pinned_count: number | null;
  grid_covers: string[] | null;
  days_since_last_post: number | null;
  unanswered_comments: number | null;
  story_days_per_week: number | null;
  role_focus: "PRODUCT" | "PERSON" | null;
  followers_count: number | null;
  media_count: number | null;
  profile_picture_url: string | null;
  // 다시 채점할지 정하는 기준 (score-profile.ts profileFingerprint)
  fingerprint?: string;
  // 어디서 온 값인지 — 화면에서 "API" / "직접 입력" 표시
  source: Record<string, "api" | "manual">;
}

export const REVIEW_ITEM_IDS = [
  "name_field",
  "bio_first_line",
  "bio_body",
  "pinned_three",
  "link",
  "highlights",
  "grid_legibility",
  "photo",
  "handle",
  "category_contact",
  "recent_activity",
  "story_presence",
] as const;
export type ReviewItemId = (typeof REVIEW_ITEM_IDS)[number];

export interface ReviewItem {
  id: ReviewItemId;
  label: string;
  max: number;
  // null = 정보가 없어 채점 못 함 (0점으로 셈)
  score: number | null;
  // true = 규칙 채점(profile_ko.py), false = AI 판단 채점
  auto: boolean;
  findings: string[];
  reason?: string;
}

export interface ReviewRewrite {
  itemId: ReviewItemId;
  title: string;
  options: string[];
  why: string;
  warnings: string[];
}

export type ReviewStatus = "PENDING" | "RUNNING" | "DONE" | "FAILED";
