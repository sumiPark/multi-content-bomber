import { AlertTriangle, ExternalLink, Loader2, Users } from "lucide-react";
import Link from "next/link";
import { AddBenchmarkForm, RemoveBenchmarkButton } from "@/components/benchmark/benchmark-controls";
import { BenchmarkInsightPanel } from "@/components/benchmark/benchmark-insight";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { RelativeTime } from "@/components/ui/relative-time";
import type { BenchmarkData, BenchmarkHit, BenchmarkRow, GroupType } from "@/lib/benchmark/load";
import { paceLabel } from "@/lib/benchmark/style-stats";
import { cn } from "@/lib/utils";

// 분석 · 다른 계정 비교 — 우리 계정마다 참고 계정 목록(고른 이유 + 수집 숫자 근거)과 평소보다 잘된 릴스.
// 숫자는 공개 조회수 기준(광고 조회 포함)이라 우리 계정도 같은 기준으로 나란히 둔다. 서버 컴포넌트.

const GROUP_LABEL: Record<GroupType, string> = {
  SAME: "같은 분야",
  ADJACENT: "비슷한 시청자",
  LARGE: "큰 계정 · 형식만 참고",
};

const count = (n: number | null | undefined) => (n == null ? "-" : n.toLocaleString("ko-KR"));

/** 1,234 · 1.2만 · 123만 */
function short(n: number | null | undefined): string {
  if (n == null) return "-";
  if (n < 10_000) return n.toLocaleString("ko-KR");
  const man = n / 10_000;
  return `${man < 100 ? man.toFixed(1).replace(/\.0$/, "") : Math.round(man)}만`;
}

function daysSince(iso: string | null, now: number): number | null {
  return iso ? Math.max(0, Math.floor((now - Date.parse(iso)) / 86_400_000)) : null;
}

/** 수집 숫자로 만든 근거 — 고른 이유와 따로 보여 준다. */
function evidence(r: BenchmarkRow, own: BenchmarkData["own"], now: number): { label: string; value: string; warn?: boolean }[] {
  const reach = r.followers && r.medianViews != null ? Math.round((r.medianViews / r.followers) * 100) : null;
  const last = daysSince(r.lastPostAt, now);
  const out: { label: string; value: string; warn?: boolean }[] = [
    {
      label: "팔로워",
      value: `${short(r.followers)}${own?.followers && r.followers ? ` (우리의 ${(r.followers / own.followers).toFixed(r.followers / own.followers < 1 ? 2 : 1)}배)` : ""}`,
    },
    { label: "평소 조회", value: `${short(r.medianViews)}${reach != null ? ` (팔로워의 ${reach}%)` : ""}` },
    { label: "3배 넘게 잘된 릴스", value: `${r.hits}개${r.adSuspected ? ` (광고 의심 ${r.adSuspected}개 제외)` : ""}` },
    { label: "최근 글", value: last == null ? "-" : `${last}일 전`, warn: last != null && last > 30 },
    { label: "30일 릴스", value: `${r.reels30d ?? "-"}개`, warn: r.reels30d === 0 },
  ];
  return out;
}

