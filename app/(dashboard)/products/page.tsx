import Link from "next/link";
import { redirect } from "next/navigation";
import { Package, SlidersHorizontal } from "lucide-react";
import { collectProductsNowAction } from "@/app/(dashboard)/products/actions";
import { CollectNowButton } from "@/components/analytics/collect-now-button";
import {
  CollectionStatus,
  type FailedProduct,
  type WorkerRunRow,
} from "@/components/products/collection-status";
import { ANALYSIS_BADGE, ANALYSIS_LABEL, STOCK_LABEL, won } from "@/components/products/labels";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { RelativeTime } from "@/components/ui/relative-time";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { KIND_LABEL, SHOPS, SHOP_CODES, type ProductKind, type ShopCode } from "@/lib/products/shops";
import { cn } from "@/lib/utils";

// 상품 — 세 몰(오늘과일 · 쿠마마켓 · 리유) 상품과 상세페이지 분석 상태 (콘텐츠 자동화 2단계).
// 수집 · 분석은 products.yml 워커가 매일 03시에 한다. 여기서는 확인 · 승인 · 다시 분석 · 제외.

const PAGE_SIZE = 50;

type Supabase = Awaited<ReturnType<typeof getServerSupabase>>;

/** 수집 · 분석 워커의 마지막 실행 기록(0027)과 실패한 상품. */
async function loadRunStatus(supabase: Supabase) {
  const latest = (worker: string) =>
    supabase
      .from("worker_runs")
      .select("status, started_at, finished_at, summary, error, github_run_url")
      .eq("worker", worker)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
  const [{ data: collectRun }, { data: analyzeRun }, { data: failedRows }] = await Promise.all([
    latest("collect-products"),
    latest("analyze-products"),
    supabase
      .from("products")
      .select("id, name, analysis_error")
      .eq("analysis_state", "failed")
      .eq("excluded", false)
      .order("updated_at", { ascending: false })
      .limit(5),
  ]);
  const failed: FailedProduct[] = (failedRows ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    error: r.analysis_error ?? "",
  }));
  return {
    collectRun: (collectRun ?? null) as WorkerRunRow | null,
    analyzeRun: (analyzeRun ?? null) as WorkerRunRow | null,
    failed,
    // "실행 중"이 너무 오래됐는지(러너가 죽음) 판단할 기준 시각
    now: Date.now(),
  };
}

interface Search {
  shop?: string;
  kind?: string;
  state?: string;
  stock?: string;
  q?: string;
  page?: string;
}

