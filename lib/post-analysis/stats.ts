// 게시물 성과 분석 — 숫자 계산. 화면과 워커가 같이 쓰는 순수 함수(ig-audit-ko 기준).
//
// 조회수는 계정 인사이트 views로 본다. 공개 조회수(view_count)는 광고 조회가 합쳐진 것으로 보이는
// 릴스가 있어서 순위에 쓰지 않는다(2026-11-04 jjoongb 최대 445만 대 46.6만).
// 도달이 조회수의 10% 미만이면 옛 데이터가 깨진 것으로 보고 공유 · 저장 비율을 내지 않는다
// (joongdi 2024-11-25 이전 304개). 댓글 수는 댓글 요청 글에서 크게 늘어 인기 지표로 쓰지 않는다.

export interface ReelRow {
  id: string;
  mediaId: string;
  postedAt: string | null;
  url: string | null;
  title: string;
  views: number | null;
  publicViews: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saved: number | null;
  watchSec: number | null;
  thumb: string | null;
}

const DAY_MS = 86_400_000;
const YOUNG_DAYS = 3;
const REACH_VALID_RATIO = 0.1;
const AD_RATIO = 1.1;

export const TIERS = [10, 3, 2] as const;

// 게시물 성과 화면의 기간 — 기본은 90일. 전체 기간은 릴스가 많은 계정에서 느리다
export const POST_PERIODS = ["90", "30", "365", "all"] as const;
export type PostPeriod = (typeof POST_PERIODS)[number];

export function parsePostPeriod(value: string | undefined): PostPeriod {
  return POST_PERIODS.find((p) => p === value) ?? "90";
}

export function periodStart(period: PostPeriod, now: number): number {
  return period === "all" ? 0 : now - Number(period) * DAY_MS;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 올린 지 3일 안 됐으면 아직 크는 중 — 평소 계산에서 빼고 표시만 한다. */
export function isYoung(r: Pick<ReelRow, "postedAt">, now: number): boolean {
  return !r.postedAt || now - Date.parse(r.postedAt) < YOUNG_DAYS * DAY_MS;
}

export function reachValid(r: Pick<ReelRow, "views" | "reach">): boolean {
  return !!r.views && !!r.reach && r.reach / r.views >= REACH_VALID_RATIO;
}

/** 도달 1,000명당 비율. 도달 값이 깨진 릴스는 null. */
export function perThousand(value: number | null, r: Pick<ReelRow, "views" | "reach">): number | null {
  if (value == null || !reachValid(r)) return null;
  return (value / (r.reach as number)) * 1000;
}

export function isAdEstimated(r: Pick<ReelRow, "views" | "publicViews">): boolean {
  return !!r.views && !!r.publicViews && r.publicViews / r.views >= AD_RATIO;
}

// 캡션 단어 기준이라 할인 행사 글도 섞인다 — 화면에서 단정하지 않는다
const EVENT = /경품|당첨|추첨|나눔|증정|이벤트|아이패드|응모|#event/i;
const CTA = /댓글|디엠|\bdm\b/i;
export const isEventLike = (caption: string) => EVENT.test(caption);
export const isCtaLike = (caption: string) => CTA.test(caption);

/** 평소 조회수 — 올린 지 3일 지난 릴스의 중앙값. */
export function baseViews(rows: ReelRow[], now: number): number | null {
  return median(rows.filter((r) => !isYoung(r, now) && r.views != null).map((r) => r.views as number));
}

/** 한국 날짜 (YYYY-MM-DD). */
export const kstDay = (iso: string) => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 10);

function halfOf(iso: string): string {
  const d = new Date(Date.parse(iso) + 9 * 3600_000);
  return `${d.getUTCFullYear()}${d.getUTCMonth() < 6 ? "상" : "하"}`;
}

/** 글자 수 자르기 — 이모지 한가운데서 잘리면 깨진 글자가 남아 OpenAI · jsonb가 거절한다(2026-11-04 실측 400 Invalid body). */
export const clip = (s: string, n: number) => s.slice(0, n).replace(/\p{Cs}/gu, "");

