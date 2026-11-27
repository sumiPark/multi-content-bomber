"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Reorder } from "framer-motion";
import {
  Eye,
  EyeOff,
  GripVertical,
  Heading,
  Image as ImageIcon,
  Link2,
  MessageCircle,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Sparkles,
  Store,
  Trash2,
} from "lucide-react";
import { deleteBlock, reorderBlocks, toggleBlock } from "@/app/(dashboard)/moa/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { toast } from "@/components/ui/toast";
import { LANDING_STATUS_LABEL, STATUS_FAIL_ALERT, formatPrice, saleDisplay } from "@/lib/moa/status";
import { BLOCK_KIND_LABEL, SOCIAL_LABEL, type MoaBlockKind, type MoaBlockView, type MoaPageView } from "@/lib/moa/types";
import { cn } from "@/lib/utils";
import { BlockForm, type BlockFormTarget } from "./block-form";

// 블록 목록 — 끌어서 순서 바꾸기 · 켜기/끄기 · 고치기 · 지우기.
// "최근 소개한 상품" 구역 안 카드는 최근 소개 순(고정 먼저)이라 끌기 대신 고정으로 위에 둔다.

const KIND_ICON: Record<MoaBlockKind, typeof Store> = {
  PRODUCT: Store,
  LINK: Link2,
  BANNER: ImageIcon,
  HEADING: Heading,
  SOCIAL: MessageCircle,
  AUTO_SECTION: Sparkles,
};

const ADDABLE: Exclude<MoaBlockKind, "AUTO_SECTION">[] = ["PRODUCT", "LINK", "BANNER", "HEADING", "SOCIAL"];

function blockName(b: MoaBlockView): string {
  if (b.kind === "SOCIAL") return (b.data.items ?? []).map((i) => i.label || SOCIAL_LABEL[i.type]).join(" · ") || "버튼 없음";
  if (b.kind === "PRODUCT") return b.title || b.product?.name || `상품 ${b.shopProductId}`;
  if (b.kind === "AUTO_SECTION") return b.title || "최근 소개한 상품";
  return b.title || b.subtitle || b.url || BLOCK_KIND_LABEL[b.kind];
}

function scheduleBadge(b: MoaBlockView, now: number): string | null {
  if (b.startsAt && Date.parse(b.startsAt) > now) return `${new Date(b.startsAt).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 공개 예정`;
  if (b.endsAt && Date.parse(b.endsAt) <= now) return "공개 기간 끝";
  if (b.endsAt) return `${new Date(b.endsAt).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}까지`;
  return null;
}