export default async function ProductsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");
  const canManage = profile.role === "ADMIN" || profile.role === "MANAGER";

  const supabase = await getServerSupabase();

  // 상단 집계 — 몰당 수백 개라 상태 컬럼만 전부 읽어 센다.
  const stats: { shop_code: string; kind: string | null; analysis_state: string; stock_status: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase
      .from("products")
      .select("shop_code, kind, analysis_state, stock_status")
      .eq("excluded", false)
      .range(from, from + 999);
    stats.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const count = (f: (r: (typeof stats)[number]) => boolean) => stats.filter(f).length;
  const runStatus = await loadRunStatus(supabase);
  // 분석 대상 = 판매 중 + 분석하는 종류
  const target = stats.filter((r) => r.stock_status === "available" && r.analysis_state !== "skipped");
  const progress = {
    total: target.length,
    done: target.filter((r) => ["ready", "review", "insufficient"].includes(r.analysis_state)).length,
    // 분석 전 = 수집만 한 상품(쓰려고 고를 때 분석, 0057) · queued = 다시 분석 · 직접 고르기로 분석을 요청한 상품
    pending: target.filter((r) => r.analysis_state === "pending").length,
    queued: target.filter((r) => r.analysis_state === "queued").length,
    analyzing: target.filter((r) => r.analysis_state === "analyzing").length,
    failed: target.filter((r) => r.analysis_state === "failed").length,
  };

  // 목록
  // 기본 보기는 판매 중 — 분석 대상이 판매 중 상품뿐이라.
  const stock = sp.stock ?? "available";
  const page = Math.max(1, Number(sp.page ?? 1));
  let query = supabase
    .from("products")
    .select(
      "id, shop_code, shop_product_id, name, kind, category_name, price, stock_status, analysis_state, analysis_note, analysis_error, represent_image_url, excluded, updated_at",
      { count: "exact" },
    )
    .order("updated_at", { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (sp.shop && SHOP_CODES.includes(sp.shop as ShopCode)) query = query.eq("shop_code", sp.shop);
  if (sp.kind) query = query.eq("kind", sp.kind);
  if (sp.state) query = query.eq("analysis_state", sp.state);
  if (stock !== "all") query = query.eq("stock_status", stock);
  if (sp.q?.trim()) query = query.ilike("name", `%${sp.q.trim()}%`);
  const { data: rows, count: total } = await query;

  const hrefWith = (patch: Partial<Search>) => {
    const next = new URLSearchParams();
    const merged = { ...sp, stock, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) next.set(k, String(v));
    return `/products?${next.toString()}`;
  };
  const pages = Math.max(1, Math.ceil((total ?? 0) / PAGE_SIZE));

  return (
    <main className="space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold tracking-[-0.01em]">상품 분석</h1>
            <Badge variant="outline">오늘과일 · 쿠마마켓 · 리유</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            오늘과일 · 쿠마마켓 · 리유 상품을 매일 03시에 받아 오고, 판매 중인 상품의 상세페이지(이미지)를
            AI가 분석해 요약합니다. 건기식은 기능성 문구를 사람이 꼭 확인해요.
          </p>
        </div>
        <div className="flex items-start gap-2">
          <Link
            href="/products/categories"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1")}
          >
            <SlidersHorizontal className="size-4" /> 수집 카테고리
          </Link>
          {canManage && (
            <CollectNowButton
              action={collectProductsNowAction}
              doneText="수집을 시작했어요. 수집 2~3분 뒤 분석이 이어집니다."
            />
          )}
        </div>
      </header>

      <CollectionStatus {...runStatus} progress={progress} />

      {stats.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Package className="size-10 text-muted-foreground" />
            <h2 className="text-base font-semibold">아직 수집된 상품이 없어요</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              오른쪽 위 <b>지금 수집</b>을 누르거나 다음 03시 자동 수집을 기다리세요.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* 몰별 요약 */}
          <section className="grid gap-3 sm:grid-cols-3">
            {SHOP_CODES.map((code) => {
              const mine = (r: (typeof stats)[number]) => r.shop_code === code;
              const kinds = [...new Set(stats.filter(mine).map((r) => r.kind ?? "OTHER"))];
              return (
                <Link
                  key={code}
                  href={hrefWith({ shop: code, page: undefined })}
                  className={cn(
                    "rounded-lg border bg-card p-3 transition hover:bg-surface-2",
                    sp.shop === code && "ring-2 ring-primary",
                  )}
                >
                  <p className="text-sm font-semibold">{SHOPS[code].name}</p>
                  <p className="text-xs text-muted-foreground">
                    {kinds.map((k) => KIND_LABEL[k as ProductKind] ?? k).join(" · ") || "—"}
                  </p>
                  <p className="mt-2 text-xs tabular-nums">
                    판매 중 <b>{count((r) => mine(r) && r.stock_status === "available")}</b>
                    {" · "}전체 {count(mine)}
                  </p>
                  <p className="text-xs tabular-nums text-muted-foreground">
                    분석 완료 {count((r) => mine(r) && r.analysis_state === "ready")}
                    {" · "}확인 필요 {count((r) => mine(r) && r.analysis_state === "review")}
                    {" · "}분석 전 {count((r) => mine(r) && (r.analysis_state === "pending" || r.analysis_state === "queued") && r.stock_status === "available")}
                  </p>
                </Link>
              );
            })}
          </section>

          {/* 필터 — 서버 렌더 GET 폼 */}
          <form className="flex flex-wrap items-end gap-2 text-xs" action="/products">
            {sp.shop && <input type="hidden" name="shop" value={sp.shop} />}
            <Select name="kind" label="종류" value={sp.kind} options={Object.entries(KIND_LABEL)} />
            <Select name="state" label="분석" value={sp.state} options={Object.entries(ANALYSIS_LABEL)} />
            <Select
              name="stock"
              label="판매"
              value={stock}
              options={[...Object.entries(STOCK_LABEL), ["all", "전체"]]}
              noAll
            />
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">상품명</span>
              <input
                name="q"
                defaultValue={sp.q}
                className="h-8 w-48 rounded-md border bg-card px-2"
                placeholder="검색"
              />
            </label>
            <button className={buttonVariants({ size: "sm" })}>적용</button>
            {(sp.shop || sp.kind || sp.state || sp.q || sp.stock) && (
              <Link href="/products" className={buttonVariants({ variant: "ghost", size: "sm" })}>
                초기화
              </Link>
            )}
          </form>

          {/* 목록 */}
          <section className="overflow-hidden rounded-lg border bg-card">
            <div className="flex items-center justify-between border-b bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <span>{total ?? 0}개</span>
              <span>
                {page}/{pages}쪽
              </span>
            </div>
            {(rows ?? []).length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">조건에 맞는 상품이 없어요.</p>
            ) : (
              <ul className="divide-y">
                {(rows ?? []).map((p) => (
                  <li key={p.id}>
                    <Link href={`/products/${p.id}`} className="flex items-center gap-3 px-3 py-2 hover:bg-accent/30">
                      {p.represent_image_url ? (
                        // 몰 CDN 이미지 — next/image 도메인 설정 없이 그대로 쓴다.
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.represent_image_url} alt="" loading="lazy" className="size-12 shrink-0 rounded object-cover" />
                      ) : (
                        <div className="size-12 shrink-0 rounded bg-muted" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className={cn("truncate text-sm font-medium", p.excluded && "line-through opacity-60")}>
                          {p.name}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {SHOPS[p.shop_code as ShopCode]?.name ?? p.shop_code} · {KIND_LABEL[(p.kind ?? "OTHER") as ProductKind]}
                          {p.category_name && ` · ${p.category_name}`} · {won(p.price)} · {STOCK_LABEL[p.stock_status] ?? p.stock_status}
                        </p>
                        {(p.analysis_note || p.analysis_error) && (
                          <p className={cn("truncate text-xs", p.analysis_error ? "text-destructive" : "text-warn")}>
                            {/* 원본 이미지 주소는 목록에서 뺀다 — 상세에서 볼 수 있다 */}
                            {(p.analysis_error ?? p.analysis_note ?? "").replace(/:?\s*https?:\/\/\S+/g, "")}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <Badge variant={ANALYSIS_BADGE[p.analysis_state] ?? "outline"} className="text-xs">
                          {ANALYSIS_LABEL[p.analysis_state] ?? p.analysis_state}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          <RelativeTime iso={p.updated_at} format="date" />
                        </span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {pages > 1 && (
            <nav className="flex justify-center gap-2 text-sm">
              {page > 1 && (
                <Link href={hrefWith({ page: String(page - 1) })} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  이전
                </Link>
              )}
              {page < pages && (
                <Link href={hrefWith({ page: String(page + 1) })} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  다음
                </Link>
              )}
            </nav>
          )}
        </>
      )}
    </main>
  );
}

function Select({
  name,
  label,
  value,
  options,
  noAll,
}: {
  name: string;
  label: string;
  value?: string;
  options: string[][];
  noAll?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-muted-foreground">{label}</span>
      <select name={name} defaultValue={value ?? ""} className="h-8 rounded-md border bg-card px-2">
        {!noAll && <option value="">전체</option>}
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}
