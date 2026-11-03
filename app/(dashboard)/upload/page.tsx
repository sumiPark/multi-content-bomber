import { redirect } from "next/navigation";
import { UploadWizard } from "@/components/upload/wizard/upload-wizard";
import { captionsSchema } from "@/lib/ai/caption-generator";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { parseDraftState, type WizardDraft } from "@/lib/upload/draft";

const DRAFT_THUMB_TTL_SECONDS = 600;

// 보관함 '이어서 하기' (0033) — 임시 저장했고 아직 발행을 등록하지 않은 콘텐츠만 연다.
async function loadDraft(
  supabase: Awaited<ReturnType<typeof getServerSupabase>>,
  contentId: string,
): Promise<WizardDraft | null> {
  type DraftRow = {
    id: string;
    media_type: "IMAGE" | "VIDEO";
    media_urls: string[];
    metadata: unknown;
    ai_captions: unknown;
    updated_at: string;
    internal_title: string | null;
    draft_saved_at: string | null;
    draft_state: unknown;
    publish_jobs: { id: string }[];
  };
  const { data } = (await supabase
    .from("contents")
    .select(
      "id, media_type, media_urls, metadata, ai_captions, updated_at, internal_title, draft_saved_at, draft_state, publish_jobs!left(id)",
    )
    .eq("id", contentId)
    .not("draft_saved_at", "is", null)
    .maybeSingle()) as unknown as { data: DraftRow | null };
  if (!data || !data.draft_saved_at || data.publish_jobs.length > 0) return null;

  const captions = captionsSchema.safeParse(data.ai_captions);
  const state = parseDraftState(data.draft_state);
  if (!captions.success || !state) return null;

  const metadata =
    data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)
      ? (data.metadata as Record<string, unknown>)
      : {};
  // 캡션 분석 경로 — 저장된 값이 없으면 업로드 때 규칙대로(영상은 첫 프레임, 사진은 그대로).
  if (state.analyzePaths.length === 0) {
    const thumb = metadata.thumbnail_path;
    state.analyzePaths =
      data.media_type === "VIDEO"
        ? typeof thumb === "string"
          ? [thumb]
          : []
        : data.media_urls;
  }

  const { data: signed } =
    state.analyzePaths.length > 0
      ? await supabase.storage
          .from("media")
          .createSignedUrls(state.analyzePaths, DRAFT_THUMB_TTL_SECONDS)
      : { data: [] };

  return {
    contentId: data.id,
    mediaType: data.media_type,
    mediaPaths: data.media_urls,
    metadata,
    captions: captions.data,
    savedAt: data.updated_at,
    draftSavedAt: data.draft_saved_at,
    thumbnailUrls: (signed ?? [])
      .map((x) => x.signedUrl)
      .filter((u): u is string => Boolean(u)),
    internalTitle: data.internal_title ?? "",
    state,
  };
}

export default async function UploadPage({
  searchParams,
}: {
  searchParams: Promise<{ draft?: string }>;
}) {
  const { draft: draftId } = await searchParams;
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");

  const supabase = await getServerSupabase();

  // group_id / account_groups는 0009 마이그레이션 이후. 타입 재생성 전이라 cast.
  type AccountRow = {
    id: string;
    platform: "YOUTUBE" | "INSTAGRAM" | "TIKTOK";
    display_name: string | null;
    is_active: boolean;
    token_expires_at: string | null;
    group_id: string | null;
  };
  type GroupRow = {
    id: string;
    name: string;
    color: string;
  };

  const untypedSupabase = supabase as unknown as {
    from: (t: string) => {
      select: (cols: string) => {
        order: (
          col: string,
          opts: { ascending: boolean },
        ) => Promise<{ data: GroupRow[] | null }>;
      };
    };
  };

  // 토큰 만료(is_active=false) 계정도 목록에 남겨 마법사가 "비활성"으로 회색 표시한다
  // (선택은 불가). 연결 해제(0016)한 계정만 뺀다.
  const [accountsRes, presetsRes, groupsRes, seriesRes] = await Promise.all([
    supabase
      .from("social_accounts")
      .select(
        "id, platform, display_name, is_active, token_expires_at, group_id",
      )
      .is("disconnected_at", null) as unknown as Promise<{
      data: AccountRow[] | null;
    }>,
    supabase
      .from("caption_presets")
      .select("id, name, description")
      .order("created_at", { ascending: false }),
    untypedSupabase
      .from("account_groups")
      .select("id, name, color")
      .order("created_at", { ascending: true }),
    // 시리즈 댓글 자동화(0017) — 마지막 단계의 "다음 화로 올리기" 선택지. 인스타 계정별 시리즈.
    supabase
      .from("series")
      .select("id, name, social_account_id, series_episodes(episode_no)")
      .is("deleted_at", null)
      .order("created_at", { ascending: true }),
  ]);

  const seriesOptions = (seriesRes.data ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    socialAccountId: s.social_account_id,
    nextEpisodeNo:
      Math.max(0, ...s.series_episodes.map((e) => e.episode_no)) + 1,
  }));

  const initialDraft = draftId ? await loadDraft(supabase, draftId) : null;

  return (
    <main className="p-4 sm:p-6 space-y-6">
      <header>
        <h1 className="text-xl font-bold tracking-[-0.01em]">콘텐츠 생성</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          사진이나 영상을 한 번 올리고, 계정마다 캡션을 맞춰 동시에 올려요.
        </p>
      </header>
      {draftId && !initialDraft && (
        <p className="rounded-lg bg-warn-soft px-3.5 py-3 text-[13px] text-ink-2">
          이어서 할 임시 저장을 찾을 수 없어요. 이미 발행을 등록했거나 지워졌을 수 있어요. 새로
          만들어 주세요.
        </p>
      )}
      <UploadWizard
        key={initialDraft?.contentId ?? "new"}
        initialDraft={initialDraft}
        organizationId={profile.organization_id}
        userId={user.id}
        socialAccounts={accountsRes.data ?? []}
        accountGroups={groupsRes.data ?? []}
        presets={presetsRes.data ?? []}
        seriesOptions={seriesOptions}
      />
    </main>
  );
}
