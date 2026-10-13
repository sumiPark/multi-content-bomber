"use client";

import { useEffect, useState } from "react";
import { Check, Loader2, MessageCircle } from "lucide-react";
import {
  listAccountMediaAction,
  type PickerMedia,
} from "@/app/(dashboard)/episode-alerts/actions";
import { Button } from "@/components/ui/button";
import { RelativeTime } from "@/components/ui/relative-time";
import { cn } from "@/lib/utils";
import { mediaTypeLabel } from "./labels";

// 인스타 계정의 최근 게시물 그리드. 여러 개를 고르면 고른 순서가 회차 순서가 된다.
export function MediaPicker({
  accountId,
  multiple,
  selected,
  onChange,
  lockedLabel,
}: {
  accountId: string;
  multiple: boolean;
  selected: string[];
  onChange: (ids: string[]) => void;
  // 고를 수 없는 게시물(예: 이미 이 시리즈의 회차)과 그 이유.
  lockedLabel?: (media: PickerMedia) => string | null;
}) {
  const [items, setItems] = useState<PickerMedia[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(after: string | null) {
    setLoading(true);
    setError(null);
    const result = await listAccountMediaAction({ accountId, after });
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setItems((prev) => (after ? [...prev, ...result.items] : result.items));
    setCursor(result.nextCursor);
  }

  // 첫 페이지. 다이얼로그가 열릴 때마다 새로 마운트되므로 계정이 바뀌는 경우는 없다.
  useEffect(() => {
    let cancelled = false;
    listAccountMediaAction({ accountId, after: null }).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setItems(result.items);
      setCursor(result.nextCursor);
    });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  function toggle(id: string) {
    if (selected.includes(id)) {
      onChange(selected.filter((s) => s !== id));
    } else {
      onChange(multiple ? [...selected, id] : [id]);
    }
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-destructive">{error}</p>}

      {items.length === 0 && loading && (
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> 인스타 게시물을 불러오는 중…
        </div>
      )}
      {items.length === 0 && !loading && !error && (
        <p className="py-10 text-center text-sm text-muted-foreground">
          이 계정에 올린 게시물이 없어요.
        </p>
      )}

      {items.length > 0 && (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {items.map((m) => {
            const order = selected.indexOf(m.id);
            const isSelected = order >= 0;
            const locked = lockedLabel?.(m) ?? null;
            return (
              <li key={m.id} className="min-w-0">
                <button
                  type="button"
                  onClick={() => toggle(m.id)}
                  disabled={!!locked}
                  aria-pressed={isSelected}
                  className={cn(
                    "group relative block w-full overflow-hidden rounded-md border text-left transition",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    isSelected && "ring-2 ring-primary",
                    locked ? "cursor-not-allowed opacity-50" : "hover:border-foreground/40",
                  )}
                >
                  <div className="aspect-square w-full bg-muted">
                    {m.previewUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={m.previewUrl}
                        alt=""
                        loading="lazy"
                        className="size-full object-cover"
                      />
                    ) : (
                      <div className="grid size-full place-items-center text-xs text-muted-foreground">
                        {mediaTypeLabel(m.mediaType)}
                      </div>
                    )}
                  </div>
                  {isSelected && (
                    <span className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground shadow">
                      {multiple ? order + 1 : <Check className="size-3.5" />}
                    </span>
                  )}
                  <div className="space-y-0.5 p-1.5">
                    <p className="line-clamp-1 text-[11px] leading-tight">
                      {m.caption?.trim() || mediaTypeLabel(m.mediaType)}
                    </p>
                    <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      <RelativeTime iso={m.timestamp} format="date" />
                      {m.commentsCount !== null && (
                        <span className="inline-flex items-center gap-0.5">
                          <MessageCircle className="size-2.5" /> {m.commentsCount}
                        </span>
                      )}
                    </p>
                    {(locked || m.usedIn.length > 0) && (
                      <p className="line-clamp-1 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                        {locked ??
                          m.usedIn.map((u) => `${u.seriesName} ${u.episodeNo}화`).join(", ")}
                      </p>
                    )}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {cursor && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => load(cursor)} disabled={loading}>
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : null} 이전 게시물 더 보기
          </Button>
        </div>
      )}
    </div>
  );
}
