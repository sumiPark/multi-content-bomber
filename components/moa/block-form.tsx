"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Search, Trash2 } from "lucide-react";
import { addBlock, searchMoaProducts, updateBlock, type BlockFieldsInput, type ProductHit } from "@/app/(dashboard)/moa/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { SHOPS } from "@/lib/products/shops";
import { BLOCK_KIND_LABEL, SOCIAL_LABEL, SOCIAL_TYPES, type MoaBlockKind, type MoaBlockView, type SocialItem } from "@/lib/moa/types";
import { ImageField } from "./image-field";
import { Modal } from "./modal";

// 블록 추가 · 고치기 창. 종류마다 필요한 칸만 보여 준다.
//   상품: 이름 검색(수집한 상품) 또는 몰 상품 주소 붙여 넣기(광고 전용 상품도 됨)
//   공개 기간: 시작 · 종료 시각(비우면 항상). 행사 배너를 사람 손 없이 켜고 끈다.

export type BlockFormTarget =
  | { mode: "add"; kind: Exclude<MoaBlockKind, "AUTO_SECTION">; inAutoSection?: boolean }
  | { mode: "edit"; block: MoaBlockView };

interface Picked {
  shop: keyof typeof SHOPS;
  productId: number;
  name: string;
  image: string | null;
  statusLabel?: string;
}

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(v: string): string | null {
  return v ? new Date(v).toISOString() : null;
}

