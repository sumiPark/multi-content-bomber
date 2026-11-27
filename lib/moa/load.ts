import type { ShopCode } from "@/lib/products/shops";
import type { createServiceClient } from "@/lib/supabase/service";
import type { Database } from "@/types/database";
import { parseTheme } from "./theme";
import { parseBlockData, type MoaBlockView, type MoaPageView, type MoaProductState } from "./types";

// 페이지 · 블록 · 상품 상태를 한 번에 읽어 화면 모양으로 바꾼다. 공개 페이지(캐시)와 편집 화면이 같이 쓴다.

type Service = ReturnType<typeof createServiceClient>;
type PageRow = Database["public"]["Tables"]["moa_pages"]["Row"];
type BlockRow = Database["public"]["Tables"]["moa_blocks"]["Row"];
type StatusRow = Database["public"]["Tables"]["moa_product_status"]["Row"];

export const productKey = (shop: string, id: number) => `${shop}:${id}`;

export function toBlockView(b: BlockRow, status: Map<string, StatusRow>): MoaBlockView {
  const s = b.shop_code && b.shop_product_id != null ? status.get(productKey(b.shop_code, b.shop_product_id)) : undefined;
  const product: MoaProductState | null = b.shop_code
    ? {
        name: s?.name ?? null,
        price: s?.price ?? null,
        imageUrl: s?.image_url ?? null,
        landingStatus: s?.landing_status ?? null,
        failCount: s?.fail_count ?? 0,
        checkedAt: s?.checked_at ?? null,
      }
    : null;
  return {
    id: b.id,
    kind: b.kind,
    position: b.position,
    inAutoSection: b.in_auto_section,
    pinned: b.pinned,
    enabled: b.enabled,
    startsAt: b.starts_at,
    endsAt: b.ends_at,
    title: b.title,
    subtitle: b.subtitle,
    url: b.url,
    imageUrl: b.image_url,
    shopCode: (b.shop_code as ShopCode | null) ?? null,
    shopProductId: b.shop_product_id,
    data: parseBlockData(b.data),
    source: b.source,
    surfacedAt: b.surfaced_at,
    product,
  };
}

export function toPageView(p: PageRow, blocks: MoaBlockView[]): MoaPageView {
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    bio: p.bio,
    avatarUrl: p.avatar_url,
    theme: parseTheme(p.theme),
    status: p.status,
    hideSoldOut: p.hide_sold_out,
    autoLimit: p.auto_limit,
    blocks,
  };
}

/** 블록들의 상품 상태를 읽는다 (몰 · 번호 쌍) */
export async function loadStatusMap(service: Service, blocks: Pick<BlockRow, "shop_code" | "shop_product_id">[]) {
  const map = new Map<string, StatusRow>();
  const byShop = new Map<string, number[]>();
  for (const b of blocks) {
    if (!b.shop_code || b.shop_product_id == null) continue;
    const list = byShop.get(b.shop_code) ?? [];
    list.push(b.shop_product_id);
    byShop.set(b.shop_code, list);
  }
  await Promise.all(
    [...byShop].map(async ([shop, ids]) => {
      const { data, error } = await service
        .from("moa_product_status")
        .select("*")
        .eq("shop_code", shop)
        .in("shop_product_id", [...new Set(ids)]);
      if (error) throw new Error(`상품 상태 조회 실패: ${error.message}`);
      for (const s of data ?? []) map.set(productKey(s.shop_code, s.shop_product_id), s);
    }),
  );
  return map;
}

/** 페이지 한 개 전체 (지운 블록 제외) */
export async function loadPageView(service: Service, page: PageRow): Promise<MoaPageView> {
  const { data: blocks, error } = await service
    .from("moa_blocks")
    .select("*")
    .eq("page_id", page.id)
    .is("deleted_at", null)
    .order("position", { ascending: true });
  if (error) throw new Error(`블록 조회 실패: ${error.message}`);
  const status = await loadStatusMap(service, blocks ?? []);
  return toPageView(page, (blocks ?? []).map((b) => toBlockView(b, status)));
}