const round = (n: number | null, digits = 1) => (n == null ? null : Math.round(n * 10 ** digits) / 10 ** digits);

export interface TopicLift {
  name: string;
  n: number;
  over2x: number;
  rate: number;
}

export interface ReelStats {
  reels: number;
  withViews: number;
  base: number | null;
  x3: number;
  x10: number;
  firstDate: string | null;
  lastDate: string | null;
  recent90: { n: number; base: number | null; x3: number; top: number | null };
  halves: { half: string; n: number; base: number | null; watchSec: number | null; perMonth: number }[];
  x3ByHalf: { half: string; n: number }[];
  eventLike: { n: number; x3: number };
  ctaCommentRate: { cta: number | null; other: number | null; ctaN: number; otherN: number };
  hitsVsRest: { hits: number; rest: number; hitSave: number | null; restSave: number | null; hitShare: number | null; restShare: number | null; hitWatch: number | null; restWatch: number | null } | null;
  brokenReach: number;
  adEstimated: { n: number; checked: number; biggest: { publicViews: number; views: number } | null };
  overall2xRate: number;
  topics: TopicLift[];
  top: { title: string; views: number; x: number; date: string | null; share: number | null; save: number | null; watch: number | null; event: boolean; ad: boolean }[];
  bottom: { title: string; views: number; x: number; date: string | null }[];
}

