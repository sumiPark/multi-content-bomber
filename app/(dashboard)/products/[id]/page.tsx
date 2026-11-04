import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";
import {
  ProductActions,
  ProductReviewPanel,
  type ReviewClaim,
} from "@/components/products/product-review-panel";
import { ANALYSIS_BADGE, ANALYSIS_LABEL, STOCK_LABEL, won } from "@/components/products/labels";
import { Badge } from "@/components/ui/badge";
import { RelativeTime } from "@/components/ui/relative-time";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { KIND_LABEL, SHOPS, type ProductKind, type ShopCode } from "@/lib/products/shops";

// 상품 상세 — 상세페이지 원본 이미지와 AI가 받아 적은 글을 나란히 놓고, 요약 · 근거를 검수한다.

export default async function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");
  const canManage = profile.role === "ADMIN" || profile.role === "MANAGER";

  const supabase = await getServerSupabase();
  const [{ data: product }, { data: extracts }, { data: analysis }, { count: approvedClaimCount }] = await Promise.all([
    supabase.from("products").select("*").eq("id", id).maybeSingle(),
    supabase.from("product_image_extracts").select("image_url, image_index, text, uncertainties, part_count").eq("product_id", id),
    supabase.from("product_analyses").select("*").eq("product_id", id).maybeSingle(),
    supabase.from("product_claim_approvals").select("id", { count: "exact", head: true }).eq("product_id", id),
  ]);
  if (!product) notFound();

  const extractByUrl = new Map((extracts ?? []).map((e) => [e.image_url, e]));
  const summary = (analysis?.summary ?? null) as {
    oneLine?: string;
    usage?: string;
    cautions?: string;
    isKindMatch?: boolean;
    details?: Record<string, unknown>;
  } | null;
  const claims = (Array.isArray(analysis?.claims) ? analysis.claims : []) as unknown as ReviewClaim[];
  const rejected = (Array.isArray(analysis?.rejected_claims) ? analysis.rejected_claims : []) as unknown as ReviewClaim[];

  return (
    <main className="space-y-5 p-4 sm:p-6">
      <Link href="/products" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> 상품 목록
      </Link>

      <header className="flex flex-wrap items-start gap-4">
        {product.represent_image_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={product.represent_image_url} alt="" className="size-20 rounded-lg object-cover" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold">{product.name}</h1>
            <Badge variant={ANALYSIS_BADGE[product.analysis_state] ?? "outline"}>
              {ANALYSIS_LABEL[product.analysis_state] ?? product.analysis_state}
            </Badge>
            {product.excluded && <Badge variant="destructive">제외됨</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {SHOPS[product.shop_code as ShopCode]?.name} · {KIND_LABEL[(product.kind ?? "OTHER") as ProductKind]}
            {product.category_name && ` · ${product.category_name}`} · {won(product.price)} ·{" "}
            {STOCK_LABEL[product.stock_status] ?? product.stock_status}
          </p>
          {product.summary_title && <p className="mt-1 text-sm">{product.summary_title}</p>}
          {(product.analysis_note || product.analysis_error) && (
            <p className={product.analysis_error ? "mt-1 text-sm text-destructive" : "mt-1 text-sm text-warn"}>
              {product.analysis_error ?? product.analysis_note}
            </p>
          )}
        </div>
        <a
          href={product.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          몰에서 보기 <ExternalLink className="size-3.5" />
        </a>
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* 상세페이지 원본 ↔ 받아 적은 글 */}
        <section className="space-y-4">
          <h2 className="text-sm font-semibold text-muted-foreground">
            상세페이지 {product.detail_image_urls.length}장 — 왼쪽 원본, 오른쪽 AI가 받아 적은 글
          </h2>
          {product.detail_image_urls.length === 0 && (
            <p className="rounded-md border border-dashed bg-card p-6 text-center text-sm text-muted-foreground">상세 이미지가 없어요.</p>
          )}
          {product.detail_image_urls.map((url, i) => {
            const e = extractByUrl.get(url);
            return (
              <div key={url} className="grid gap-2 rounded-lg border bg-card p-2 md:grid-cols-2">
                <div className="max-h-[640px] overflow-y-auto rounded bg-muted/30">
                  <p className="sticky top-0 bg-card/90 px-2 py-1 text-xs text-muted-foreground">이미지 {i + 1}</p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={url} alt={`상세 이미지 ${i + 1}`} loading="lazy" className="w-full" />
                </div>
                <div className="max-h-[640px] overflow-y-auto rounded bg-muted/10 p-2">
                  {e ? (
                    <>
                      <p className="whitespace-pre-wrap text-xs leading-relaxed">{e.text || "(글자 없음 — 사진만 있는 이미지)"}</p>
                      {e.uncertainties.length > 0 && (
                        <p className="mt-2 text-xs text-warn">
                          확실하지 않음: {e.uncertainties.join(" · ")}
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">아직 분석하지 않은 이미지예요.</p>
                  )}
                </div>
              </div>
            );
          })}
        </section>

        {/* 요약 · 근거 · 검수 */}
        <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          {analysis && summary ? (
            <ProductReviewPanel
              productId={product.id}
              canManage={canManage}
              excluded={product.excluded}
              kind={(product.kind ?? "OTHER") as ProductKind}
              oneLine={summary.oneLine ?? ""}
              usage={summary.usage ?? ""}
              cautions={summary.cautions ?? ""}
              isKindMatch={summary.isKindMatch ?? null}
              details={summary.details ?? {}}
              claims={claims}
              rejected={rejected}
              healthFunctional={analysis.health_functional}
              functionalClaims={analysis.functional_claims}
              approvedClaimCount={approvedClaimCount ?? 0}
              uncertainties={analysis.uncertainties}
              edited={analysis.edited}
              approvedAt={analysis.approved_at}
              model={analysis.model}
              analyzedAt={analysis.analyzed_at}
            />
          ) : (
            <div className="space-y-3 rounded-lg border bg-card p-4 text-sm">
              <p className="text-muted-foreground">
                아직 요약이 없어요.{" "}
                {product.stock_status === "available"
                  ? "다음 분석 때 처리해요. 보통 매일 새벽에 실행돼요."
                  : "판매 중인 상품만 분석해서, 다시 판매되면 그때 분석해요."}
              </p>
              <ProductActions productId={product.id} canManage={canManage} excluded={product.excluded} hasAnalysis={false} />
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            몰 상품 번호 {product.shop_product_id} · 마지막 수집 <RelativeTime iso={product.last_seen_at} />
          </p>
        </aside>
      </div>
    </main>
  );
}
