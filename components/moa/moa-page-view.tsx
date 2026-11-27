import type { CSSProperties, ReactNode } from "react";
import { AtSign, BookOpen, Globe, Mail, MessageCircle, Music2, Phone, Play, Store } from "lucide-react";
import { formatPrice, visibleBlocks, type VisibleBlock } from "@/lib/moa/status";
import { FONT_STACK, radiusPx, themeColors } from "@/lib/moa/theme";
import { SOCIAL_LABEL, type MoaPageView, type SocialType } from "@/lib/moa/types";

// 모아링크 공개 페이지 본문. 공개 주소(app/m/[slug])와 편집 화면 미리보기가 같이 쓴다.
// 훅을 쓰지 않는 컴포넌트라 서버 · 클라이언트 어디서나 그린다. 방문 · 노출 · 클릭 기록은 MoaTracker가 따로 붙인다.
//   linkBase: 블록을 누르면 가는 기록용 주소 앞부분("/r" 또는 "/api/moa/r"). null이면 링크를 걸지 않는다(미리보기).

const SOCIAL_ICON: Record<SocialType, typeof Globe> = {
  instagram: AtSign,
  youtube: Play,
  threads: AtSign,
  tiktok: Music2,
  kakao: MessageCircle,
  blog: BookOpen,
  email: Mail,
  phone: Phone,
  link: Globe,
};

