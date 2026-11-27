import { z } from "zod";
import type { ShopCode } from "@/lib/products/shops";
import type { MoaTheme } from "./theme";

// 모아링크 공통 타입 (0063). 공개 페이지 · 편집 화면 미리보기 · 서버 액션이 같은 모양을 쓴다.

export type MoaBlockKind = "PRODUCT" | "LINK" | "BANNER" | "HEADING" | "SOCIAL" | "AUTO_SECTION";
export type MoaPageStatus = "DRAFT" | "PUBLISHED" | "PAUSED";

export const BLOCK_KIND_LABEL: Record<MoaBlockKind, string> = {
  PRODUCT: "상품 카드",
  LINK: "링크",
  BANNER: "이미지 배너",
  HEADING: "제목 · 설명",
  SOCIAL: "문의 · SNS 버튼",
  AUTO_SECTION: "최근 소개한 상품 구역",
};

export const PAGE_STATUS_LABEL: Record<MoaPageStatus, string> = {
  DRAFT: "비공개",
  PUBLISHED: "공개 중",
  PAUSED: "일시 중지",
};

// SOCIAL 블록의 버튼 종류
export const SOCIAL_TYPES = ["instagram", "youtube", "threads", "tiktok", "kakao", "blog", "email", "phone", "link"] as const;
export type SocialType = (typeof SOCIAL_TYPES)[number];
export const SOCIAL_LABEL: Record<SocialType, string> = {
  instagram: "인스타그램",
  youtube: "유튜브",
  threads: "스레드",
  tiktok: "틱톡",
  kakao: "카카오톡 채널",
  blog: "블로그",
  email: "이메일",
  phone: "전화",
  link: "링크",
};

export const socialItemSchema = z.object({
  type: z.enum(SOCIAL_TYPES),
  url: z.string().trim().min(1).max(500),
  label: z.string().trim().max(30).optional(),
});
export type SocialItem = z.infer<typeof socialItemSchema>;

// 블록 종류별 data 값
export const blockDataSchema = z
  .object({
    // SOCIAL
    items: z.array(socialItemSchema).max(12).optional(),
    // AUTO_SECTION · 상품 묶음 표시 방식
    layout: z.enum(["list", "grid"]).optional(),
    // 상품 카드 · 링크 버튼 문구 (비우면 기본값)
    buttonLabel: z.string().trim().max(20).optional(),
  })
  .catchall(z.unknown());
export type BlockData = z.infer<typeof blockDataSchema>;

export function parseBlockData(raw: unknown): BlockData {
  const r = blockDataSchema.safeParse(raw ?? {});
  return r.success ? r.data : {};
}

/** 상품 판매 상태 (moa_product_status) — 공개 페이지가 쓰는 만큼만 */
export interface MoaProductState {
  name: string | null;
  price: number | null;
  imageUrl: string | null;
  landingStatus: string | null;
  failCount: number;
  checkedAt: string | null;
}

export interface MoaBlockView {
  id: string;
  kind: MoaBlockKind;
  position: number;
  inAutoSection: boolean;
  pinned: boolean;
  enabled: boolean;
  startsAt: string | null;
  endsAt: string | null;
  title: string;
  subtitle: string;
  url: string | null;
  imageUrl: string | null;
  shopCode: ShopCode | null;
  shopProductId: number | null;
  data: BlockData;
  source: "MANUAL" | "CONTENT";
  surfacedAt: string;
  product: MoaProductState | null;
}

export interface MoaPageView {
  id: string;
  slug: string;
  title: string;
  bio: string;
  avatarUrl: string | null;
  theme: MoaTheme;
  status: MoaPageStatus;
  hideSoldOut: boolean;
  autoLimit: number;
  blocks: MoaBlockView[];
}
