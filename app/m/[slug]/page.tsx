import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, permanentRedirect } from "next/navigation";
import { MoaPageView } from "@/components/moa/moa-page-view";
import { MoaTracker } from "@/components/moa/moa-tracker";
import { getPublicPage } from "@/lib/moa/public";
import { MOA_HOST } from "@/lib/moa/slug";
import { FONT_GOOGLE_FAMILY } from "@/lib/moa/theme";

// 모아링크 공개 페이지 — moa.cuma.co.kr/<주소>(proxy가 이 경로로 넘김) · 앱 도메인 /m/<주소>.
// 로그인 없이 열린다. 데이터는 캐시(lib/moa/public.ts), 공개 기간 · 판매 상태 표시는 그릴 때 판정한다.

interface Props {
  params: Promise<{ slug: string }>;
}

function cleanSlug(raw: string): string {
  try {
    return decodeURIComponent(raw).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const found = await getPublicPage(cleanSlug(slug));
  // 검색엔진 노출은 기본으로 끈다(기획서 1장)
  const base: Metadata = { robots: { index: false, follow: false } };
  if (found.kind !== "page" || found.page.status === "DRAFT") return base;
  const p = found.page;
  const title = p.title || `@${p.slug}`;
  return {
    ...base,
    title,
    description: p.bio || undefined,
    openGraph: { title, description: p.bio || undefined, images: p.avatarUrl ? [p.avatarUrl] : undefined },
    icons: p.avatarUrl ? { icon: p.avatarUrl, apple: p.avatarUrl } : undefined,
  };
}

// 그리는 시각 — 공개 기간 판정용
function nowMs(): number {
  return Date.now();
}

export default async function MoaPublicPage({ params }: Props) {
  const { slug: raw } = await params;
  const slug = cleanSlug(raw);
  const found = await getPublicPage(slug);
  const host = ((await headers()).get("host") ?? "").toLowerCase().split(":")[0];
  const onMoaHost = host === MOA_HOST;

  if (found.kind === "redirect") permanentRedirect(onMoaHost ? `/${found.slug}` : `/m/${found.slug}`);
  if (found.kind === "none" || found.page.status === "DRAFT") notFound();
  const page = found.page;

  const google = FONT_GOOGLE_FAMILY[page.theme.font];

  return (
    <main data-moa-root className="min-h-dvh">
      {/* 앱 공통 정책 링크 푸터는 모아링크 페이지에서만 숨긴다(다른 화면은 그대로) */}
      <style>{`body:has([data-moa-root]) > footer { display: none; }`}</style>
      {google && (
        <link rel="stylesheet" href={`https://fonts.googleapis.com/css2?family=${google}&display=swap`} />
      )}
      {page.status === "PAUSED" ? (
        <div className="grid min-h-dvh place-items-center px-6 text-center" style={{ background: page.theme.background }}>
          <div>
            <p className="text-lg font-bold">{page.title || `@${page.slug}`}</p>
            <p className="mt-2 text-sm opacity-70">페이지를 잠시 정리하고 있어요. 조금 뒤에 다시 들러 주세요.</p>
          </div>
        </div>
      ) : (
        <>
          <MoaPageView page={page} now={nowMs()} linkBase={onMoaHost ? "/r" : "/api/moa/r"} />
          <MoaTracker pageId={page.id} />
        </>
      )}
    </main>
  );
}
