import { redirect } from "next/navigation";
import { BarChart3, Clock, LineChart, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";

// Phase 1: 화면 골격 + 빈 상태. 데이터 수집 cron + posting_metrics 테이블은
// docs/functional-specification.md §7.7 Phase 2에서 BullMQ 워커와 함께 진행.

export default async function AnalyticsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");

  const supabase = await getServerSupabase();

  // 게시 완료 건수 빠르게 카운트만 — Phase 2부터 실제 인사이트 수치로 대체.
  const { count: publishedCount } = await supabase
    .from("publish_jobs")
    .select("id", { count: "exact", head: true })
    .eq("status", "SUCCESS");

  return (
    <main className="container mx-auto max-w-6xl px-6 py-10 space-y-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">분석/리포팅</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            게시 후 인사이트(조회·좋아요·댓글·저장·공유)를 시각화합니다.
            AI 캡션의 효과 측정과 Smart Scheduler 학습의 데이터 소스가 됩니다.
          </p>
        </div>
        <Badge variant="outline" className="shrink-0">
          Phase 1 · 골격
        </Badge>
      </header>

      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <BarChart3 className="size-10 text-muted-foreground" />
          <h2 className="text-lg font-semibold">데이터 수집 준비 중</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            현재까지 게시 완료된 콘텐츠는{" "}
            <strong>{publishedCount ?? 0}건</strong>입니다. 각 플랫폼
            Insights API 연동 + 수집 cron(Phase 2)이 활성화되면 아래 차트들이
            실제 수치로 채워집니다.
          </p>
          <p className="max-w-md text-xs text-muted-foreground">
            상세 명세는{" "}
            <code className="rounded bg-muted px-1 py-0.5">
              docs/functional-specification.md §7
            </code>{" "}
            참조.
          </p>
        </CardContent>
      </Card>

      <section className="grid gap-4 sm:grid-cols-2">
        <PlaceholderCard
          icon={LineChart}
          title="종합 대시보드"
          desc="기간별 KPI · 플랫폼별 카드 · 시계열 차트"
          phase="Phase 2"
        />
        <PlaceholderCard
          icon={BarChart3}
          title="콘텐츠별 상세"
          desc="시간대별 성장 곡선 · 플랫폼 비교"
          phase="Phase 3"
        />
        <PlaceholderCard
          icon={Sparkles}
          title="캡션 효과 분석"
          desc="AI vs 직접 작성 · 길이/해시태그/CTA 효과"
          phase="Phase 3"
        />
        <PlaceholderCard
          icon={Clock}
          title="최적 시간 학습"
          desc="요일×시간 히트맵 · Scheduler 추천 슬롯"
          phase="Phase 3"
        />
      </section>
    </main>
  );
}

function PlaceholderCard({
  icon: Icon,
  title,
  desc,
  phase,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  desc: string;
  phase: string;
}) {
  return (
    <Card className="bg-muted/20">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="size-4" />
          {title}
          <Badge variant="outline" className="ml-auto text-[10px]">
            {phase}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">{desc}</CardContent>
    </Card>
  );
}
