import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PostingsPage } from "@/components/postings/postings-page";

// 클라이언트에서 필터/검색/일괄 선택을 다루므로, 서버에서는 한 번에 충분히 큰
// 윈도우(최근 90일, soft-delete 제외, 최신 200건)를 가져와 클라이언트 보드로 넘긴다.
// 200건 초과 시점에는 서버 페이지네이션으로 전환 필요(향후).
const MAX_ROWS = 200;
const WINDOW_DAYS = 90;
const SIGNED_URL_TTL = 600;

export default async function Page() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("organization_id, role")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile?.organization_id) redirect("/onboarding");

  const since = new Date(
    Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  // RLS가 publish_jobs SELECT에 contents.organization_id = current_org_id 적용.
  // 추가 필터: deleted_at IS NULL (0007 이후), 최근 90일.
  // 0007/0008 마이그레이션 이후 추가된 컬럼은 타입 재생성 전이라 cast로 우회.
  type Row = {
    id: string;
    content_id: string;
    social_account_id: string;
    post_type: string;
    status: "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED" | "RETRYING" | "CANCELLED";
    scheduled_for: string | null;
    attempts: number;
    last_error: string | null;
    platform_post_id: string | null;
    platform_post_url: string | null;
    created_at: string;
    updated_at: string;
    completed_at: string | null;
    contents: {
      id: string;
      media_type: "IMAGE" | "VIDEO";
      media_urls: string[];
      ai_captions: unknown;
      metadata: unknown;
      internal_title: string | null;
      created_at: string;
    };
    social_accounts: {
      id: string;
      platform: "YOUTUBE" | "INSTAGRAM" | "TIKTOK";
      display_name: string | null;
      avatar_url: string | null;
    };
  };

  const { data: rows, error } = (await supabase
    .from("publish_jobs")
    .select(
      `
      id, content_id, social_account_id, post_type, status, scheduled_for,
      attempts, last_error, platform_post_id, platform_post_url,
      created_at, updated_at, completed_at,
      contents!inner ( id, media_type, media_urls, ai_captions, metadata, internal_title, created_at ),
      social_accounts!inner ( id, platform, display_name, avatar_url )
      `,
    )
    .is("deleted_at", null)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(MAX_ROWS)) as unknown as {
    data: Row[] | null;
    error: { message: string } | null;
  };

  if (error) {
    return (
      <main className="container mx-auto max-w-7xl px-6 py-10">
        <h1 className="text-3xl font-bold">포스팅 관리</h1>
        <p className="mt-4 text-sm text-destructive">
          데이터 조회 실패: {error.message}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          마이그레이션 0007이 적용되지 않았다면{" "}
          <code>supabase/migrations/0007_publish_jobs_management.sql</code>을
          먼저 실행해주세요.
        </p>
      </main>
    );
  }

  // 썸네일용 signed URL: 영상은 metadata.thumbnail_path, 이미지는 media_urls[0].
  // 한 번에 묶어서 createSignedUrls 호출 — N+1 방지.
  const thumbPaths = new Set<string>();
  for (const r of rows ?? []) {
    const meta =
      (r.contents.metadata as { thumbnail_path?: string } | null) ?? null;
    const path =
      r.contents.media_type === "VIDEO"
        ? meta?.thumbnail_path
        : r.contents.media_urls?.[0];
    if (path) thumbPaths.add(path);
  }
  const thumbsByPath = new Map<string, string>();
  if (thumbPaths.size > 0) {
    const { data: signed } = await supabase.storage
      .from("media")
      .createSignedUrls(Array.from(thumbPaths), SIGNED_URL_TTL);
    for (const s of signed ?? []) {
      if (s.path && s.signedUrl) thumbsByPath.set(s.path, s.signedUrl);
    }
  }

  // 클라이언트로 넘길 형태로 평탄화.
  const postings = (rows ?? []).map((r) => {
    const meta =
      (r.contents.metadata as { thumbnail_path?: string } | null) ?? null;
    const thumbPath =
      r.contents.media_type === "VIDEO"
        ? meta?.thumbnail_path
        : r.contents.media_urls?.[0];
    return {
      id: r.id,
      contentId: r.content_id,
      socialAccountId: r.social_account_id,
      postType: r.post_type,
      status: r.status,
      scheduledFor: r.scheduled_for,
      attempts: r.attempts,
      lastError: r.last_error,
      platformPostId: r.platform_post_id,
      platformPostUrl: r.platform_post_url,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      completedAt: r.completed_at,
      thumbnailUrl: thumbPath ? (thumbsByPath.get(thumbPath) ?? null) : null,
      mediaType: r.contents.media_type,
      mediaCount: r.contents.media_urls?.length ?? 0,
      captions: r.contents.ai_captions,
      internalTitle: r.contents.internal_title,
      account: {
        id: r.social_accounts.id,
        platform: r.social_accounts.platform,
        displayName: r.social_accounts.display_name,
        avatarUrl: r.social_accounts.avatar_url,
      },
    };
  });

  const canManage =
    profile.role === "ADMIN" || profile.role === "MANAGER";

  return (
    <main className="container mx-auto max-w-7xl px-6 py-10">
      <PostingsPage initialPostings={postings} canManage={canManage} />
    </main>
  );
}
