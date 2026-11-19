import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronRight, FolderOpen } from "lucide-react";
import { FolderCreate } from "@/components/style-shorts/folder-create";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { CARD_STATUS, type StyleCard } from "@/lib/style-shorts/card";

// 스타일 쇼츠 — 메뉴에 넣지 않은 시험 페이지(2026-11-19 사용자 결정). 쓸 만해지면 사이드바에 추가한다.
// 1단계: 스타일 폴더(레퍼런스 + 스타일 카드). 2단계에서 이 화면 위에 "만들기"를 붙인다.

export const metadata = { title: "스타일 쇼츠 | MCB", robots: { index: false, follow: false } };

export default async function StyleShortsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");
  const supabase = await getServerSupabase();

  const { data } = await supabase
    .from("style_folders")
    .select("id, name, memo, card, card_status, card_edited, updated_at, style_references(id, status)")
    .order("created_at", { ascending: false });

  const folders = (data ?? []).map((f) => {
    const refs = f.style_references ?? [];
    return {
      id: f.id,
      name: f.name,
      memo: f.memo,
      summary: (f.card as unknown as StyleCard | null)?.summary ?? null,
      status: f.card_status,
      edited: f.card_edited,
      refs: refs.length,
      analyzing: refs.filter((r) => r.status === "PENDING" || r.status === "ANALYZING").length,
      failed: refs.filter((r) => r.status === "FAILED").length,
    };
  });
  const working = folders.some((f) => f.analyzing > 0 || f.status === "PENDING" || f.status === "ANALYZING");

  return (
    <main className="space-y-6 p-4 sm:p-6">
      <AutoRefresh active={working} />
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold tracking-[-0.01em]">스타일 쇼츠</h1>
            <Badge variant="secondary">시험 중</Badge>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            레퍼런스 릴스를 폴더에 모으면 AI가 컷 · 자막 · 그래픽 · 효과음 · 음악 스타일을 분석해 스타일 카드로 정리해요. 찍은 영상을 이 카드대로 편집하는 기능은 다음 단계에서 붙여요.
          </p>
        </div>
      </header>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold">스타일 폴더</h2>
          <FolderCreate />
        </div>
        {folders.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
              <FolderOpen className="size-10 text-muted-foreground" />
              <h3 className="text-base font-semibold">아직 스타일 폴더가 없어요</h3>
              <p className="max-w-md text-sm text-muted-foreground">폴더를 만들고 따라 하고 싶은 릴스를 영상 파일이나 인스타 링크로 넣어 주세요.</p>
            </CardContent>
          </Card>
        ) : (
          <ul className="divide-y overflow-hidden rounded-lg border bg-card">
            {folders.map((f) => {
              const s = CARD_STATUS[f.status] ?? { label: f.status, variant: "secondary" as const };
              return (
                <li key={f.id}>
                  <Link href={`/style-shorts/folders/${f.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2">
                    <FolderOpen className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-sm font-semibold">{f.name}</span>
                        <Badge variant={s.variant}>{s.label}</Badge>
                        {f.edited && <Badge variant="outline">직접 고침</Badge>}
                        {f.failed > 0 && <Badge variant="destructive">분석 실패 {f.failed}개</Badge>}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground tabular-nums">
                        레퍼런스 {f.refs}개{f.analyzing > 0 && ` · 분석 중 ${f.analyzing}개`}
                        {(f.summary ?? f.memo) && ` · ${f.summary ?? f.memo}`}
                      </span>
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
