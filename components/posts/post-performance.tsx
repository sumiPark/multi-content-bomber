"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, History, Loader2 } from "lucide-react";
import { PostFindings } from "@/components/posts/post-findings";
import { PostTimeline } from "@/components/posts/post-timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Segmented } from "@/components/ui/segmented";
import type { PerfRow, PostPerformanceData } from "@/lib/post-analysis/load";
import { baseViews, isAdEstimated, isYoung, kstDay, periodStart, perThousand, type PostPeriod } from "@/lib/post-analysis/stats";

// 분석 · 게시물 성과 — 계정의 모든 릴스를 평소 대비 배수로 본다(ig-audit-ko).
// 배수는 고른 기간의 평소 조회수로 다시 계산한다. 전체 기간 하나로 보면 예전 이벤트가 터진 계정은
// 최근 릴스가 전부 작게 나온다(2026-11-04 joongdi: 3배 넘은 81개 중 55개가 2024년 3~4월, 최근 90일 0개).

type Tier = "all" | "2" | "3" | "10" | "share" | "ad";
type SortKey = "views" | "likes" | "shareRate" | "saveRate" | "watch" | "recent";
type View = "card" | "table";

const PAGE_SIZE = 24;
// "공유 많음" — 도달 값이 정상인 릴스 중 공유 비율 상위 10%
const SHARE_TOP = 0.1;

const SORTS: { value: SortKey; label: string }[] = [
  { value: "views", label: "조회수 많은 순" },
  { value: "shareRate", label: "공유 비율 높은 순" },
  { value: "saveRate", label: "저장 비율 높은 순" },
  { value: "likes", label: "좋아요 많은 순" },
  { value: "watch", label: "평균 시청 긴 순" },
  { value: "recent", label: "최근 순" },
];

const num = (n: number | null | undefined) => (n == null ? "-" : n.toLocaleString("ko-KR"));
const rate = (v: number | null) => (v == null ? "-" : `${v.toFixed(1)}명`);

function short(n: number | null | undefined): string {
  if (n == null) return "-";
  if (n < 10_000) return n.toLocaleString("ko-KR");
  const man = n / 10_000;
  return `${man < 100 ? man.toFixed(1).replace(/\.0$/, "") : Math.round(man)}만`;
}

interface Computed extends PerfRow {
  x: number | null;
  shareRate: number | null;
  saveRate: number | null;
  young: boolean;
  ad: boolean;
  shareTop: boolean;
}

function Flags({ r }: { r: Computed }) {
  return (
    <>
      {r.young && <Badge variant="secondary">아직 크는 중</Badge>}
      {r.shareTop && <Badge variant="default">공유 많음</Badge>}
      {r.ad && <Badge variant="warn">광고 포함 추정</Badge>}
      {r.eventLike && <Badge variant="outline">경품 · 이벤트 말</Badge>}
      {r.ctaLike && <Badge variant="outline">댓글 요청 글</Badge>}
    </>
  );
}