function AccountRow({ row, own, now, canEdit }: { row: BenchmarkRow; own: BenchmarkData["own"]; now: number; canEdit: boolean }) {
  const failed = row.status === "NOT_FOUND" || row.status === "ERROR";
  return (
    <li className="space-y-2 border-t px-4 py-3.5 first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <a
          href={`https://www.instagram.com/${row.username}/`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-sm font-semibold underline-offset-2 hover:underline"
        >
          @{row.username}
          <ExternalLink className="size-3 text-muted-foreground" aria-hidden />
        </a>
        <Badge variant={row.groupType === "SAME" ? "default" : "secondary"}>{GROUP_LABEL[row.groupType]}</Badge>
        {row.source === "MANUAL" && <Badge variant="outline">직접 추가</Badge>}
        {canEdit && (
          <span className="ml-auto">
            <RemoveBenchmarkButton linkId={row.linkId} username={row.username} />
          </span>
        )}
      </div>

      {row.status === "PENDING" ? (
        <p className="flex items-center gap-1.5 text-xs text-primary">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          아직 읽지 못했어요. 보통 1~2분이면 채워지고, 호출 한도에 걸리면 다음 자동 수집(매일 04:50)에 채워져요.
        </p>
      ) : failed ? (
        <p className="flex items-start gap-1.5 text-xs text-risk">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          {row.error ?? "읽지 못했어요."}
        </p>
      ) : (
        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
          {evidence(row, own, now).map((e) => (
            <div key={e.label} className="flex items-baseline gap-1.5">
              <dt className="text-muted-foreground">{e.label}</dt>
              <dd className={cn("font-semibold tabular-nums", e.warn && "text-warn")}>{e.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {row.reason && (
        <p className="max-w-4xl text-[13px] text-ink-2">
          <span className="text-muted-foreground">고른 이유 </span>
          {row.reason}
        </p>
      )}
    </li>
  );
}

function HitCard({ hit, now }: { hit: BenchmarkHit; now: number }) {
  const days = daysSince(hit.postedAt, now);
  return (
    <li className="flex gap-3 rounded-lg border bg-card p-3">
      <div className="h-[106px] w-[60px] shrink-0 overflow-hidden rounded-md bg-surface-3">
        {hit.thumbnailUrl && (
          // 인스타 CDN 표지 — 매일 수집 때 새 주소로 바뀐다. next/image 도메인 설정 없이 그대로 쓴다.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={hit.thumbnailUrl} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-full object-cover" />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-base font-bold tabular-nums">평소의 {hit.multiple.toFixed(1)}배</p>
          <p className="truncate text-xs text-muted-foreground">@{hit.username}</p>
        </div>
        <p className="line-clamp-2 text-[13px] text-ink-2">{hit.hook || "(캡션 없음)"}</p>
        <p className="text-xs text-muted-foreground tabular-nums">
          조회 {short(hit.views)} · 좋아요 {short(hit.likes)} · 댓글 {count(hit.comments)}
          {days != null && ` · ${days}일 전`}
        </p>
        {hit.campaign && (
          <p className="flex items-start gap-1 text-xs text-warn">
            <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
            평소와 차이가 아주 커요. 광고나 유명인 영상일 수 있으니 형식만 참고하세요.
          </p>
        )}
        {hit.bannedPhrases.length > 0 && (
          <p className="flex items-start gap-1 text-xs text-risk">
            <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
            그대로 쓰면 안 돼요. 광고 문구 규칙에 걸리는 표현: {hit.bannedPhrases.join(", ")}
          </p>
        )}
        {hit.style && (
          <p className="text-xs text-ink-2">
            {hit.style.note}
            {hit.styleSource === "COVER" && <span className="text-muted-foreground"> (표지만 봄)</span>}
          </p>
        )}
        {hit.style && hit.styleSource === "VIDEO" && (
          <div className="flex flex-wrap gap-1">
            {[hit.style.opening, hit.style.shooting, paceLabel(hit.style.cutsPer10s), hit.style.speech ? "말함" : "말 없음", hit.style.durationSec != null ? `${Math.round(hit.style.durationSec)}초` : null]
              .filter((v): v is string => !!v && v !== "알 수 없음" && v !== "기타")
              .map((v) => (
                <Badge key={v} variant="outline">
                  {v}
                </Badge>
              ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {hit.formula && hit.formula !== "미분류" && <Badge variant="secondary">{hit.formula}</Badge>}
          {hit.permalink && (
            <a href={hit.permalink} target="_blank" rel="noreferrer" className="text-xs text-primary underline-offset-2 hover:underline">
              인스타에서 보기
            </a>
          )}
        </div>
      </div>
    </li>
  );
}

export function BenchmarkView({
  accounts,
  selectedId,
  data,
  canEdit,
  now,
}: {
  accounts: { id: string; name: string; linkCount: number }[];
  selectedId: string;
  data: BenchmarkData;
  canEdit: boolean;
  now: number;
}) {
  const selected = accounts.find((a) => a.id === selectedId);
  const collected = data.rows.filter((r) => r.status === "OK");
  const reachBetter = data.own?.medianViews != null ? collected.filter((r) => (r.medianViews ?? 0) > (data.own?.medianViews ?? 0)).length : null;

  return (
    <section aria-label="다른 계정 비교" className="space-y-4">
      <nav aria-label="우리 계정 고르기" className="inline-flex w-fit max-w-full items-center overflow-x-auto rounded-md border bg-surface-2 p-[2px]">
        {accounts.map((a) => {
          const on = a.id === selectedId;
          return (
            <Link
              key={a.id}
              href={`/analytics?tab=compare&account=${a.id}`}
              aria-current={on ? "page" : undefined}
              className={cn(
                "inline-flex h-[30px] items-center gap-1.5 rounded-[6px] px-3 text-[12.5px] font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                on && "bg-card font-semibold text-foreground shadow-[0_1px_2px_rgb(16_24_40/0.12)]",
              )}
            >
              {a.name}
              <span className="text-xs text-muted-foreground tabular-nums">{a.linkCount}</span>
            </Link>
          );
        })}
      </nav>

      {data.rows.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <Users className="size-10 text-muted-foreground" aria-hidden />
            <h2 className="text-lg font-semibold">{selected?.name ?? "이 계정"}의 비교 계정이 아직 없어요</h2>
            <p className="max-w-md text-sm text-muted-foreground">참고하고 싶은 인스타 비즈니스 · 크리에이터 계정을 아래에서 추가하세요.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {data.own && (
            <Card>
              <CardContent className="flex flex-wrap items-baseline gap-x-8 gap-y-2 py-4">
                <p className="text-sm font-semibold">우리 계정 @{data.own.username}</p>
                <p className="text-sm">
                  <span className="text-muted-foreground">팔로워 </span>
                  <b className="tabular-nums">{short(data.own.followers)}</b>
                </p>
                <p className="text-sm">
                  <span className="text-muted-foreground">평소 조회 </span>
                  <b className="tabular-nums">{short(data.own.medianViews)}</b>
                </p>
                <p className="text-sm">
                  <span className="text-muted-foreground">3배 넘게 잘된 릴스 </span>
                  <b className="tabular-nums">{data.own.hits}개</b>
                </p>
                {reachBetter != null && collected.length > 0 && (
                  <p className="text-sm text-muted-foreground">
                    비교 계정 {collected.length}개 중 {reachBetter}개가 우리보다 평소 조회가 높아요
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          <BenchmarkInsightPanel insight={data.insight} hasHits={data.hits.length > 0} />

          <div className="space-y-2">
            <div>
              <h2 className="text-base font-semibold">평소보다 잘된 릴스</h2>
              <p className="text-[13px] text-muted-foreground">
                그 계정 평소 조회의 3배를 넘은 최근 6개월 릴스를 계정당 3개까지 골랐어요. 조회수에 비해 좋아요가 너무 적은 릴스는 광고로 키운 것으로 보고 뺐어요. 영상을 베끼지 말고 첫 줄과 구성만 참고하세요.
              </p>
            </div>
            {data.hits.length ? (
              <ul className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
                {data.hits.map((h) => (
                  <HitCard key={h.id} hit={h} now={now} />
                ))}
              </ul>
            ) : (
              <p className="rounded-md bg-surface-2 px-3 py-2.5 text-[13px] text-muted-foreground">아직 3배를 넘은 릴스가 없어요.</p>
            )}
          </div>

          <div className="space-y-2">
            <h2 className="text-base font-semibold">비교 계정 {data.rows.length}개</h2>
            <Card className="py-0">
              <ul>
                {data.rows.map((r) => (
                  <AccountRow key={r.linkId} row={r} own={data.own} now={now} canEdit={canEdit} />
                ))}
              </ul>
            </Card>
            {data.rows.some((r) => r.lastCollectedAt) && (
              <p className="text-xs text-muted-foreground">
                숫자는 매일 04:50에 새로 읽어요. 마지막 수집{" "}
                <RelativeTime iso={data.rows.map((r) => r.lastCollectedAt).filter((x): x is string => !!x).sort().at(-1) as string} />.
                공개 조회수 기준이라 광고 조회가 포함될 수 있고, 저장 · 공유 수는 다른 계정이라 볼 수 없어요.
              </p>
            )}
          </div>
        </>
      )}

      {canEdit && <AddBenchmarkForm socialAccountId={selectedId} />}
    </section>
  );
}
