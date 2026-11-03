import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PlatformIcon } from "@/components/ui/platform-icon";
import { RelativeTime } from "@/components/ui/relative-time";
import { cn } from "@/lib/utils";

// 계정별 기준선 카드 (콘텐츠 자동화 1단계). 운영 시작 전 "지금 수준"을 숫자로 남겨,
// 하루 4개 운영 뒤 비교의 출발점으로 쓴다.

export interface BaselinePost {
  id: string;
  permalink: string | null;
  caption: string | null;
  thumbnailUrl: string | null;
  productType: string | null; // FEED / REELS
  postedAt: string | null;
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  saved: number | null;
  shares: number | null;
}

export interface BaselineAccount {
  id: string;
  name: string;
  roleFocus: "PRODUCT" | "PERSON" | null;
  roleNote: string | null;
  followers: number | null;
  // 비교 기준일과 그날 팔로워 — 수집이 쌓인 만큼(최대 7일 전)
  followersBefore: { day: string; count: number } | null;
  lastCollectedOn: string | null;
  hasInsights: boolean;
  posts: BaselinePost[]; // 최근순, 최대 30개
}

const ROLE_LABEL = { PRODUCT: "상품 중심", PERSON: "사람 중심" } as const;

// 서버 · 클라이언트에서 같은 문자열이 나오게 로케일 없이 직접 포맷한다.
function fmt(n: number | null): string {
  if (n == null) return "—";
  if (Math.abs(n) >= 10_000) return `${(n / 10_000).toFixed(1)}만`;
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function avg(posts: BaselinePost[], key: keyof BaselinePost): number | null {
  const vals = posts
    .map((p) => p[key])
    .filter((v): v is number => typeof v === "number");
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export function AccountBaselineCard({ account }: { account: BaselineAccount }) {
  const { posts } = account;
  const delta =
    account.followers != null && account.followersBefore
      ? account.followers - account.followersBefore.count
      : null;

  // 잘된/안된 기준 — 성과 권한이 있으면 조회, 없으면 좋아요.
  const rankKey: keyof BaselinePost = account.hasInsights ? "views" : "likes";
  const ranked = posts
    .filter((p) => typeof p[rankKey] === "number")
    .sort((a, b) => (b[rankKey] as number) - (a[rankKey] as number));
  const top = ranked.slice(0, 3);
  const bottom = ranked.length > 6 ? ranked.slice(-3).reverse() : [];

  const reels = posts.filter((p) => p.productType === "REELS");
  const feed = posts.filter((p) => p.productType !== "REELS");

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <PlatformIcon platform="INSTAGRAM" size={22} />
          <CardTitle className="text-base">@{account.name}</CardTitle>
          {account.roleFocus && (
            <Badge variant="outline" className="text-[10px]">
              {ROLE_LABEL[account.roleFocus]}
            </Badge>
          )}
          {account.roleNote && (
            <span className="text-xs text-muted-foreground">{account.roleNote}</span>
          )}
          <span className="ml-auto text-[11px] text-muted-foreground">
            {account.lastCollectedOn
              ? `${account.lastCollectedOn} 수집`
              : "아직 수집 전"}
          </span>
        </div>
        {!account.hasInsights && account.lastCollectedOn && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            성과 권한이 없어 팔로워 · 좋아요 · 댓글만 보여요.{" "}
            <Link href="/accounts" className="underline underline-offset-2">
              계정 연동
            </Link>
            에서 다시 연결하면 조회 · 도달 · 저장 · 공유가 채워집니다.
          </p>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat
            label="팔로워"
            value={fmt(account.followers)}
            sub={
              delta == null
                ? "증감은 이틀째 수집부터"
                : `${delta >= 0 ? "+" : ""}${fmt(delta)} (${account.followersBefore!.day} 대비)`
            }
            tone={delta == null ? undefined : delta >= 0 ? "up" : "down"}
          />
          <Stat
            label="평균 조회"
            value={fmt(avg(posts, "views"))}
            sub={`최근 ${posts.length}개`}
          />
          <Stat label="평균 저장" value={fmt(avg(posts, "saved"))} sub="게시물당" />
          <Stat label="평균 공유" value={fmt(avg(posts, "shares"))} sub="게시물당" />
          <Stat label="평균 도달" value={fmt(avg(posts, "reach"))} sub="게시물당" />
          <Stat label="평균 좋아요" value={fmt(avg(posts, "likes"))} sub="게시물당" />
          <Stat label="평균 댓글" value={fmt(avg(posts, "comments"))} sub="게시물당" />
          <Stat
            label="릴스 · 피드"
            value={`${reels.length} · ${feed.length}`}
            sub={
              reels.length && feed.length && account.hasInsights
                ? `조회 ${fmt(avg(reels, "views"))} · ${fmt(avg(feed, "views"))}`
                : "최근 게시물 구성"
            }
          />
        </div>

        {top.length > 0 && (
          <div className="grid gap-3 md:grid-cols-2">
            <PostList
              title={`잘된 게시물 (${account.hasInsights ? "조회" : "좋아요"} 순)`}
              posts={top}
              rankKey={rankKey}
            />
            {bottom.length > 0 && (
              <PostList title="안된 게시물" posts={bottom} rankKey={rankKey} />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "up" | "down";
}) {
  return (
    <div className="rounded-md border bg-muted/20 px-3 py-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      <p
        className={cn(
          "truncate text-[11px] text-muted-foreground",
          tone === "up" && "text-green-700 dark:text-green-400",
          tone === "down" && "text-destructive",
        )}
      >
        {sub}
      </p>
    </div>
  );
}

function PostList({
  title,
  posts,
  rankKey,
}: {
  title: string;
  posts: BaselinePost[];
  rankKey: keyof BaselinePost;
}) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold text-muted-foreground">{title}</p>
      <ul className="space-y-1.5">
        {posts.map((p) => (
          <li key={p.id} className="flex items-center gap-2 rounded-md border px-2 py-1.5">
            {p.thumbnailUrl ? (
              // 인스타 CDN 이미지 — next/image 도메인 설정 없이 그대로 쓴다.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={p.thumbnailUrl}
                alt=""
                className="size-10 shrink-0 rounded object-cover"
                loading="lazy"
              />
            ) : (
              <div className="size-10 shrink-0 rounded bg-muted" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs">{p.caption?.split("\n")[0] || "(캡션 없음)"}</p>
              <p className="text-[11px] text-muted-foreground tabular-nums">
                {p.postedAt && <RelativeTime iso={p.postedAt} format="date" />}
                {" · "}
                {p.productType === "REELS" ? "릴스" : "피드"}
                {" · "}
                {rankKey === "views" ? "조회" : "좋아요"} {fmt(p[rankKey] as number)}
                {p.saved != null && ` · 저장 ${fmt(p.saved)}`}
                {p.shares != null && ` · 공유 ${fmt(p.shares)}`}
              </p>
            </div>
            {p.permalink && (
              <a
                href={p.permalink}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent"
                aria-label="인스타에서 보기"
              >
                <ExternalLink className="size-3.5" />
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
