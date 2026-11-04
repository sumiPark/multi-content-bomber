import Link from "next/link";
import { redirect } from "next/navigation";
import { Film } from "lucide-react";
import { ReviewCard, type ReviewCardData } from "@/components/shoot/review-card";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { isPastSlot } from "@/lib/automation/deadline";
import { kstDate } from "@/lib/automation/time";
import type { ProductKind } from "@/lib/products/shops";
import type { ContentRule } from "@/lib/rules/check";
import { finalBlocking } from "@/lib/shoot/final-check";
import { AutoRefresh } from "@/components/ui/auto-refresh";

// 완성본 확인 — 직접 찍은 영상을 사람이 마지막으로 한 번 본다. 확인하면 12 · 18시로 예약(기존 발행 큐).
// 광고 문구 규칙 · 판매 상태에 걸리면 확인 버튼이 잠기고, 문구를 고쳐 다시 편집하면 풀린다.

type Cut = { no: number; on_screen: string; on_screen_override?: string | null; subtitle_override?: string | null };
type Edit = {
  seconds?: number;
  thumbnail?: string;
  segments?: { cut: number; onScreen: string; subtitles: { text: string }[] }[];
  check?: { issues?: { kind: string; detail: string }[] };
};

export default async function ShootReviewPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");
  const canManage = profile.role === "ADMIN" || profile.role === "MANAGER";
  const supabase = await getServerSupabase();

  const { data: plans } = await supabase
    .from("content_plans")
    .select(
      "id, slot_date, slot_time, status, product_id, script, social_accounts(display_name), products(name, kind, stock_status, represent_image_url, product_analyses(health_functional)), shoot_requests(id, status, rendered_path, edit, cuts, error)",
    )
    .eq("track", "A")
    .in("status", ["SHOT", "RENDERED", "SCHEDULED"])
    .gte("slot_date", kstDate(0))
    .order("slot_date")
    .order("slot_time");

  const productIds = [...new Set((plans ?? []).map((p) => p.product_id).filter((x): x is string => !!x))];
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

  const paths = (plans ?? []).flatMap((p) => {
    const r = p.shoot_requests;
    const thumb = (r?.edit as Edit | null)?.thumbnail;
    return [r?.rendered_path, thumb].filter((x): x is string => !!x);
  });
  const { data: signed } = paths.length ? await supabase.storage.from("media").createSignedUrls(paths, 3600) : { data: [] };
  const urlOf = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]));

  const cards: ReviewCardData[] = (plans ?? []).map((p) => {
    const r = p.shoot_requests;
    const edit = (r?.edit ?? {}) as Edit;
    const caption = ((p.script ?? {}) as { caption?: { text: string } }).caption?.text ?? "";
    const segments = edit.segments ?? [];
    const cuts = (r?.cuts ?? []) as Cut[];
    const blocking =
      p.status === "RENDERED" && p.products
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
            },
          )
        : [];
    return {
      planId: p.id,
      requestId: r?.id ?? null,
      requestStatus: r?.status ?? null,
      account: p.social_accounts?.display_name ?? "",
      slotDate: p.slot_date,
      slotTime: p.slot_time,
      status: p.status,
      productName: p.products?.name ?? "",
      videoUrl: r?.rendered_path ? (urlOf.get(r.rendered_path) ?? null) : null,
      posterUrl: edit.thumbnail ? (urlOf.get(edit.thumbnail) ?? null) : null,
      seconds: edit.seconds ?? null,
      caption,
      cuts: cuts.map((c) => {
        const seg = segments.find((s) => s.cut === c.no);
        return {
          no: c.no,
          onScreen: seg?.onScreen ?? c.on_screen_override ?? c.on_screen,
          subtitle: c.subtitle_override ?? (seg?.subtitles.map((t) => t.text).join(" ") || null),
        };
      }),
      blocking,
      warnings: (edit.check?.issues ?? []).filter((i) => i.kind !== "rules" && i.kind !== "stock").map((i) => i.detail),
      error: r?.error ?? null,
      // 서버에서 계산 — 렌더 중 시계를 읽으면 서버 · 클라이언트 결과가 갈린다
      tooLate: isPastSlot(p.slot_date, p.slot_time, 5 * 60_000),
    };
  });

  const toReview = cards.filter((c) => c.status === "RENDERED").length;

  return (
    <main className="space-y-6 p-4 sm:p-6">
      <AutoRefresh active={cards.some((c) => c.status === "SHOT" && c.requestStatus !== "FAILED")} />
      <header>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold tracking-[-0.01em]">완성본 확인</h1>
          {toReview > 0 && <Badge>확인할 것 {toReview}개</Badge>}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          직접 찍은 영상을 AI가 편집한 완성본이에요. 보고 <b>확인하면 그 칸 시각에 자동으로 올라가요.</b> 화면 문구 · 자막이 틀리면 고쳐서 다시
          편집하고, 캡션은 바로 고칠 수 있어요. 지금은 배경 음악 없이 촬영 원본 소리로 나가요.{!canManage && " 확인 · 예약은 관리자 · 매니저만 할 수 있어요."}
        </p>
      </header>

      {cards.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Film className="size-10 text-muted-foreground" />
            <h2 className="text-base font-semibold">확인할 완성본이 없어요</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              <Link href="/shoot/uploads" className="underline">
                촬영 · 올리기
              </Link>
              에서 컷을 다 올리면 몇 분 뒤 여기에 완성본이 생겨요.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {cards.map((c) => (
            <ReviewCard key={c.planId} card={c} canManage={canManage} />
          ))}
        </div>
      )}
    </main>
  );
}