export function BlockList({ page, organizationId, canManage }: { page: MoaPageView; organizationId: string; canManage: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [form, setForm] = useState<BlockFormTarget | null>(null);
  const [removing, setRemoving] = useState<MoaBlockView | null>(null);
  const [adding, setAdding] = useState(false);
  // 미리보기와 상태 배지가 같은 시각을 쓰게 한 번만 잰다
  const [now] = useState(() => Date.now());

  const main = page.blocks.filter((b) => !b.inAutoSection).sort((a, b) => a.position - b.position);
  const mainKey = main.map((b) => b.id).join(",");
  const [order, setOrder] = useState(main.map((b) => b.id));
  // 서버에서 목록이 바뀌면(추가 · 삭제 · 저장 후 새로고침) 끌기 순서를 다시 맞춘다
  const [syncedKey, setSyncedKey] = useState(mainKey);
  if (syncedKey !== mainKey) {
    setSyncedKey(mainKey);
    setOrder(mainKey ? mainKey.split(",") : []);
  }
  const byId = new Map(page.blocks.map((b) => [b.id, b]));

  const auto = page.blocks
    .filter((b) => b.inAutoSection)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.surfacedAt) - Date.parse(a.surfacedAt));
  // 상한을 넘어 안 보이는 카드 (고정 제외, 켜져 있고 판매 상태로 숨지 않은 것 기준)
  let shownUnpinned = 0;
  const pinnedCount = auto.filter((b) => b.pinned && b.enabled).length;
  const overLimit = new Set<string>();
  for (const b of auto) {
    if (b.pinned || !b.enabled) continue;
    if (saleDisplay(b.product?.landingStatus ?? null, page.hideSoldOut).kind === "hidden") continue;
    shownUnpinned++;
    if (shownUnpinned > Math.max(0, page.autoLimit - pinnedCount)) overLimit.add(b.id);
  }

  const run = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>, done: string) => {
    start(async () => {
      const res = await fn();
      if (!res.ok) return toast(res.error, "risk");
      toast(done);
      router.refresh();
    });
  };

  const saveOrder = () => {
    if (order.join(",") === mainKey) return;
    run(() => reorderBlocks({ pageId: page.id, blockIds: order }), "순서를 저장했어요.");
  };

  const row = (b: MoaBlockView, opts: { draggable: boolean; nested?: boolean }) => {
    const Icon = KIND_ICON[b.kind];
    const sale = b.shopCode ? saleDisplay(b.product?.landingStatus ?? null, page.hideSoldOut) : null;
    const schedule = scheduleBadge(b, now);
    const price = b.kind === "PRODUCT" ? formatPrice(b.product?.price ?? null) : null;
    return (
      <div className={cn("flex items-center gap-2.5 px-3 py-2.5", !b.enabled && "opacity-60")}>
        {opts.draggable && canManage ? (
          <GripVertical className="size-4 shrink-0 cursor-grab text-faint" aria-label="끌어서 순서 바꾸기" />
        ) : (
          <span className="w-4 shrink-0" />
        )}
        {b.kind === "PRODUCT" && b.product?.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={b.imageUrl || b.product.imageUrl} alt="" className="size-9 shrink-0 rounded-md object-cover" />
        ) : (
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-surface-2 text-ink-2">
            <Icon className="size-4" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{blockName(b)}</p>
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            <span className="text-xs text-muted-foreground">{BLOCK_KIND_LABEL[b.kind]}</span>
            {price && <span className="text-xs text-muted-foreground tabular-nums">· {price}</span>}
            {b.source === "CONTENT" && <Badge variant="default">콘텐츠 연동</Badge>}
            {b.pinned && <Badge variant="default">고정</Badge>}
            {!b.enabled && <Badge variant="secondary">꺼짐</Badge>}
            {schedule && <Badge variant="secondary">{schedule}</Badge>}
            {sale && sale.kind !== "normal" && (
              <Badge variant={sale.kind === "hidden" ? "destructive" : "warn"}>
                {sale.label}
                {sale.kind === "hidden" && b.product?.landingStatus !== "deleted" ? " · 숨김" : ""}
              </Badge>
            )}
            {b.product?.landingStatus === "restricted" && <Badge variant="warn">{LANDING_STATUS_LABEL.restricted} · 확인 필요</Badge>}
            {b.product && b.product.failCount >= STATUS_FAIL_ALERT && <Badge variant="destructive">판매 상태 확인 실패</Badge>}
            {b.shopCode && !b.product?.checkedAt && <Badge variant="secondary">판매 상태 확인 전</Badge>}
            {overLimit.has(b.id) && <Badge variant="secondary">개수 상한 넘어 안 보임</Badge>}
          </div>
        </div>
        {canManage && (
          <div className="flex shrink-0 items-center">
            {b.inAutoSection && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={b.pinned ? "고정 풀기" : "맨 위 고정"}
                title={b.pinned ? "고정 풀기" : "맨 위 고정"}
                disabled={pending}
                onClick={() => run(() => toggleBlock({ blockId: b.id, pinned: !b.pinned }), b.pinned ? "고정을 풀었어요." : "맨 위에 고정했어요.")}
              >
                {b.pinned ? <PinOff /> : <Pin />}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={b.enabled ? "끄기" : "켜기"}
              title={b.enabled ? "끄기(숨김)" : "켜기"}
              disabled={pending}
              onClick={() => run(() => toggleBlock({ blockId: b.id, enabled: !b.enabled }), b.enabled ? "껐어요. 방문자에게 안 보여요." : "켰어요.")}
            >
              {b.enabled ? <Eye /> : <EyeOff />}
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="고치기" title="고치기" onClick={() => setForm({ mode: "edit", block: b })}>
              <Pencil />
            </Button>
            {b.kind !== "AUTO_SECTION" && (
              <Button variant="ghost" size="icon-sm" aria-label="지우기" title="지우기" onClick={() => setRemoving(b)}>
                <Trash2 />
              </Button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">위에서부터 페이지에 보이는 순서예요. 끌어서 바꾸면 바로 저장돼요.</p>
        {canManage && (
          <div className="relative">
            <Button onClick={() => setAdding((v) => !v)} aria-expanded={adding}>
              <Plus /> 블록 추가
            </Button>
            {adding && (
              <div className="absolute right-0 z-20 mt-1 w-60 rounded-lg border bg-card p-1 shadow-[0_8px_24px_rgb(16_24_40/.12),0_2px_6px_rgb(16_24_40/.08)]">
                {ADDABLE.map((k) => {
                  const Icon = KIND_ICON[k];
                  return (
                    <button
                      key={k}
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-muted"
                      onClick={() => {
                        setAdding(false);
                        setForm({ mode: "add", kind: k });
                      }}
                    >
                      <Icon className="size-4 text-ink-2" /> {BLOCK_KIND_LABEL[k]}
                    </button>
                  );
                })}
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => {
                    setAdding(false);
                    setForm({ mode: "add", kind: "PRODUCT", inAutoSection: true });
                  }}
                >
                  <Sparkles className="size-4 text-ink-2" /> 최근 소개한 상품에 추가
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <Reorder.Group axis="y" values={order} onReorder={setOrder} className="divide-y rounded-lg border bg-card">
        {order.map((id) => {
          const b = byId.get(id);
          if (!b) return null;
          return (
            <Reorder.Item key={id} value={id} dragListener={canManage} onDragEnd={saveOrder} className="bg-card first:rounded-t-lg last:rounded-b-lg">
              {row(b, { draggable: true })}
              {b.kind === "AUTO_SECTION" && (
                <div className="mx-3 mb-3 rounded-md border border-dashed bg-surface-2/60">
                  {auto.length === 0 ? (
                    <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                      아직 상품이 없어요. 콘텐츠 연동을 붙이면 발행한 상품이 여기에 자동으로 쌓여요. 지금은 “블록 추가 → 최근 소개한 상품에 추가”로 직접 넣을 수 있어요.
                    </p>
                  ) : (
                    <div className="divide-y">
                      {auto.map((a) => (
                        <div key={a.id}>{row(a, { draggable: false, nested: true })}</div>
                      ))}
                    </div>
                  )}
                  <p className="border-t px-3 py-2 text-xs text-muted-foreground">
                    최근 소개 순, 고정한 카드 먼저. 고정 외 최대 {page.autoLimit}개까지 보여요(설정에서 바꿀 수 있어요).
                  </p>
                </div>
              )}
            </Reorder.Item>
          );
        })}
        {order.length === 0 && <p className="px-3 py-8 text-center text-sm text-muted-foreground">블록이 없어요.</p>}
      </Reorder.Group>

      {form && <BlockForm pageId={page.id} organizationId={organizationId} target={form} onClose={() => setForm(null)} />}

      <ConfirmDialog
        open={!!removing}
        title="이 블록을 지울까요?"
        confirmLabel="지우기"
        danger
        pending={pending}
        onConfirm={() => {
          const b = removing;
          if (!b) return;
          setRemoving(null);
          run(() => deleteBlock({ blockId: b.id }), "지웠어요. 지난 통계는 남아 있어요.");
        }}
        onClose={() => setRemoving(null)}
      >
        <p className="text-sm text-ink-2">
          “{removing ? blockName(removing) : ""}”을(를) 페이지에서 지워요. 잠시 숨기려면 지우는 대신 끄기(눈 아이콘)를 써 주세요.
        </p>
      </ConfirmDialog>
    </div>
  );
}