function ReelCard({ r, rank }: { r: Computed; rank: number }) {
  return (
    <li className="flex gap-3 rounded-lg border bg-card p-3">
      <div className="h-[124px] w-[70px] shrink-0 overflow-hidden rounded-md bg-surface-3">
        {r.thumb && (
          // 저장소 서명 주소 — next/image 도메인 설정 없이 그대로 쓴다.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={r.thumb} alt="" loading="lazy" className="size-full object-cover" />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-base font-bold tabular-nums">
            <span className="mr-1.5 text-xs font-semibold text-muted-foreground">{rank}</span>
            {short(r.views)}회
          </p>
          {r.x != null && <p className="shrink-0 text-sm font-semibold tabular-nums">평소의 {r.x.toFixed(1)}배</p>}
        </div>
        <p className="line-clamp-2 text-[13px] text-ink-2">{r.title}</p>
        <p className="text-xs text-muted-foreground tabular-nums">
          좋아요 {short(r.likes)} · 댓글 {short(r.comments)} · 공유 {short(r.shares)} · 저장 {short(r.saved)}
          {r.watchSec != null && ` · 평균 ${r.watchSec.toFixed(1)}초`}
        </p>
        {(r.shareRate != null || r.saveRate != null) && (
          <p className="text-xs text-muted-foreground tabular-nums">
            1,000명이 보면 공유 {rate(r.shareRate)} · 저장 {rate(r.saveRate)}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          <Flags r={r} />
          {r.url && (
            <a href={r.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-xs text-primary underline-offset-2 hover:underline">
              {r.postedAt && kstDay(r.postedAt)} 보기
              <ExternalLink className="size-3" aria-hidden />
            </a>
          )}
        </div>
      </div>
    </li>
  );
}

function ReelTable({ rows }: { rows: Computed[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full min-w-[920px] text-[13px]">
        <thead className="bg-surface-2 text-xs text-muted-foreground">
          <tr className="h-11 text-left">
            <th scope="col" className="px-3.5 font-medium">릴스</th>
            <th scope="col" className="px-3 font-medium">올린 날</th>
            {["조회", "배수", "좋아요", "댓글", "공유", "저장", "공유(1,000명당)", "저장(1,000명당)", "평균 시청"].map((h) => (
              <th key={h} scope="col" className="px-3 text-right font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="h-[52px] border-t">
              <td className="max-w-[300px] truncate px-3.5">
                {r.url ? (
                  <a href={r.url} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                    {r.title}
                  </a>
                ) : (
                  r.title
                )}
              </td>
              <td className="px-3 whitespace-nowrap tabular-nums">{r.postedAt && kstDay(r.postedAt)}</td>
              <td className="px-3 text-right font-semibold tabular-nums">{num(r.views)}</td>
              <td className="px-3 text-right tabular-nums">{r.x == null ? "-" : `${r.x.toFixed(1)}배`}</td>
              <td className="px-3 text-right tabular-nums">{num(r.likes)}</td>
              <td className="px-3 text-right tabular-nums">{num(r.comments)}</td>
              <td className="px-3 text-right tabular-nums">{num(r.shares)}</td>
              <td className="px-3 text-right tabular-nums">{num(r.saved)}</td>
              <td className="px-3 text-right tabular-nums">{rate(r.shareRate)}</td>
              <td className="px-3 text-right tabular-nums">{rate(r.saveRate)}</td>
              <td className="px-3 text-right tabular-nums">{r.watchSec == null ? "-" : `${r.watchSec.toFixed(1)}초`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PostPerformance({ data, now, period, accountId }: { data: PostPerformanceData; now: number; period: PostPeriod; accountId: string }) {
  const router = useRouter();
  const [changing, startChange] = useTransition();
  // 고르기 전에는 3배부터, 이 기간에 3배 넘은 릴스가 없으면 전체
  const [tierPick, setTier] = useState<Tier | null>(null);
  const [sort, setSort] = useState<SortKey>("views");
  const [view, setView] = useState<View>("card");
  const [hideEvents, setHideEvents] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);

  // 기간을 바꾸면 그 기간 릴스만 서버에서 다시 읽는다
  const from = periodStart(period, now);
  const pickPeriod = (next: PostPeriod) => {
    setLimit(PAGE_SIZE);
    startChange(() => router.push(`/analytics?tab=posts&account=${accountId}&period=${next}`, { scroll: false }));
  };

  const { rows, base } = useMemo(() => {
    const inPeriod = data.rows.filter((r) => r.views != null && (!hideEvents || !r.eventLike));
    const b = baseViews(inPeriod, now);
    const shareRates = inPeriod.map((r) => perThousand(r.shares, r)).filter((n): n is number => n != null).sort((x, y) => y - x);
    const cut = shareRates[Math.floor(shareRates.length * SHARE_TOP)] ?? Infinity;
    const computed: Computed[] = inPeriod.map((r) => {
      const shareRate = perThousand(r.shares, r);
      return {
        ...r,
        x: b ? (r.views as number) / b : null,
        shareRate,
        saveRate: perThousand(r.saved, r),
        young: isYoung(r, now),
        ad: isAdEstimated(r),
        shareTop: shareRate != null && shareRate > 0 && shareRate >= cut,
      };
    });
    return { rows: computed, base: b };
  }, [data.rows, hideEvents, now]);

  const counts = useMemo(() => {
    const n = (min: number) => rows.filter((r) => (r.x ?? 0) >= min).length;
    return { x2: n(2), x3: n(3), x10: n(10), share: rows.filter((r) => r.shareTop).length, ad: rows.filter((r) => r.ad).length };
  }, [rows]);

  const tier: Tier = tierPick ?? (counts.x3 ? "3" : "all");

  const shown = useMemo(() => {
    const f = rows.filter((r) => {
      if (tier === "all") return true;
      if (tier === "share") return r.shareTop;
      if (tier === "ad") return r.ad;
      return (r.x ?? 0) >= Number(tier);
    });
    const value = (r: Computed): number => {
      if (sort === "views") return r.views ?? -1;
      if (sort === "likes") return r.likes ?? -1;
      if (sort === "shareRate") return r.shareRate ?? -1;
      if (sort === "saveRate") return r.saveRate ?? -1;
      if (sort === "watch") return r.watchSec ?? -1;
      return r.postedAt ? Date.parse(r.postedAt) : 0;
    };
    return [...f].sort((a, b) => value(b) - value(a));
  }, [rows, tier, sort]);

  if (data.read === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
          <History className="size-8 text-muted-foreground" aria-hidden />
          <h2 className="text-lg font-semibold">지난 릴스를 아직 읽지 않았어요</h2>
          <p className="max-w-md text-sm text-muted-foreground">매일 05:10에 지난 릴스를 차례로 읽어요. 첫 수집이 끝나면 여기에 나와요.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {(!data.listed || data.pending > 0) && (
        <p className="flex items-center gap-1.5 rounded-md bg-brand-soft px-3 py-2 text-xs text-ink-2">
          <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden />
          {data.listed
            ? `지난 릴스 ${num(data.total)}개 중 ${num(data.read)}개를 읽었어요. 나머지는 다음 수집에 이어서 읽어요. 지금 숫자는 일부 기준이에요.`
            : `지난 릴스 목록을 아직 읽지 않았어요. 지금은 최근 ${num(data.read)}개 기준이라 평소 조회수와 배수가 달라질 수 있어요.`}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Segmented<PostPeriod>
          ariaLabel="기간"
          value={period}
          disabled={changing}
          onChange={pickPeriod}
          options={[
            { value: "90", label: "90일" },
            { value: "30", label: "30일" },
            { value: "365", label: "1년" },
            { value: "all", label: "전체 기간" },
          ]}
        />
        {changing && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="불러오는 중" />}
        <label className="flex items-center gap-1.5 text-[13px] text-ink-2">
          <input type="checkbox" checked={hideEvents} onChange={(e) => setHideEvents(e.target.checked)} className="size-4 accent-primary" />
          경품 · 이벤트 말 든 글 빼기
        </label>
      </div>

      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "릴스", value: `${num(rows.length)}개`, sub: period === "all" ? "성과를 읽은 전체" : "고른 기간" },
          { label: "평소 조회수", value: short(base), sub: "올린 지 3일 지난 릴스의 중앙값" },
          { label: "3배 넘은 릴스", value: `${counts.x3}개`, sub: "고른 기간의 평소 기준" },
          { label: "10배 넘은 릴스", value: `${counts.x10}개`, sub: "고른 기간의 평소 기준" },
        ].map((t) => (
          <div key={t.label} className="rounded-lg border bg-card p-4">
            <dt className="text-xs font-medium text-muted-foreground">{t.label}</dt>
            <dd className="mt-1 text-2xl font-bold tabular-nums">{t.value}</dd>
            <dd className="mt-0.5 text-xs text-muted-foreground">{t.sub}</dd>
          </div>
        ))}
      </dl>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <section aria-label="언제 터졌나" className="rounded-lg border bg-card p-4">
          <h2 className="text-[15px] font-semibold">언제 터졌나</h2>
          <p className="text-[13px] text-muted-foreground">점 하나가 릴스 하나예요. 점선이 평소 조회수, 파란 점이 3배를 넘은 릴스예요. 세로축은 한 칸에 10배씩 커져요.</p>
          <div className="mt-3">
            <PostTimeline rows={rows} base={base} from={from} now={now} />
          </div>
        </section>

        <PostFindings analysis={data.analysis} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Segmented<Tier>
          ariaLabel="터진 정도"
          value={tier}
          onChange={(v) => {
            setTier(v);
            setLimit(PAGE_SIZE);
          }}
          options={[
            { value: "10", label: `10배↑ ${counts.x10}` },
            { value: "3", label: `3배↑ ${counts.x3}` },
            { value: "2", label: `2배↑ ${counts.x2}` },
            { value: "all", label: `전체 ${rows.length}` },
            { value: "share", label: `공유 많음 ${counts.share}` },
            { value: "ad", label: `광고 포함 추정 ${counts.ad}` },
          ]}
        />
        <select
          aria-label="정렬"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          className="h-9 rounded-md border border-input bg-card px-3 text-base focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none sm:text-[13px]"
        >
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <span className="ml-auto">
          <Segmented<View>
            ariaLabel="보기 방식"
            value={view}
            onChange={setView}
            options={[
              { value: "card", label: "카드" },
              { value: "table", label: "표" },
            ]}
          />
        </span>
      </div>

      {shown.length === 0 ? (
        <p className="rounded-md bg-surface-2 px-3 py-6 text-center text-[13px] text-muted-foreground">이 기간에 해당하는 릴스가 없어요. 기간이나 터진 정도를 바꿔 보세요.</p>
      ) : view === "card" ? (
        <ul className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {shown.slice(0, limit).map((r, i) => (
            <ReelCard key={r.id} r={r} rank={i + 1} />
          ))}
        </ul>
      ) : (
        <ReelTable rows={shown.slice(0, limit)} />
      )}
      {shown.length > limit && (
        <div className="text-center">
          <Button variant="outline" size="sm" onClick={() => setLimit((n) => n + PAGE_SIZE)}>
            {num(shown.length - limit)}개 더 보기
          </Button>
        </div>
      )}

      <details className="rounded-lg border bg-card px-4 py-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer text-[13px] font-medium text-ink-2">이 숫자를 읽는 법</summary>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          <li>조회수는 계정 인사이트 값이에요. 공개 조회수가 10% 넘게 크면 &quot;광고 포함 추정&quot;으로 표시해요. 공개 조회수는 최근 릴스만 읽어서 옛 릴스는 판단하지 않아요.</li>
          <li>배수는 조회수 ÷ 고른 기간의 평소 조회수예요. 기간을 바꾸면 배수도 바뀌어요.</li>
          <li>공유 · 저장 비율은 도달 1,000명당 몇 명인지예요. 도달이 조회수의 10%도 안 되는 옛 릴스는 도달 값이 깨진 것으로 보고 비율을 빼요.</li>
          <li>&quot;경품 · 이벤트 말&quot; · &quot;댓글 요청 글&quot;은 캡션 단어로 나눠 할인 글도 섞일 수 있어요. 댓글 요청 글은 댓글이 많이 늘어서 댓글 수를 인기로 읽으면 안 돼요.</li>
          <li>제목은 캡션 앞부분이에요. 영상 첫 마디 · 3초 유지율 · 게시물별 팔로우는 인스타가 주지 않아요.</li>
          <li>표지는 3배 넘은 릴스와 최근 릴스 위주로 보관해요. 나머지는 표지 없이 나올 수 있어요.</li>
          <li>피드 사진 · 캐러셀은 빠져 있어요. 릴스만 비교해요.</li>
        </ul>
      </details>
    </div>
  );
}
