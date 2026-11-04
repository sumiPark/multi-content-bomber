import Link from "next/link";
import { redirect } from "next/navigation";
import { Film } from "lucide-react";
import { ReviewCard, type ReviewCardData } from "@/components/shoot/review-card";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import type { ProductKind } from "@/lib/products/shops";
import type { ContentRule } from "@/lib/rules/check";
import { certifiedFunctionsOf, finalBlocking } from "@/lib/shoot/final-check";
import { deleteNoticeDays, POSTED_KEEP_DAYS, shootFilesDeleteAt, UNPOSTED_KEEP_DAYS } from "@/lib/shoot/retention";
import { AutoRefresh } from "@/components/ui/auto-refresh";

// 완성본 받기 — 직접 찍은 영상을 AI가 편집한 완성본과 다시 편집용 파일을 받아, 사람이 고쳐서 직접 올린다.
// 올린 뒤 "올렸어요"로 릴스를 연결하면 기획별 성과를 볼 수 있다. 자동 예약은 하지 않는다.
// 광고 문구 규칙 · 판매 상태에 걸리면 경고를 확인해야 받을 수 있다(2026-11-04 사용자 결정).

export const metadata = { title: "완성본 받기 | MCB" };

type Cut = { no: number; on_screen: string; on_screen_override?: string | null; subtitle_override?: string | null; skipped?: boolean };
type Edit = {
  seconds?: number;
  thumbnail?: string | null;
  editedAt?: string | null;
  segments?: { cut: number; onScreen: string; subtitles: { text: string }[] }[];
  check?: { issues?: { kind: string; detail: string }[] };
};
type Proposal = { ideas?: { title: string }[]; chosen?: number | null };

// 렌더 함수 밖에서 현재 시각을 읽는다(react-hooks/purity)
function nowMs(): number {
  return Date.now();
}