export function BlockForm({
  pageId,
  organizationId,
  target,
  onClose,
}: {
  pageId: string;
  organizationId: string;
  target: BlockFormTarget;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const edit = target.mode === "edit" ? target.block : null;
  const kind: MoaBlockKind = edit ? edit.kind : target.mode === "add" ? target.kind : "LINK";
  const inAuto = edit ? edit.inAutoSection : target.mode === "add" && !!target.inAutoSection;

  const [title, setTitle] = useState(edit?.title ?? "");
  const [subtitle, setSubtitle] = useState(edit?.subtitle ?? "");
  const [url, setUrl] = useState(edit?.url ?? "");
  const [imageUrl, setImageUrl] = useState<string | null>(edit?.imageUrl ?? null);
  const [startsAt, setStartsAt] = useState(toLocalInput(edit?.startsAt ?? null));
  const [endsAt, setEndsAt] = useState(toLocalInput(edit?.endsAt ?? null));
  const [buttonLabel, setButtonLabel] = useState(edit?.data.buttonLabel ?? "");
  const [layout, setLayout] = useState<"list" | "grid">(edit?.data.layout ?? "list");
  const [items, setItems] = useState<SocialItem[]>(edit?.data.items ?? [{ type: "instagram", url: "" }]);
  const [picked, setPicked] = useState<Picked | null>(
    edit?.shopCode && edit.shopProductId
      ? { shop: edit.shopCode, productId: edit.shopProductId, name: edit.product?.name ?? `상품 ${edit.shopProductId}`, image: edit.product?.imageUrl ?? null }
      : null,
  );
  // 배너는 주소 대신 상품과 연결할 수 있다(품절 규칙 적용)
  const [bannerTarget, setBannerTarget] = useState<"url" | "product">(kind === "BANNER" && edit?.shopCode ? "product" : "url");
  const [error, setError] = useState<string | null>(null);

  const titleText = edit ? `${BLOCK_KIND_LABEL[kind]} 고치기` : inAuto ? "최근 소개한 상품에 상품 추가" : `${BLOCK_KIND_LABEL[kind]} 추가`;

  const save = () => {
    setError(null);
    const fields: BlockFieldsInput = {
      title,
      subtitle,
      url: kind === "BANNER" && bannerTarget === "product" ? null : url || null,
      imageUrl,
      shop: (kind === "PRODUCT" || (kind === "BANNER" && bannerTarget === "product")) && picked ? picked.shop : null,
      productId: (kind === "PRODUCT" || (kind === "BANNER" && bannerTarget === "product")) && picked ? picked.productId : null,
      startsAt: fromLocalInput(startsAt),
      endsAt: fromLocalInput(endsAt),
      enabled: edit?.enabled ?? true,
      inAutoSection: inAuto,
      pinned: edit?.pinned ?? false,
      data: {
        ...(edit?.data ?? {}),
        ...(kind === "PRODUCT" || kind === "LINK" ? { buttonLabel: buttonLabel || undefined } : {}),
        ...(kind === "AUTO_SECTION" ? { layout } : {}),
        ...(kind === "SOCIAL" ? { items: items.filter((i) => i.url.trim()) } : {}),
      },
    };
    start(async () => {
      const res = edit
        ? await updateBlock({ blockId: edit.id, fields })
        : await addBlock({ pageId, kind: kind as Exclude<MoaBlockKind, "AUTO_SECTION">, fields });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast(edit ? "저장했어요." : "추가했어요.");
      onClose();
      router.refresh();
    });
  };

  return (
    <Modal
      open
      title={titleText}
      onClose={onClose}
      footer={
        <>
          {error && <p className="mr-auto self-center text-xs text-risk">{error}</p>}
          <Button variant="outline" onClick={onClose} disabled={pending}>
            취소
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending ? "저장 중…" : edit ? "저장" : "추가"}
          </Button>
        </>
      }
    >
      {(kind === "PRODUCT" || (kind === "BANNER" && bannerTarget === "product")) && (
        <ProductPicker picked={picked} onPick={setPicked} />
      )}

      {kind === "BANNER" && (
        <>
          <ImageField label="배너 이미지" value={imageUrl} onChange={setImageUrl} organizationId={organizationId} hint="가로로 긴 이미지를 권장해요(예: 1200×600). 5MB까지." />
          <div className="space-y-1.5">
            <p className="text-sm font-medium">누르면 갈 곳</p>
            <Segmented
              ariaLabel="배너 연결"
              value={bannerTarget}
              onChange={setBannerTarget}
              options={[
                { value: "url", label: "주소" },
                { value: "product", label: "몰 상품(품절 규칙 적용)" },
              ]}
            />
          </div>
          {bannerTarget === "url" && <Field label="주소" value={url} onChange={setUrl} placeholder="https://" />}
        </>
      )}

      {kind === "LINK" && (
        <>
          <Field label="버튼 이름" value={title} onChange={setTitle} placeholder="예시: 카카오톡 채널 문의" />
          <Field label="주소" value={url} onChange={setUrl} placeholder="https://" />
          <Field label="작은 설명 (선택)" value={subtitle} onChange={setSubtitle} />
          <ImageField label="작은 이미지 (선택)" value={imageUrl} onChange={setImageUrl} organizationId={organizationId} />
        </>
      )}

      {kind === "PRODUCT" && (
        <>
          <Field label="보일 이름 (비우면 몰 상품 이름)" value={title} onChange={setTitle} />
          <Field label="한 줄 소개 (선택)" value={subtitle} onChange={setSubtitle} placeholder="예시: 릴스에서 소개한 그 상품" />
          <Field label="버튼 문구 (비우면 “구매하기”)" value={buttonLabel} onChange={setButtonLabel} />
        </>
      )}

      {kind === "BANNER" && (
        <>
          <Field label="제목 (선택)" value={title} onChange={setTitle} />
          <Field label="설명 (선택)" value={subtitle} onChange={setSubtitle} />
        </>
      )}

      {kind === "HEADING" && (
        <>
          <Field label="제목" value={title} onChange={setTitle} placeholder="예시: 진행 중인 이벤트" />
          <div className="space-y-1.5">
            <Label>설명 (선택)</Label>
            <Textarea value={subtitle} onChange={(e) => setSubtitle(e.target.value)} rows={3} />
          </div>
        </>
      )}

      {kind === "AUTO_SECTION" && (
        <>
          <Field label="구역 제목" value={title} onChange={setTitle} placeholder="최근 소개한 상품" />
          <div className="space-y-1.5">
            <p className="text-sm font-medium">보이는 방식</p>
            <Segmented
              ariaLabel="상품 보이는 방식"
              value={layout}
              onChange={setLayout}
              options={[
                { value: "list", label: "한 줄씩" },
                { value: "grid", label: "두 칸 격자" },
              ]}
            />
          </div>
        </>
      )}

      {kind === "SOCIAL" && <SocialItems items={items} onChange={setItems} />}

      {kind !== "AUTO_SECTION" && kind !== "SOCIAL" && kind !== "HEADING" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>공개 시작 (선택)</Label>
            <Input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>공개 종료 (선택)</Label>
            <Input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-2">비우면 항상 보여요. 정한 시각이 되면 자동으로 켜지고 꺼져요.</p>
        </div>
      )}
    </Modal>
  );
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="placeholder:text-faint" />
    </div>
  );
}

