import { unstable_cache } from "next/cache";
import { createServiceClient } from "@/lib/supabase/service";
import { loadPageView } from "./load";
import type { MoaPageView } from "./types";

// 공개 페이지 데이터 (캐시). 편집 · 판매 상태 변경 때 MOA_CACHE_TAG를 비운다(revalidateMoa).
// 공개 기간(starts_at · ends_at)은 캐시 밖에서 지금 시각으로 거르므로, 행사 배너는 캐시와 상관없이 제시간에 켜지고 꺼진다.

export const MOA_CACHE_TAG = "moa-pages";

export type PublicLookup =
  | { kind: "page"; page: MoaPageView }
  | { kind: "redirect"; slug: string }
  | { kind: "none" };

export const getPublicPage = unstable_cache(
  async (slug: string): Promise<PublicLookup> => {
    const service = createServiceClient();
    const { data: page } = await service.from("moa_pages").select("*").eq("slug", slug).maybeSingle();
    if (page) return { kind: "page", page: await loadPageView(service, page) };

    // 바뀐 주소 — 옛 주소로 들어오면 새 주소로 보낸다
    const { data: moved } = await service.from("moa_slug_redirects").select("page_id").eq("old_slug", slug).maybeSingle();
    if (moved) {
      const { data: target } = await service.from("moa_pages").select("slug").eq("id", moved.page_id).maybeSingle();
      if (target) return { kind: "redirect", slug: target.slug };
    }
    return { kind: "none" };
  },
  ["moa-public-page-v1"],
  { tags: [MOA_CACHE_TAG], revalidate: 300 },
);