export default async function ShootReviewPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");
  const canManage = profile.role === "ADMIN" || profile.role === "MANAGER";
  const supabase = await getServerSupabase();
  const now = nowMs();

  const { data: rows } = await supabase
    .from("content_plans")
    .select(
      "id, status, product_id, script, proposal, warnings_ack, posted_at, posted_permalink, social_accounts(display_name), products(name, kind, stock_status, represent_image_url, product_analyses(health_functional, summary)), shoot_requests(id, status, rendered_path, edit, cuts, clips, error, updated_at)",
    )
    .eq("track", "A")
    .in("status", ["SHOT", "RENDERED", "PUBLISHED"])
    .order("created_at", { ascending: true });
  // 보관 기간 안의 올린 기록만 — 그 뒤 기록은 분석에서 본다
  const plans = (rows ?? []).filter((p) => p.status !== "PUBLISHED" || !!p.shoot_requests?.rendered_path || ((p.shoot_requests?.clips ?? []) as unknown[]).length > 0);

  const productIds = [...new Set(plans.map((p) => p.product_id).filter((x): x is string => !!x))];
  const [{ data: ruleRows }, { data: approvals }] = await Promise.all([
    supabase.from("content_rules").select("id, scope, rule_type, phrase, match_type, reason, suggestion").eq("active", true),
    productIds.length ? supabase.from("product_claim_approvals").select("product_id, claim").in("product_id", productIds) : Promise.resolve({ data: [] }),
  ]);
  const rules: ContentRule[] = (ruleRows ?? []).map((r) => ({
    id: r.id,
    scope: r.scope as ContentRule["scope"],
    ruleType: r.rule_type as ContentRule["ruleType"],
    phrase: r.phrase,
    matchType: r.match_type as ContentRule["matchType"],
    reason: r.reason,
    suggestion: r.suggestion,
  }));

  const paths = plans.flatMap((p) => {
    const r = p.shoot_requests;
    const thumb = (r?.edit as Edit | null)?.thumbnail;
    return [r?.rendered_path, thumb].filter((x): x is string => !!x);
  });
  const { data: signed } = paths.length ? await supabase.storage.from("media").createSignedUrls(paths, 6 * 3600) : { data: [] };
  const urlOf = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]));

  const cards: ReviewCardData[] = plans.map((p) => {
    const r = p.shoot_requests;
    const edit = (r?.edit ?? {}) as Edit;
    const caption = ((p.script ?? {}) as { caption?: { text: string } }).caption?.text ?? "";
    const segments = edit.segments ?? [];
    const cuts = (r?.cuts ?? []) as Cut[];
    const editFailed = p.status === "SHOT" && r?.status === "FAILED";
    const blocking =
      (p.status === "RENDERED" || editFailed) && p.products
        ? finalBlocking(
            { caption, onScreen: segments.map((s) => s.onScreen), subtitles: segments.flatMap((s) => s.subtitles.map((t) => t.text)) },
            {
              kind: (p.products.kind ?? "OTHER") as ProductKind,
              rules,
              approvedClaims: (approvals ?? []).filter((a) => a.product_id === p.product_id).map((a) => a.claim),
              stockStatus: p.products.stock_status,
              healthFunctional: (() => {
                const a = p.products.product_analyses as unknown;
                const row = (Array.isArray(a) ? a[0] : a) as { health_functional?: boolean | null } | null;
                return row?.health_functional ?? null;
              })(),
              certifiedFunctions: certifiedFunctionsOf(p.products.product_analyses),
            },
          )
        : [];
    const acked = new Set((p.warnings_ack ?? []) as string[]);
    const proposal = (p.proposal ?? {}) as Proposal;
    const hasFiles = !!r?.rendered_path || ((r?.clips ?? []) as unknown[]).length > 0;
    return {
      planId: p.id,
      requestId: r?.id ?? null,
      requestStatus: r?.status ?? null,
      account: p.social_accounts?.display_name ?? "",
      status: p.status,
      productName: p.products?.name ?? "",
      ideaTitle: proposal.ideas?.[proposal.chosen ?? 0]?.title ?? null,
      videoUrl: r?.rendered_path ? (urlOf.get(r.rendered_path) ?? null) : null,
      posterUrl: edit.thumbnail ? (urlOf.get(edit.thumbnail) ?? null) : null,
      hasFinal: !!r?.rendered_path,
      seconds: edit.seconds ?? null,
      caption,
      skippedCuts: cuts.filter((c) => c.skipped).map((c) => c.no),
      cuts: cuts.filter((c) => !c.skipped).map((c) => {
        const seg = segments.find((s) => s.cut === c.no);
        return {
          no: c.no,
          onScreen: seg?.onScreen ?? c.on_screen_override ?? c.on_screen,
          subtitle: c.subtitle_override ?? (seg?.subtitles.map((t) => t.text).join(" ") || null),
        };
      }),
      blocking,
      warnings: (edit.check?.issues ?? []).filter((i) => i.kind !== "rules" && i.kind !== "stock").map((i) => i.detail),
      acked: blocking.every((b) => acked.has(b)),
      error: r?.error ?? null,
      postedAt: p.posted_at,
      postedPermalink: p.posted_permalink,
      filesGone: !hasFiles,
      deleteInDays: r ? deleteNoticeDays(shootFilesDeleteAt({ postedAt: p.posted_at, editedAt: edit.editedAt, updatedAt: r.updated_at }), now) : null,
    };
  });

  const waiting = cards.filter((c) => c.status !== "PUBLISHED");
  const posted = cards.filter((c) => c.status === "PUBLISHED").reverse();
  const toGet = cards.filter((c) => c.status === "RENDERED").length;

  return (
    <main className="space-y-6 p-4 sm:p-6">
      <AutoRefresh active={cards.some((c) => c.status === "SHOT" && c.requestStatus !== "FAILED")} />
      <header>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold tracking-[-0.01em]">완성본 받기</h1>
          {toGet > 0 && <Badge>받을 것 {toGet}개</Badge>}
        </div>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          직접 찍은 영상을 AI가 편집한 완성본이에요. <b>받아서 고친 뒤 인스타 앱이나 콘텐츠 생성에서 직접 올리고, ‘올렸어요’로 릴스를 연결</b>해 주세요. 자동으로 올라가지 않아요. 지금은 배경 음악 없이 촬영 원본 소리로 편집해요. 파일은 올린 뒤 {POSTED_KEEP_DAYS}일, 안 올리면 편집 뒤 {UNPOSTED_KEEP_DAYS}일까지 보관해요.
        </p>
      </header>

      {cards.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Film className="size-10 text-muted-foreground" />
            <h2 className="text-base font-semibold">받을 완성본이 없어요</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              <Link href="/shoot/uploads" className="underline">
                촬영 · 올리기
              </Link>
              에서 컷을 다 올리면 몇 분 뒤 여기에 완성본이 생겨요.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {waiting.length > 0 && (
            <div className="space-y-4">
              {waiting.map((c) => (
                <ReviewCard key={c.planId} card={c} canManage={canManage} />
              ))}
            </div>
          )}
          {posted.length > 0 && (
            <section className="space-y-3" aria-label="올린 영상">
              <h2 className="text-base font-semibold">
                올린 영상 <span className="text-xs font-medium text-muted-foreground tabular-nums">{posted.length}개</span>
              </h2>
              {posted.map((c) => (
                <ReviewCard key={c.planId} card={c} canManage={canManage} />
              ))}
            </section>
          )}
        </>
      )}
    </main>
  );
}