function SocialItems({ items, onChange }: { items: SocialItem[]; onChange: (items: SocialItem[]) => void }) {
  const set = (i: number, patch: Partial<SocialItem>) => onChange(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">버튼</p>
      {items.map((it, i) => (
        <div key={i} className="flex gap-2">
          <select
            value={it.type}
            onChange={(e) => set(i, { type: e.target.value as SocialItem["type"] })}
            className="h-9 rounded-md border border-input bg-card px-2 text-sm"
            aria-label="종류"
          >
            {SOCIAL_TYPES.map((t) => (
              <option key={t} value={t}>
                {SOCIAL_LABEL[t]}
              </option>
            ))}
          </select>
          <Input
            value={it.url}
            onChange={(e) => set(i, { url: e.target.value })}
            placeholder={it.type === "email" ? "help@example.com" : it.type === "phone" ? "010-0000-0000" : "https://"}
            className="placeholder:text-faint"
          />
          <Button variant="ghost" size="icon" aria-label="버튼 빼기" onClick={() => onChange(items.filter((_, j) => j !== i))}>
            <Trash2 />
          </Button>
        </div>
      ))}
      {items.length < 12 && (
        <Button variant="outline" size="sm" onClick={() => onChange([...items, { type: "link", url: "" }])}>
          <Plus /> 버튼 추가
        </Button>
      )}
    </div>
  );
}

function ProductPicker({ picked, onPick }: { picked: Picked | null; onPick: (p: Picked) => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ProductHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const search = () => {
    setError(null);
    start(async () => {
      const res = await searchMoaProducts({ query });
      if (!res.ok) {
        setError(res.error);
        setHits(null);
        return;
      }
      setHits(res.hits);
    });
  };

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">상품</p>
      {picked && (
        <div className="flex items-center gap-3 rounded-md border bg-surface-2 p-2.5">
          {picked.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={picked.image} alt="" className="size-12 rounded-md object-cover" />
          ) : (
            <div className="size-12 rounded-md bg-surface-3" />
          )}
          <div className="min-w-0 text-sm">
            <p className="truncate font-medium">{picked.name}</p>
            <p className="text-xs text-muted-foreground">
              {SHOPS[picked.shop].name} · {picked.productId}
              {picked.statusLabel ? ` · ${picked.statusLabel}` : ""}
            </p>
          </div>
        </div>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
      >
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="상품 이름 또는 몰 상품 주소" className="placeholder:text-faint" />
        <Button type="submit" variant="outline" disabled={pending || !query.trim()}>
          <Search /> {pending ? "찾는 중…" : "찾기"}
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">광고 · 공구 전용 상품처럼 목록에 없는 상품은 몰 상품 주소(…/product/번호)를 붙여 넣어 주세요.</p>
      {error && <p className="text-xs text-risk">{error}</p>}
      {hits && hits.length === 0 && <p className="text-xs text-muted-foreground">찾은 상품이 없어요.</p>}
      {hits && hits.length > 0 && (
        <ul className="max-h-64 divide-y overflow-y-auto rounded-md border">
          {hits.map((h) => (
            <li key={`${h.shop}:${h.productId}`}>
              <button
                type="button"
                className="flex w-full items-center gap-3 px-2.5 py-2 text-left hover:bg-muted"
                onClick={() => {
                  onPick({ shop: h.shop, productId: h.productId, name: h.name, image: h.image, statusLabel: h.statusLabel });
                  setHits(null);
                }}
              >
                {h.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={h.image} alt="" className="size-10 rounded object-cover" />
                ) : (
                  <div className="size-10 rounded bg-surface-3" />
                )}
                <div className="min-w-0 flex-1 text-sm">
                  <p className="truncate">{h.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {h.shopName}
                    {h.price != null ? ` · ${h.price.toLocaleString("ko-KR")}원` : ""}
                  </p>
                </div>
                <span className={`text-xs ${h.onSale ? "text-ok" : "text-warn"}`}>{h.statusLabel}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
