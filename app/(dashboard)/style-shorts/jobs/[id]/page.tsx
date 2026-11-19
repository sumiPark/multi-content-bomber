import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { JobView, type VersionView } from "@/components/style-shorts/job-view";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import type { MusicSource } from "@/lib/shoot/video-kit/music";
import { CLIP_KEEP_DAYS, type JobClip, type VersionRequest } from "@/lib/style-shorts/jobs";

// 만든 쇼츠 하나 — 완성본 버전(재생 · 받기 · 경고 · 주석 수정), 다시 만들기 · 지우기.

export const metadata = { title: "스타일 쇼츠 | MCB", robots: { index: false, follow: false } };

const LINK_SECONDS = 6 * 3600;

function fileName(title: string, version: number): string {
  const safe = title.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "style-short";
  return `${safe}-v${version}.mp4`;
}

export default async function StyleShortJobPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");
  const { id } = await params;
  const supabase = await getServerSupabase();

  const { data: job } = await supabase
    .from("style_short_jobs")
    .select("id, title, folder_id, folder_name, voice_mode, script, concept, clips, clips_deleted_at, created_at")
    .eq("id", id)
    .maybeSingle();
  if (!job) notFound();
  const { data: rows } = await supabase
    .from("style_short_versions")
    .select("id, version, status, request, video_path, cover_path, seconds, warnings, sounds, error, created_at, finished_at")
    .eq("job_id", id)
    .order("version", { ascending: false });
  const versions = rows ?? [];
  // 아직 보내지 않은 주석(편집 화면에서 이어 단다)
  const doneIds = versions.filter((v) => v.status === "DONE").map((v) => v.id);
  const { data: noteRows } = doneIds.length
    ? await supabase.from("style_short_notes").select("id, version_id, no, at, x, y, body").in("version_id", doneIds).is("sent_at", null).order("no")
    : { data: [] };

  const title = job.title || job.folder_name;
  const paths = versions.flatMap((v) => [v.video_path, v.cover_path]).filter((p): p is string => !!p);
  const { data: signed } = paths.length ? await supabase.storage.from("media").createSignedUrls(paths, LINK_SECONDS) : { data: [] };
  const urlOf = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]));
  const downloads = await Promise.all(
    versions.map(async (v) => {
      if (!v.video_path) return null;
      const { data } = await supabase.storage.from("media").createSignedUrl(v.video_path, LINK_SECONDS, { download: fileName(title, v.version) });
      return data?.signedUrl ?? null;
    }),
  );

  const views: VersionView[] = versions.map((v, i) => {
    const sounds = v.sounds as { music?: string | null; musicSource?: MusicSource | null; sfx?: string[] } | null;
    const req = v.request as VersionRequest | null;
    const num = (n: unknown) => (n == null ? null : Number(n));
    return {
      id: v.id,
      version: v.version,
      status: v.status,
      requestLabel: req?.kind === "remake" ? `v${req.from}에서 다시 만들기` : req?.kind === "revise" ? `v${req.from} 수정` : null,
      videoUrl: v.video_path ? (urlOf.get(v.video_path) ?? null) : null,
      coverUrl: v.cover_path ? (urlOf.get(v.cover_path) ?? null) : null,
      downloadUrl: downloads[i],
      seconds: v.seconds == null ? null : Number(v.seconds),
      warnings: v.warnings ?? [],
      music: sounds?.musicSource ? { title: sounds.musicSource.title, creator: sounds.musicSource.creator, license: sounds.musicSource.license, url: sounds.musicSource.landing } : sounds?.music ? { title: sounds.music, creator: "", license: "", url: "" } : null,
      sfxCount: sounds?.sfx?.length ?? 0,
      error: v.error,
      finishedAt: v.finished_at,
      draftNotes: (noteRows ?? []).filter((n) => n.version_id === v.id).map((n) => ({ id: n.id, no: n.no, at: num(n.at), x: num(n.x), y: num(n.y), body: n.body })),
      sentNotes: req?.kind === "revise" ? req.notes : [],
    };
  });
  const busy = versions.some((v) => v.status === "PENDING" || v.status === "EDITING");

  return (
    <main className="space-y-6 p-4 sm:p-6">
      <AutoRefresh active={busy} seconds={20} />
      <Link href="/style-shorts" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronLeft className="size-4" aria-hidden />
        스타일 쇼츠
      </Link>
      <JobView
        job={{
          id: job.id,
          title,
          folderId: job.folder_id,
          folderName: job.folder_name,
          voiceMode: job.voice_mode as "AI" | "LIVE",
          script: job.script,
          concept: job.concept,
          clips: ((job.clips ?? []) as unknown as JobClip[]).map((c) => c.name),
          clipsDeleted: !!job.clips_deleted_at,
          keepDays: CLIP_KEEP_DAYS,
          createdAt: job.created_at,
        }}
        versions={views}
        busy={busy}
      />
    </main>
  );
}
