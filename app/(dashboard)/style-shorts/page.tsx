import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronRight, FolderOpen } from "lucide-react";
import { FolderCreate } from "@/components/style-shorts/folder-create";
import { MakeShortForm } from "@/components/style-shorts/make-short-form";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { RelativeTime } from "@/components/ui/relative-time";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { CARD_STATUS, type StyleCard } from "@/lib/style-shorts/card";
import { VERSION_STATUS, VOICE_MODE_LABEL } from "@/lib/style-shorts/jobs";

// 스타일 쇼츠 — 메뉴에 넣지 않은 시험 페이지(2026-11-19 사용자 결정). 쓸 만해지면 사이드바에 추가한다.
// 위에서부터 새 쇼츠 만들기 → 만든 쇼츠 → 스타일 폴더(레퍼런스 + 스타일 카드).

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
  const { data: jobData } = await supabase
    .from("style_short_jobs")
    .select("id, title, folder_name, voice_mode, created_at, style_short_versions(version, status, cover_path)")
    .order("created_at", { ascending: false })
    .limit(30);
  const jobs = (jobData ?? []).map((j) => {
    const latest = [...(j.style_short_versions ?? [])].sort((a, b) => b.version - a.version)[0];
    const lastCover = [...(j.style_short_versions ?? [])].filter((v) => v.cover_path).sort((a, b) => b.version - a.version)[0]?.cover_path ?? null;
    return { id: j.id, title: j.title || j.folder_name, folder: j.folder_name, voice: j.voice_mode as "AI" | "LIVE", createdAt: j.created_at, version: latest?.version ?? 0, status: latest?.status ?? "PENDING", cover: lastCover };
  });
  const covers = jobs.map((j) => j.cover).filter((p): p is string => !!p);
  const { data: signed } = covers.length ? await supabase.storage.from("media").createSignedUrls(covers, 6 * 3600) : { data: [] };
  const coverUrl = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]));

  const working =
    folders.some((f) => f.analyzing > 0 || f.status === "PENDING" || f.status === "ANALYZING") || jobs.some((j) => j.status === "PENDING" || j.status === "EDITING");

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
            레퍼런스 릴스를 스타일 폴더에 모으면 AI가 컷 · 자막 · 그래픽 · 효과음 · 음악 스타일을 분석해 카드로 정리해요. 찍은 영상을 올리면 그 카드대로 편집해요.
          </p>
        </div>
      </header>

      <MakeShortForm
        folders={folders.map((f) => ({ id: f.id, name: f.name, summary: f.summary, ready: f.status === "READY" }))}
        uploadRoot={`${profile.organization_id}/${user.id}/style-shorts/clips`}
      />

      {jobs.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-base font-semibold">만든 쇼츠</h2>
          <ul className="divide-y overflow-hidden rounded-lg border bg-card">
            {jobs.map((j) => {
              const s = VERSION_STATUS[j.status] ?? { label: j.status, variant: "secondary" as const };
              const url = j.cover ? coverUrl.get(j.cover) : null;
              return (
                <li key={j.id}>
                  <Link href={`/style-shorts/jobs/${j.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2">
                    {url ? (
                      // Supabase 서명 주소
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={url} alt="" className="h-16 w-9 shrink-0 rounded object-cover" />
                    ) : (
                      <span className="h-16 w-9 shrink-0 rounded bg-muted" />
                    )}
                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-sm font-semibold">{j.title}</span>
                        <Badge variant={s.variant}>
                          v{j.version} {s.label}
                        </Badge>
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {j.folder} · {VOICE_MODE_LABEL[j.voice]} · <RelativeTime iso={j.createdAt} />
                      </span>
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}

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
