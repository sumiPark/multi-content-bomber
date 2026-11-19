import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { FolderHeader } from "@/components/style-shorts/folder-header";
import { ReferencePanel, type ReferenceRow } from "@/components/style-shorts/reference-panel";
import { StyleCardPanel } from "@/components/style-shorts/style-card-panel";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import type { ReferenceAnalysis, StyleCard } from "@/lib/style-shorts/card";

// 스타일 폴더 하나 — 레퍼런스 넣기 · 분석 상태, 스타일 카드 보기 · 고치기.

export const metadata = { title: "스타일 폴더 | MCB", robots: { index: false, follow: false } };

const PREVIEW_SECONDS = 6 * 3600;

export default async function StyleFolderPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");
  const { id } = await params;
  const supabase = await getServerSupabase();

  const { data: folder } = await supabase
    .from("style_folders")
    .select("id, name, memo, card, card_status, card_error, card_edited, card_built_from, card_updated_at")
    .eq("id", id)
    .maybeSingle();
  if (!folder) notFound();

  const { data: refData } = await supabase
    .from("style_references")
    .select("id, kind, storage_path, file_name, permalink, username, status, analysis, analyzed_from, error, created_at")
    .eq("folder_id", id)
    .order("created_at");
  const refs = refData ?? [];

  const paths = refs.map((r) => r.storage_path).filter((p): p is string => !!p);
  const { data: signed } = paths.length ? await supabase.storage.from("media").createSignedUrls(paths, PREVIEW_SECONDS) : { data: [] };
  const urlOf = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]));

  const rows: ReferenceRow[] = refs.map((r) => {
    const a = r.analysis as unknown as ReferenceAnalysis | null;
    return {
      id: r.id,
      kind: r.kind as ReferenceRow["kind"],
      name: r.kind === "UPLOAD" ? (r.file_name ?? "영상 파일") : `@${r.username ?? ""}`,
      permalink: r.permalink,
      previewUrl: r.storage_path ? (urlOf.get(r.storage_path) ?? null) : null,
      status: r.status,
      from: r.analyzed_from as ReferenceRow["from"],
      error: r.error,
      brief: a
        ? {
            durationSec: a.durationSec,
            avgShotSec: a.avgShotSec,
            sfxPer10s: a.sound?.sfxPer10s ?? null,
            captionStyle: a.read.captionStyle,
            notes: a.read.notes,
            soundNote: a.soundNote,
          }
        : null,
    };
  });

  const done = new Set(refs.filter((r) => r.status === "DONE").map((r) => r.id));
  const builtFrom = new Set(folder.card_built_from ?? []);
  // 사람이 고친 카드인데 레퍼런스가 바뀌었다 — 자동으로 덮어쓰지 않으니 화면에서 알린다
  const stale = !!folder.card && (done.size !== builtFrom.size || [...done].some((r) => !builtFrom.has(r)));
  const working = refs.some((r) => r.status === "PENDING" || r.status === "ANALYZING") || folder.card_status === "PENDING" || folder.card_status === "ANALYZING";

  return (
    <main className="space-y-6 p-4 sm:p-6">
      <AutoRefresh active={working} seconds={20} />
      <Link href="/style-shorts" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronLeft className="size-4" aria-hidden />
        스타일 쇼츠
      </Link>
      <FolderHeader folderId={folder.id} name={folder.name} memo={folder.memo} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <ReferencePanel folderId={folder.id} uploadFolder={`${profile.organization_id}/${user.id}/style-shorts/refs`} refs={rows} />
        <StyleCardPanel
          folderId={folder.id}
          card={folder.card as unknown as StyleCard | null}
          status={folder.card_status}
          error={folder.card_error}
          edited={folder.card_edited}
          stale={stale}
          hasRefs={refs.length > 0}
          updatedAt={folder.card_updated_at}
        />
      </div>
    </main>
  );
}
