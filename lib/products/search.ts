import {
  KIND_LABEL,
  SHOPS,
  type ProductKind,
  type ShopCode,
} from "@/lib/products/shops";
import type { createServiceClient } from "@/lib/supabase/service";

// 사람이 상품을 직접 찾는 검색(직접 촬영 "원하는 상품 추가" · AI 자동 칸 "상품 직접 찾기") 공통.
// 예전엔 쓸 상품 종류를 차례로 찾아 합친 뒤 앞 12개만 보여 줘서, 오늘과일 식품이 늘자(2026-11-10, 821개)
// 앞 종류가 자리를 다 차지해 뒤 종류 · 뒤쪽 상품이 안 나왔다(2026-11-12). 이제 종류별로 묶고, 묶음 안에서
// 이름이 검색어에 가까운 순서로 정렬해 묶음마다 앞 PER_GROUP개를 보여 준다.

type Service = ReturnType<typeof createServiceClient>;

export interface SearchHit {
  id: string;
  name: string;
  price: number | null;
  image: string | null;
  oneLine: string | null;
}

export interface SearchGroup {
  label: string;
  /** 검색어에 걸린 상품 수(판매 중 · 분석 완료) — 보여 주는 수보다 많으면 화면이 더 자세히 입력하라고 안내한다 */
  total: number;
  hits: SearchHit[];
}

const PER_GROUP = 12;
// 정렬 후보로 받는 수 — 이보다 많이 걸리면 받은 것 안에서만 정렬한다(총 개수는 따로 집계)
const FETCH = 80;

/** 맨 앞의 [가정용] · (특가) 같은 꼬리표를 떼고 소문자로 */
const normalize = (s: string) =>
  s.replace(/^(\s*[[(（【][^\])）】]*[\])）】]\s*)+/, "").toLowerCase();

/** 낮을수록 검색어에 가깝다: 같음 0 · 이름이 검색어로 시작 1 · 단어가 검색어로 시작 2 · 그 밖에 포함 3 */
function matchRank(name: string, query: string): number {
  const n = normalize(name);
  const q = query.toLowerCase();
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (n.split(/[\s/·,+&()[\]]+/).some((w) => w.startsWith(q))) return 2;
  return 3;
}

export async function searchScopedProducts(
  service: Service,
  scopes: { shop: string; kind: string }[],
  query: string,
  /** 받은 후보 중 빼야 할 id(예: 심의 문구 없는 건강기능식품) */
  exclude: (ids: string[]) => Promise<Set<string>> = async () => new Set(),
): Promise<SearchGroup[]> {
  const pattern = `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const groups = await Promise.all(
    scopes.map(async (scope) => {
      const { data, count, error } = await service
        .from("products")
        .select(
          "id, name, price, represent_image_url, product_analyses(summary)",
          { count: "exact" },
        )
        .eq("shop_code", scope.shop)
        .eq("kind", scope.kind)
        .eq("stock_status", "available")
        .eq("excluded", false)
        .eq("analysis_state", "ready")
        .ilike("name", pattern)
        .limit(FETCH);
      if (error) throw new Error(`상품 찾기 실패: ${error.message}`);
      const rows = data ?? [];
      const dropped = await exclude(rows.map((p) => p.id));
      const hits = rows
        .filter((p) => !dropped.has(p.id))
        .map((p) => ({ p, rank: matchRank(p.name, query) }))
        .sort(
          (a, b) =>
            a.rank - b.rank ||
            a.p.name.length - b.p.name.length ||
            a.p.name.localeCompare(b.p.name),
        )
        .map(({ p }) => p)
        .slice(0, PER_GROUP)
        .map((p) => ({
          id: p.id,
          name: p.name,
          price: p.price,
          image: p.represent_image_url,
          oneLine:
            (p.product_analyses?.summary as { oneLine?: string } | null)
              ?.oneLine ?? null,
        }));
      const shop = SHOPS[scope.shop as ShopCode]?.name ?? scope.shop;
      // 뺀 후보만큼 총 개수에서도 뺀다(받은 범위 안에서 확인한 만큼)
      return {
        label: `${shop} ${KIND_LABEL[scope.kind as ProductKind] ?? scope.kind}`,
        total: Math.max(hits.length, (count ?? rows.length) - dropped.size),
        hits,
      };
    }),
  );
  return groups.filter((g) => g.hits.length > 0);
}