/** 주제 키워드(AI가 제안)별로 같은 반기 평소의 2배를 넘은 비율을 코드가 센다. */
export function computeStats(rows: ReelRow[], captions: Map<string, string>, now: number, topics: { name: string; keywords: string[] }[] = []): ReelStats {
  const withViews = rows.filter((r) => r.views != null);
  const mature = withViews.filter((r) => !isYoung(r, now));
  const base = median(mature.map((r) => r.views as number));
  const x = (r: ReelRow) => (base && r.views != null ? (r.views as number) / base : 0);
  const caption = (r: ReelRow) => captions.get(r.id) ?? r.title;

  const dates = withViews.map((r) => r.postedAt).filter((d): d is string => !!d).sort();

  const since90 = now - 90 * DAY_MS;
  const recent = mature.filter((r) => r.postedAt && Date.parse(r.postedAt) >= since90);
  const recentBase = median(recent.map((r) => r.views as number));

  const byHalf = new Map<string, ReelRow[]>();
  for (const r of mature) {
    if (!r.postedAt) continue;
    const k = halfOf(r.postedAt);
    byHalf.set(k, [...(byHalf.get(k) ?? []), r]);
  }
  const halfKeys = [...byHalf.keys()].sort();
  const halves = halfKeys.map((half) => {
    const list = byHalf.get(half) as ReelRow[];
    return {
      half,
      n: list.length,
      base: median(list.map((r) => r.views as number)),
      watchSec: round(median(list.map((r) => r.watchSec).filter((w): w is number => w != null))),
      perMonth: round(list.length / 6) as number,
    };
  });
  const halfBase = new Map(halves.map((h) => [h.half, h.base]));
  const over2xOfHalf = (r: ReelRow) => {
    const b = r.postedAt ? halfBase.get(halfOf(r.postedAt)) : null;
    return !!b && (r.views as number) >= b * 2;
  };

  const x3Rows = mature.filter((r) => x(r) >= 3);
  const x3ByHalf = halfKeys.map((half) => ({ half, n: x3Rows.filter((r) => r.postedAt && halfOf(r.postedAt) === half).length })).filter((h) => h.n > 0);

  // 댓글 비율 (댓글 ÷ 조회) — 댓글 요청 글과 나머지
  const commentRate = (list: ReelRow[]) => round(median(list.filter((r) => r.views && r.comments != null).map((r) => ((r.comments as number) / (r.views as number)) * 100)), 2);
  const ctaRows = mature.filter((r) => isCtaLike(caption(r)));
  const otherRows = mature.filter((r) => !isCtaLike(caption(r)));

  // 잘된 릴스(같은 반기 평소의 2배)와 나머지 — 도달 값이 정상인 릴스만, 경품 글 제외
  const valid = mature.filter((r) => reachValid(r) && !isEventLike(caption(r)));
  const hits = valid.filter(over2xOfHalf);
  const rest = valid.filter((r) => !over2xOfHalf(r));
  const avgRate = (list: ReelRow[], pick: (r: ReelRow) => number | null) => {
    const v = list.map((r) => perThousand(pick(r), r)).filter((n): n is number => n != null);
    return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length, 2) : null;
  };
  const watch = (list: ReelRow[]) => round(median(list.map((r) => r.watchSec).filter((w): w is number => w != null)));

  const checked = withViews.filter((r) => r.publicViews != null);
  const ads = checked.filter(isAdEstimated);
  const biggest = [...ads].sort((a, b) => (b.publicViews as number) - (b.views as number) - ((a.publicViews as number) - (a.views as number)))[0];

  const topicLifts: TopicLift[] = topics.flatMap((t) => {
    const words = t.keywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
    if (!words.length) return [];
    const list = valid.filter((r) => {
      const c = caption(r).toLowerCase();
      return words.some((w) => c.includes(w));
    });
    if (list.length < 3) return [];
    const over2x = list.filter(over2xOfHalf).length;
    return [{ name: t.name, n: list.length, over2x, rate: Math.round((over2x / list.length) * 100) }];
  });

  const rankBy = [...mature].sort((a, b) => (b.views as number) - (a.views as number));

  return {
    reels: rows.length,
    withViews: withViews.length,
    base,
    x3: x3Rows.length,
    x10: mature.filter((r) => x(r) >= 10).length,
    firstDate: dates[0] ? kstDay(dates[0]) : null,
    lastDate: dates.length ? kstDay(dates[dates.length - 1]) : null,
    recent90: { n: recent.length, base: recentBase, x3: recent.filter((r) => x(r) >= 3).length, top: recent.length ? Math.max(...recent.map((r) => r.views as number)) : null },
    halves,
    x3ByHalf,
    eventLike: { n: mature.filter((r) => isEventLike(caption(r))).length, x3: x3Rows.filter((r) => isEventLike(caption(r))).length },
    ctaCommentRate: { cta: commentRate(ctaRows), other: commentRate(otherRows), ctaN: ctaRows.length, otherN: otherRows.length },
    hitsVsRest:
      hits.length >= 5 && rest.length >= 5
        ? {
            hits: hits.length,
            rest: rest.length,
            hitSave: avgRate(hits, (r) => r.saved),
            restSave: avgRate(rest, (r) => r.saved),
            hitShare: avgRate(hits, (r) => r.shares),
            restShare: avgRate(rest, (r) => r.shares),
            hitWatch: watch(hits),
            restWatch: watch(rest),
          }
        : null,
    brokenReach: withViews.filter((r) => !reachValid(r)).length,
    adEstimated: { n: ads.length, checked: checked.length, biggest: biggest ? { publicViews: biggest.publicViews as number, views: biggest.views as number } : null },
    overall2xRate: valid.length ? Math.round((valid.filter(over2xOfHalf).length / valid.length) * 100) : 0,
    topics: topicLifts,
    top: rankBy.slice(0, 12).map((r) => ({
      title: clip(r.title, 60),
      views: r.views as number,
      x: round(x(r)) as number,
      date: r.postedAt ? kstDay(r.postedAt) : null,
      share: round(perThousand(r.shares, r), 2),
      save: round(perThousand(r.saved, r), 2),
      watch: r.watchSec,
      event: isEventLike(caption(r)),
      ad: isAdEstimated(r),
    })),
    bottom: rankBy.slice(-8).map((r) => ({ title: clip(r.title, 60), views: r.views as number, x: round(x(r), 2) as number, date: r.postedAt ? kstDay(r.postedAt) : null })),
  };
}
