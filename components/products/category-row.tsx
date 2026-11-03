"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { updateCategoryAction } from "@/app/(dashboard)/products/actions";
import { KIND_LABEL, type ProductKind, type ShopCode } from "@/lib/products/shops";
import { cn } from "@/lib/utils";

export interface CategoryItem {
  shopCode: ShopCode;
  categoryId: number;
  name: string;
  collect: boolean;
  kind: ProductKind | null;
}

export function CategoryRow({
  item,
  depth,
  canManage,
}: {
  item: CategoryItem;
  depth: number;
  canManage: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function save(next: Partial<Pick<CategoryItem, "collect" | "kind">>) {
    startTransition(async () => {
      setError(null);
      const r = await updateCategoryAction({
        shopCode: item.shopCode,
        categoryId: item.categoryId,
        collect: next.collect ?? item.collect,
        kind: next.kind !== undefined ? next.kind : item.kind,
      });
      if (r.ok) router.refresh();
      else setError(r.error);
    });
  }

  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-sm" style={{ paddingLeft: 12 + depth * 20 }}>
      <label className="flex min-w-0 flex-1 items-center gap-2">
        <input
          type="checkbox"
          checked={item.collect}
          disabled={!canManage || isPending}
          onChange={(e) => save({ collect: e.target.checked })}
        />
        <span className={cn("truncate", !item.collect && "text-muted-foreground")}>{item.name}</span>
        <span className="text-[11px] text-muted-foreground">#{item.categoryId}</span>
      </label>
      <select
        value={item.kind ?? ""}
        disabled={!canManage || isPending || !item.collect}
        onChange={(e) => save({ kind: (e.target.value || null) as ProductKind | null })}
        className="h-7 rounded-md border bg-background px-1.5 text-xs"
        aria-label="상품 종류"
      >
        <option value="">종류 없음</option>
        {Object.entries(KIND_LABEL).map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </select>
      {error && <span className="w-full text-xs text-destructive">{error}</span>}
    </li>
  );
}