export function MoaPageView({
  page,
  now,
  linkBase,
  emptyHint,
}: {
  page: MoaPageView;
  now: number;
  linkBase: string | null;
  /** 미리보기에서 보이는 블록이 없을 때 띄울 안내 */
  emptyHint?: string;
}) {
  const t = page.theme;
  const c = themeColors(t);
  const r = radiusPx(t.radius);
  const { main, auto } = visibleBlocks(page, now);

  const style = {
    "--moa-bg": t.background,
    "--moa-text": c.text,
    "--moa-muted": c.muted,
    "--moa-card": c.card,
    "--moa-line": c.line,
    "--moa-accent": t.accent,
    "--moa-on-accent": c.onAccent,
    "--moa-btn-r": r.button,
    "--moa-card-r": r.card,
    fontFamily: FONT_STACK[t.font],
    backgroundColor: t.background,
    backgroundImage: t.backgroundImage ? `url("${t.backgroundImage}")` : undefined,
    backgroundSize: "cover",
    backgroundPosition: "center",
    color: c.text,
  } as CSSProperties;

  const href = (blockId: string) => (linkBase ? `${linkBase}/${blockId}` : undefined);

  const buttonClass =
    t.buttonStyle === "fill"
      ? "bg-[var(--moa-accent)] text-[var(--moa-on-accent)]"
      : t.buttonStyle === "soft"
        ? "bg-[color-mix(in_srgb,var(--moa-accent)_14%,var(--moa-card))] text-[var(--moa-text)]"
        : "border-2 border-[var(--moa-accent)] bg-transparent text-[var(--moa-text)]";

  const renderBlock = (b: VisibleBlock): ReactNode => {
    switch (b.kind) {
      case "HEADING":
        return (
          <div key={b.id} className="px-1 pt-4 text-center">
            {b.title && <h2 className="text-lg font-bold">{b.title}</h2>}
            {b.subtitle && <p className="mt-1 text-sm whitespace-pre-line text-[var(--moa-muted)]">{b.subtitle}</p>}
          </div>
        );
      case "LINK":
        return (
          <Tap key={b.id} id={b.id} href={href(b.id)} className={`flex min-h-14 items-center gap-3 rounded-[var(--moa-btn-r)] px-4 py-3 ${buttonClass}`}>
            {b.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={b.imageUrl} alt="" className="size-10 shrink-0 rounded-[calc(var(--moa-btn-r)/2)] object-cover" />
            )}
            <span className="min-w-0 flex-1 text-center">
              <span className="block text-base font-semibold">{b.title || "링크"}</span>
              {b.subtitle && <span className="block text-xs opacity-75">{b.subtitle}</span>}
            </span>
            {b.imageUrl && <span className="size-10 shrink-0" aria-hidden />}
          </Tap>
        );
      case "BANNER": {
        const gray = b.sale.kind === "gray";
        return (
          <Tap
            key={b.id}
            id={b.id}
            href={gray ? undefined : href(b.id)}
            className="relative block overflow-hidden rounded-[var(--moa-card-r)] border border-[var(--moa-line)] bg-[var(--moa-card)]"
          >
            {b.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={b.imageUrl} alt={b.title} className={`block w-full ${gray ? "opacity-50 grayscale" : ""}`} />
            ) : (
              <div className="grid h-28 place-items-center text-sm text-[var(--moa-muted)]">배너 이미지</div>
            )}
            {b.sale.kind === "gray" && <SaleBadge label={b.sale.label} />}
            {(b.title || b.subtitle) && (
              <div className="px-4 py-3">
                {b.title && <p className="text-sm font-semibold">{b.title}</p>}
                {b.subtitle && <p className="text-xs text-[var(--moa-muted)]">{b.subtitle}</p>}
              </div>
            )}
          </Tap>
        );
      }
      case "PRODUCT":
        return <ProductCard key={b.id} b={b} href={href(b.id)} buttonClass={buttonClass} layout="list" />;
      case "SOCIAL": {
        const items = b.data.items ?? [];
        if (items.length === 0) return null;
        return (
          <div key={b.id} className="flex flex-wrap justify-center gap-2 py-1">
            {items.map((item, i) => {
              const Icon = SOCIAL_ICON[item.type];
              const label = item.label || SOCIAL_LABEL[item.type];
              return linkBase ? (
                <a
                  key={i}
                  href={`${linkBase}/${b.id}?i=${i}`}
                  data-moa-block={b.id}
                  data-moa-click
                  className="inline-flex h-10 items-center gap-1.5 rounded-full border border-[var(--moa-line)] bg-[var(--moa-card)] px-3.5 text-sm font-medium"
                >
                  <Icon className="size-4" aria-hidden />
                  {label}
                </a>
              ) : (
                <span key={i} className="inline-flex h-10 items-center gap-1.5 rounded-full border border-[var(--moa-line)] bg-[var(--moa-card)] px-3.5 text-sm font-medium">
                  <Icon className="size-4" aria-hidden />
                  {label}
                </span>
              );
            })}
          </div>
        );
      }
      case "AUTO_SECTION": {
        if (auto.length === 0) return null;
        const grid = b.data.layout === "grid";
        return (
          <section key={b.id} data-moa-block={b.id} className="pt-2">
            <h2 className="mb-2 px-1 text-base font-bold">{b.title || "최근 소개한 상품"}</h2>
            <div className={grid ? "grid grid-cols-2 gap-2.5" : "grid gap-2.5"}>
              {auto.map((p) => (
                <ProductCard key={p.id} b={p} href={href(p.id)} buttonClass={buttonClass} layout={grid ? "grid" : "list"} />
              ))}
            </div>
          </section>
        );
      }
    }
  };

  const rendered = main.map(renderBlock).filter(Boolean);

  return (
    <div style={style} className="min-h-full">
      <div className="mx-auto flex w-full max-w-[480px] flex-col gap-3 px-4 pt-10 pb-12">
        <header className="mb-2 flex flex-col items-center text-center">
          {page.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={page.avatarUrl} alt="" className="size-24 rounded-full border border-[var(--moa-line)] object-cover" />
          ) : (
            <div className="grid size-24 place-items-center rounded-full bg-[var(--moa-card)] text-2xl font-bold">
              {(page.title || page.slug).slice(0, 1)}
            </div>
          )}
          <h1 className="mt-3 text-xl font-bold">{page.title || `@${page.slug}`}</h1>
          {page.bio && <p className="mt-1.5 max-w-[360px] text-sm whitespace-pre-line text-[var(--moa-muted)]">{page.bio}</p>}
        </header>
        {rendered.length > 0 ? rendered : emptyHint ? <p className="py-10 text-center text-sm text-[var(--moa-muted)]">{emptyHint}</p> : null}
      </div>
    </div>
  );
}

