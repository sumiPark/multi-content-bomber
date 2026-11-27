"use client";

import { useEffect, useState } from "react";
import { ImageIcon, LoaderCircle, MessageCircle } from "lucide-react";
import { listRecentPosts, type RecentPost } from "@/app/(dashboard)/post-automations/actions";
import { Badge } from "@/components/ui/badge";
import { PlatformIcon } from "@/components/ui/platform-icon";
import { DialogHeader, DialogShell, MonthDay, captionTitle } from "./shared";

// 게시물 고르기 — 계정의 최근 게시물 30개(인스타 조회). 켜진 게시물을 고르면 그 설정 수정으로 연다.
export function PostPicker({
  open,
  accountId,
  accountName,
  onClose,
  onPick,
}: {
  open: boolean;
  accountId: string;
  accountName: string | null;
  onClose: () => void;
  onPick: (post: RecentPost) => Promise<void> | void;
}) {
  return (
    <DialogShell open={open} onClose={onClose} label="게시물 고르기" widthClass="w-[min(760px,calc(100vw-24px))]">
      <DialogHeader
        icon={<PlatformIcon platform="INSTAGRAM" size={20} />}
        title="어떤 게시물에 켤까요?"
        sub={`@${(accountName ?? "").replace(/^@/, "")} · 최근 게시물 30개`}
        onClose={onClose}
      />
      {/* 열 때마다 새로 마운트돼 최신 목록을 다시 조회한다 */}
      <PickerBody key={accountId} accountId={accountId} onPick={onPick} />
    </DialogShell>
  );
}

function PickerBody({ accountId, onPick }: { accountId: string; onPick: (post: RecentPost) => Promise<void> | void }) {
  const [posts, setPosts] = useState<RecentPost[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listRecentPosts(accountId).then((r) => {
      if (cancelled) return;
      if (r.ok) setPosts(r.posts);
      else setError(r.error);
    });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  async function pick(p: RecentPost) {
    setPicking(p.id);
    try {
      await onPick(p);
    } finally {
      setPicking(null);
    }
  }

  return (
    <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
      {error ? (
        <p className="text-sm text-risk">{error}</p>
      ) : posts === null ? (
        <p className="flex items-center gap-1.5 py-8 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          인스타그램에서 최근 게시물을 조회하고 있어요
        </p>
      ) : posts.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">조회된 게시물이 없어요.</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-3">
          {posts.map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={!!picking}
              onClick={() => pick(p)}
              className="flex flex-col gap-1.5 rounded-lg border bg-card p-2 text-left transition-colors outline-none hover:border-primary focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait"
            >
              <span className="relative grid aspect-[3/4] w-full place-items-center overflow-hidden rounded-md bg-surface-2 text-muted-foreground">
                {p.previewUrl ? (
                  // 인스타 CDN 주소라 next/image 대신 img
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.previewUrl} alt="" className="size-full object-cover" loading="lazy" />
                ) : (
                  <ImageIcon className="size-8" />
                )}
                {p.automationId && <Badge variant="ok" className="absolute top-1.5 left-1.5">켜져 있음</Badge>}
                {picking === p.id && (
                  <span className="absolute inset-0 grid place-items-center bg-card/70">
                    <LoaderCircle className="size-6 animate-spin text-primary" />
                  </span>
                )}
              </span>
              <span className="truncate text-sm font-medium">{captionTitle(p.caption)}</span>
              <span className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
                <MonthDay iso={p.timestamp} />
                {p.commentsCount != null && (
                  <>
                    {" · "}
                    <MessageCircle className="size-3.5" />
                    {p.commentsCount}
                  </>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">켜져 있는 게시물을 고르면 설정 수정으로 열려요.</p>
    </div>
  );
}
