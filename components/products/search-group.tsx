import type { SearchGroup } from "@/lib/products/search";

// 상품 직접 찾기 결과의 종류별 묶음 머리 · 더 있음 안내 (직접 촬영 · AI 자동 칸 공통)

export function SearchGroupHead({ group }: { group: SearchGroup }) {
  const more = group.total > group.hits.length;
  return (
    <p className="px-1.5 pb-1 text-xs font-semibold text-muted-foreground">
      {group.label}{" "}
      <span className="font-medium tabular-nums">
        {more
          ? `${group.total}개 중 ${group.hits.length}개`
          : `${group.total}개`}
      </span>
    </p>
  );
}

export function SearchMoreHint({ groups }: { groups: SearchGroup[] }) {
  if (!groups.some((g) => g.total > g.hits.length)) return null;
  return (
    <p className="text-xs text-muted-foreground">
      검색어에 맞는 상품이 많아 이름이 가까운 순서로 일부만 보여요. 이름을 더
      자세히 입력하면 좁혀져요.
    </p>
  );
}