function Tap({ id, href, className, children }: { id: string; href: string | undefined; className: string; children: ReactNode }) {
  if (!href) {
    return (
      <div data-moa-block={id} className={className}>
        {children}
      </div>
    );
  }
  return (
    <a href={href} data-moa-block={id} data-moa-click className={`${className} transition-transform active:scale-[0.99]`}>
      {children}
    </a>
  );
}

function SaleBadge({ label }: { label: string }) {
  return (
    <span className="absolute top-2 left-2 rounded-full bg-black/70 px-2.5 py-1 text-xs font-semibold text-white">{label}</span>
  );
}

function ProductCard({
  b,
  href,
  buttonClass,
  layout,
}: {
  b: VisibleBlock;
  href: string | undefined;
  buttonClass: string;
  layout: "list" | "grid";
}) {
  const gray = b.sale.kind === "gray";
  const name = b.title || b.product?.name || "상품";
  const image = b.imageUrl || b.product?.imageUrl;
  const price = formatPrice(b.product?.price ?? null);
  const button = b.sale.kind === "gray" ? b.sale.label : b.data.buttonLabel || "구매하기";

  if (layout === "grid") {
    return (
      <Tap id={b.id} href={gray ? undefined : href} className="relative flex flex-col overflow-hidden rounded-[var(--moa-card-r)] border border-[var(--moa-line)] bg-[var(--moa-card)]">
        <div className="relative aspect-square bg-[var(--moa-line)]">
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={image} alt="" className={`size-full object-cover ${gray ? "opacity-50 grayscale" : ""}`} />
          ) : (
            <Store className="absolute inset-0 m-auto size-8 opacity-40" aria-hidden />
          )}
          {b.sale.kind === "gray" && <SaleBadge label={b.sale.label} />}
        </div>
        <div className={`flex flex-1 flex-col gap-0.5 p-2.5 ${gray ? "opacity-60" : ""}`}>
          <p className="line-clamp-2 text-sm font-semibold">{name}</p>
          {price && <p className="text-sm font-bold tabular-nums">{price}</p>}
        </div>
      </Tap>
    );
  }

  return (
    <Tap id={b.id} href={gray ? undefined : href} className="relative flex items-center gap-3 rounded-[var(--moa-card-r)] border border-[var(--moa-line)] bg-[var(--moa-card)] p-2.5">
      <div className="relative size-20 shrink-0 overflow-hidden rounded-[calc(var(--moa-card-r)*0.6)] bg-[var(--moa-line)]">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt="" className={`size-full object-cover ${gray ? "opacity-50 grayscale" : ""}`} />
        ) : (
          <Store className="absolute inset-0 m-auto size-7 opacity-40" aria-hidden />
        )}
      </div>
      <div className={`min-w-0 flex-1 ${gray ? "opacity-60" : ""}`}>
        <p className="line-clamp-2 text-sm font-semibold">{name}</p>
        {b.subtitle && <p className="mt-0.5 line-clamp-1 text-xs text-[var(--moa-muted)]">{b.subtitle}</p>}
        {price && <p className="mt-1 text-sm font-bold tabular-nums">{price}</p>}
      </div>
      <span
        className={`shrink-0 rounded-[var(--moa-btn-r)] px-3 py-2 text-xs font-semibold ${gray ? "bg-[var(--moa-line)] text-[var(--moa-muted)]" : buttonClass}`}
      >
        {button}
      </span>
    </Tap>
  );
}
