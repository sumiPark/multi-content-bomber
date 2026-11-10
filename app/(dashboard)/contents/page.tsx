import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import {
  ContentsLibrary,
  type ContentItem,
} from "@/components/contents/contents-library";
import { captionsSchema } from "@/lib/ai/caption-generator";
import { contentThumbPath } from "@/lib/upload/media-kind";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";

const THUMB_TTL_SECONDS = 3600;
const PAGE_LIMIT = 50;

// 보관함 = 사람이 콘텐츠 생성 화면에서 '임시 저장'을 누른 콘텐츠만(0033, draft_saved_at).
// 그중에서도 발행 잡이 하나도 없는 것만 — 발행을 등록한 순간(성공/실패/예약 무관) 그 콘텐츠는
// /postings 관할로 넘어가고, 조회·삭제는 배포 관리의 발행 상세에서 한다.
// 누르면 콘텐츠 생성 화면이 저장한 단계로 다시 열린다(/upload?draft=).
const SELECT_COLUMNS =
  "id, media_type, media_urls, metadata, ai_captions, created_at, updated_at, created_by, internal_title, draft_saved_at, publish_jobs!left(id)";

export default async function ContentsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");

  const supabase = await getServerSupabase();

  // internal_title는 0008 마이그레이션 이후 추가. 타입 재생성 전이므로
  // 응답 전체를 명시 타입으로 cast (재생성 후 cast 제거).
  type ContentRow = {
    id: string;
    media_type: "IMAGE" | "VIDEO";
    media_urls: string[];
    metadata: unknown;
    draft_saved_at: string | null;
    ai_captions: unknown;
    created_at: string;
    updated_at: string;
    created_by: string | null;
    internal_title: string | null;
  };

  // PostgREST는 embed된 자식에 is.null 필터를 서버 사이드로 적용한다.
  // (클라이언트에서 거르면 limit이 어긋난다.)
  const { data: contents } = (await supabase
    .from("contents")
    .select(SELECT_COLUMNS)
    .is("publish_jobs", null)
    .not("draft_saved_at", "is", null)
    .order("draft_saved_at", { ascending: false })
    .limit(PAGE_LIMIT)) as unknown as { data: ContentRow[] | null };

  const rows = contents ?? [];
  // ai_captions 파싱은 server-only인 captionsSchema를 쓰므로 여기서 처리해
  // 클라이언트 컴포넌트로는 문자열 preview만 넘긴다.
  const list: ContentItem[] = rows.map((c) => {
    const parsed = captionsSchema.safeParse(c.ai_captions);
    const preview = parsed.success
      ? (parsed.data.youtube?.title ??
        parsed.data.instagram?.caption ??
        parsed.data.tiktok?.caption ??
        "")
      : "";
    return {
      id: c.id,
      media_urls: c.media_urls,
      // 영상은 파일 대신 첫 프레임 썸네일 — 사진 게시물의 첫 장이 영상이어도 그 첫 프레임(item_thumbs)
      thumb_path: contentThumbPath(c),
      caption_preview: preview,
      // 목록의 시각 = 임시 저장한 시각
      updated_at: c.draft_saved_at ?? c.updated_at,
      created_by: c.created_by,
      internal_title: c.internal_title,
    };
  });

  const firstPaths = list
    .map((c) => c.thumb_path ?? c.media_urls[0])
    .filter((p): p is string => Boolean(p));

  const thumbsByPath: Record<string, string> = {};
  if (firstPaths.length > 0) {
    const { data: signed } = await supabase.storage
      .from("media")
      .createSignedUrls(firstPaths, THUMB_TTL_SECONDS);
    signed?.forEach((s) => {
      if (s.path && s.signedUrl) thumbsByPath[s.path] = s.signedUrl;
    });
  }

  return (
    <main className="p-4 sm:p-6 space-y-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-[-0.01em]">보관함</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            콘텐츠 생성에서 임시 저장한 콘텐츠 ({list.length}개
            {list.length === PAGE_LIMIT ? "+" : ""}) — 누르면 이어서 할 수 있어요.
            발행한 콘텐츠는 배포 관리에 있어요
          </p>
        </div>
        <Link href="/upload" className={buttonVariants({ variant: "outline" })}>
          <Plus className="size-4" /> 콘텐츠 생성
        </Link>
      </header>

      <ContentsLibrary
        items={list}
        thumbsByPath={thumbsByPath}
        currentUserId={user.id}
        pageLimit={PAGE_LIMIT}
      />
    </main>
  );
}
