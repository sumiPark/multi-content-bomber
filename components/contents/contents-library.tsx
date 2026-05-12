"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Trash2, X as XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { RelativeTime } from "@/components/ui/relative-time";
import { ScrollArea } from "@/components/ui/scroll-area";
import { deleteContentsAction } from "@/app/(dashboard)/actions";

export interface ContentItem {
  id: string;
  media_urls: string[];
  caption_preview: string;
  updated_at: string;
  created_by: string | null;
  internal_title: string | null;
}

interface Props {
  items: ContentItem[];
  thumbsByPath: Record<string, string>;
  currentUserId: string;
  pageLimit: number;
}

export function ContentsLibrary({
  items,
  thumbsByPath,
  currentUserId,
  pageLimit,
}: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const allIds = useMemo(() => items.map((i) => i.id), [items]);
  const allSelected = selected.size > 0 && selected.size === allIds.length;
  const someSelected = selected.size > 0 && !allSelected;

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === allIds.length ? new Set() : new Set(allIds),
    );
  }

  function runDelete(ids: string[], confirmMessage: string) {
    if (ids.length === 0) return;
    if (!window.confirm(confirmMessage)) return;
    startTransition(async () => {
      setActionMessage(null);
      const result = await deleteContentsAction({ contentIds: ids });
      if (result.ok) {
        setActionMessage(`${result.deleted}건 삭제됨`);
        setSelected(new Set());
        router.refresh();
      } else {
        setActionMessage(result.error);
      }
    });
  }

  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-muted-foreground">
          아직 만든 콘텐츠가 없어요.
          <br />
          대시보드에서 첫 콘텐츠를 만들어보세요.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {actionMessage && (
        <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
          {actionMessage}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/20 px-3 py-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = someSelected;
            }}
            onChange={toggleAll}
            className="size-4 rounded border-input"
            disabled={isPending}
          />
          <span className="text-muted-foreground">
            {selected.size > 0
              ? `${selected.size}건 선택됨`
              : `전체 선택 (${items.length}건${items.length === pageLimit ? "+" : ""})`}
          </span>
        </label>
        <div className="flex items-center gap-2">
          {selected.size > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set())}
              disabled={isPending}
            >
              <XIcon className="size-3" /> 해제
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              runDelete(
                Array.from(selected),
                `선택한 ${selected.size}건을 삭제할까요? 미디어 파일도 함께 삭제되며 되돌릴 수 없습니다.`,
              )
            }
            disabled={selected.size === 0 || isPending}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="size-3.5" /> 선택 삭제
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              runDelete(
                allIds,
                `전체 ${allIds.length}건을 삭제할까요? 미디어 파일도 함께 삭제되며 되돌릴 수 없습니다.`,
              )
            }
            disabled={allIds.length === 0 || isPending}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="size-3.5" /> 전체 삭제
          </Button>
        </div>
      </div>

      <ScrollArea className="h-[calc(100vh-280px)] rounded-md">
        <ul className="space-y-3 pr-3">
          {items.map((c) => {
            const captionPreview = c.caption_preview;
            const internal = c.internal_title;
            const thumbUrl = c.media_urls[0]
              ? thumbsByPath[c.media_urls[0]]
              : undefined;
            const isMine = c.created_by === currentUserId;
            const isSelected = selected.has(c.id);

            return (
              <li key={c.id}>
                <Card
                  className={
                    isSelected
                      ? "border-primary/50 bg-primary/5 transition"
                      : "transition hover:bg-accent/40"
                  }
                >
                  <CardContent className="flex gap-3 p-4">
                    <div className="flex items-start pt-1">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleOne(c.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="size-4 rounded border-input"
                        disabled={isPending}
                        aria-label="선택"
                      />
                    </div>
                    <Link
                      href={`/?content=${c.id}`}
                      className="flex min-w-0 flex-1 gap-4"
                    >
                      <div className="relative size-24 shrink-0 overflow-hidden rounded-md border bg-muted">
                        {thumbUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={thumbUrl}
                            alt=""
                            className="size-full object-cover"
                          />
                        ) : null}
                        {c.media_urls.length > 1 && (
                          <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1.5 py-0.5 text-xs font-medium text-white">
                            +{c.media_urls.length - 1}
                          </span>
                        )}
                      </div>
                      <div className="flex min-w-0 flex-1 flex-col justify-between">
                        <div className="space-y-1">
                          {internal ? (
                            <p className="line-clamp-1 text-sm font-medium">
                              {internal}
                            </p>
                          ) : null}
                          <p
                            className={
                              internal
                                ? "line-clamp-1 text-xs text-muted-foreground"
                                : "line-clamp-2 text-sm"
                            }
                          >
                            {captionPreview || (
                              <span className="text-muted-foreground">
                                (캡션 없음)
                              </span>
                            )}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <RelativeTime iso={c.updated_at} />
                          {!isMine && (
                            <Badge variant="outline" className="font-normal">
                              다른 멤버
                            </Badge>
                          )}
                        </div>
                      </div>
                    </Link>
                    <div className="flex items-start">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() =>
                          runDelete(
                            [c.id],
                            "이 콘텐츠를 삭제할까요? 미디어 파일도 함께 삭제되며 되돌릴 수 없습니다.",
                          )
                        }
                        disabled={isPending}
                        className="text-muted-foreground hover:text-destructive"
                        title="삭제"
                        aria-label="삭제"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      </ScrollArea>
    </div>
  );
}
