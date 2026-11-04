import { AlertTriangle, ArrowDown, ArrowUp, Loader2, Unplug } from "lucide-react";
import Link from "next/link";
import { CopyButton } from "@/components/account-review/copy-button";
import { FeedReviewSection } from "@/components/account-review/feed-review";
import { ScreenshotUpload } from "@/components/account-review/screenshot-upload";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { RelativeTime } from "@/components/ui/relative-time";
import type { ProfileManualInput, ProfileSnapshot, ReviewItem, ReviewRewrite, ReviewStatus } from "@/lib/account-review/types";
import { cn } from "@/lib/utils";

// 분석 · 프로필 점수 — 요약 칸(계정마다 점수 막대 하나) + 계정별 상세(항목 막대 · 고칠 순서).
// 채점은 매일 04:30 자동(worker/review-profiles.ts)이라 채점 버튼이 없다. 서버 컴포넌트.
//
// 막대 색: 요약 막대는 파랑 한 가지(지금 점수 = 진한 파랑, 고치면 오를 몫 = 옅은 파랑, 빈 곳 = 더 옅은 파랑).
// 항목 막대는 상태 색(많이 깎임 · 조금 깎임 · 좋음)이라 글자 라벨을 항상 같이 쓴다(DESIGN.md 1-4).

export interface ReviewRow {
  id: string;
  status: ReviewStatus;
  total_score: number | null;
  rescore: number | null;
  items: ReviewItem[] | null;
  rewrites: ReviewRewrite[] | null;
  summary: string | null;
  manual_input: unknown;
  snapshot: unknown;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface ProfileScoreAccount {
  id: string;
  name: string;
  active: boolean;
  followers: number | null;
}

const BUSY_MS = 20 * 60_000;

const knownMax = (items: ReviewItem[]) => items.reduce((s, i) => s + (i.score == null ? 0 : i.max), 0);
const pct = (v: number, max: number) => (max > 0 ? Math.round((v / max) * 100) : 0);

/** 팔로워 1,234 · 1.2만 · 12만 */
export function formatFollowers(n: number | null): string {
  if (n == null) return "팔로워 -";
  if (n < 10_000) return `팔로워 ${n.toLocaleString("ko-KR")}`;
  const man = n / 10_000;
  return `팔로워 ${man < 100 ? man.toFixed(1).replace(/\.0$/, "") : Math.round(man)}만`;
}

function level(score: number | null, max: number): { label: string; bar: string; text: string } {
  if (score == null) return { label: "모름", bar: "", text: "text-muted-foreground" };
  const r = score / max;
  if (r < 0.4) return { label: "많이 깎임", bar: "bg-risk", text: "text-risk" };
  if (r < 0.75) return { label: "조금 깎임", bar: "bg-warn", text: "text-warn" };
  return { label: "좋음", bar: "bg-ok", text: "text-ok" };
}

function isBusy(row: ReviewRow | undefined): boolean {
  if (!row || (row.status !== "PENDING" && row.status !== "RUNNING")) return false;
  return Date.now() - Date.parse(row.started_at ?? row.created_at) < BUSY_MS;
}

/** 계정 하나의 요약 값 — 요약 칸과 상세 카드가 같이 쓴다. */
export function summarize(history: ReviewRow[]) {
  const done = history.filter((r) => r.status === "DONE" && r.total_score != null && r.items);
  const latest = done[0] ?? null;
  const previous = done[1] ?? null;
  const items = latest?.items ?? [];
  const max = knownMax(items);
  // 같은 만점일 때만 비교한다 — 캡처로 항목이 늘면 점수 차이가 뜻이 없다
  const delta =
    latest?.total_score != null && previous?.total_score != null && previous.items && knownMax(previous.items) === max
      ? latest.total_score - previous.total_score
      : null;
  return {
    latest,
    items,
    max,
    score: latest?.total_score ?? null,
    rescore: latest?.rescore != null && latest.rescore > (latest.total_score ?? 0) ? latest.rescore : null,
    delta,
    unknown: items.filter((i) => i.score == null),
    rewrites: latest?.rewrites ?? [],
    busy: isBusy(history[0]),
    failed: history[0]?.status === "FAILED" ? history[0] : null,
  };
}

/** 점수 막대 — 지금 점수(진한 파랑) + 고치면 오를 몫(옅은 파랑), 사이 2px 틈. */
function ScoreMeter({ score, rescore, max, className }: { score: number; rescore: number | null; max: number; className?: string }) {
  const now = pct(score, max);
  const gain = rescore != null ? pct(rescore, max) - now : 0;
  return (
    <div
      role="img"
      aria-label={`${max}점 만점에 ${score}점${rescore != null ? `, 고치면 ${rescore}점` : ""}`}
      title={`지금 ${score}/${max}점${rescore != null ? ` · 고치면 ${rescore}점` : ""}`}
      className={cn("flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full bg-brand-soft", className)}
    >
      {now > 0 && <span className="h-full rounded-full bg-primary" style={{ width: `${now}%` }} />}
      {gain > 0 && <span className="h-full rounded-full bg-primary/35" style={{ width: `${gain}%` }} />}
    </div>
  );
}

function Delta({ delta }: { delta: number | null }) {
  if (delta == null || delta === 0) return null;
  const up = delta > 0;
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-xs font-semibold", up ? "text-ok" : "text-risk")}>
      {up ? <ArrowUp className="size-3" aria-hidden /> : <ArrowDown className="size-3" aria-hidden />}
      지난번보다 {Math.abs(delta)}점
    </span>
  );
}

// ── 요약 칸 ─────────────────────────────────────────────────────────────────

export function ProfileScoreOverview({
  accounts,
  histories,
}: {
  accounts: ProfileScoreAccount[];
  histories: Map<string, ReviewRow[]>;
}) {
  const active = accounts.filter((a) => a.active);
  const inactive = accounts.filter((a) => !a.active);
  return (
    <div className="space-y-3">
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {active.map((a) => {
          const s = summarize(histories.get(a.id) ?? []);
          return (
            <li key={a.id}>
              <Link
                href={`#ps-${a.id}`}
                className="flex h-full flex-col gap-2.5 rounded-lg border bg-card p-4 transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate text-sm font-semibold">{a.name}</p>
                  <p className="shrink-0 text-xs text-muted-foreground">{formatFollowers(a.followers)}</p>
                </div>
                {s.score != null ? (
                  <>
                    <div className="flex items-end justify-between gap-2">
                      <p className="text-2xl leading-none font-bold">
                        {s.score}
                        <span className="text-sm font-semibold text-muted-foreground">/{s.max}점</span>
                      </p>
                      {s.rescore != null && (
                        <p className="text-xs text-muted-foreground">
                          고치면 <b className="font-semibold text-primary">{s.rescore}</b>
                        </p>
                      )}
                    </div>
                    <ScoreMeter score={s.score} rescore={s.rescore} max={s.max} />
                    <div className="flex min-h-5 flex-wrap items-center gap-x-2 gap-y-1">
                      <Delta delta={s.delta} />
                      {s.busy && (
                        <span className="inline-flex items-center gap-1 text-xs text-primary">
                          <Loader2 className="size-3 animate-spin" aria-hidden />
                          채점 중
                        </span>
                      )}
                      {s.failed && !s.busy && <span className="text-xs text-risk">마지막 채점 실패</span>}
                      {s.unknown.length > 0 && <span className="text-xs text-muted-foreground">모르는 항목 {s.unknown.length}개</span>}
                    </div>
                    {s.rewrites[0] && (
                      <p className="line-clamp-2 border-t pt-2.5 text-[13px] text-ink-2">
                        <span className="text-muted-foreground">먼저 고칠 것 </span>
                        {s.rewrites[0].title}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-[13px] text-muted-foreground">
                    {s.busy ? "채점 중이에요." : "아직 채점 전이에요. 매일 04:30에 자동으로 채점해요."}
                  </p>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
      {inactive.length > 0 && (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <Unplug className="size-3.5" aria-hidden />
          연결이 끊겨 채점하지 않는 계정 {inactive.length}개:
          <span className="text-ink-2">{inactive.map((a) => a.name).join(" · ")}</span>
          <Link href="/accounts" className="underline underline-offset-2">
            계정 연동에서 다시 연결
          </Link>
        </p>
      )}
    </div>
  );
}

// ── 계정별 상세 ──────────────────────────────────────────────────────────────

function ItemBars({ items }: { items: ReviewItem[] }) {
  // 잃은 점수가 큰 것부터, 모르는 항목은 맨 아래
  const sorted = [...items].sort((a, b) => {
    if (a.score == null || b.score == null) return a.score == null ? (b.score == null ? 0 : 1) : -1;
    return b.max - b.score - (a.max - a.score);
  });
  return (
    <ul className="space-y-3">
      {sorted.map((it) => {
        const lv = level(it.score, it.max);
        return (
          <li key={it.id} className="grid grid-cols-[88px_minmax(0,1fr)_64px] items-center gap-x-3 gap-y-1">
            <p className="truncate text-[13px] font-medium">{it.label}</p>
            <div
              role="img"
              aria-label={`${it.label} ${it.score == null ? "모름" : `${it.max}점 만점에 ${it.score}점, ${lv.label}`}`}
              title={it.reason ?? it.findings.join(" · ")}
              className={cn("h-2 overflow-hidden rounded-full", it.score == null ? "border border-dashed border-line-strong" : "bg-surface-3")}
            >
              {it.score != null && it.score > 0 && <span className={cn("block h-full rounded-full", lv.bar)} style={{ width: `${pct(it.score, it.max)}%` }} />}
            </div>
            <p className="text-right text-[13px] tabular-nums">
              {it.score == null ? <span className="text-muted-foreground">모름</span> : <b className="font-semibold">{it.score}</b>}
              <span className="text-muted-foreground">/{it.max}</span>
            </p>
            <div className="col-span-3 -mt-0.5 flex items-start gap-1.5 text-xs sm:col-start-2 sm:col-end-4">
              <span className={cn("shrink-0 font-medium", lv.text)}>{lv.label}</span>
              <span className="text-faint" aria-hidden>
                ·
              </span>
              <span className="shrink-0 text-muted-foreground">{it.auto ? "규칙" : "AI 판단"}</span>
              <span className="text-faint" aria-hidden>
                ·
              </span>
              <span className="min-w-0 text-ink-2">{it.reason || it.findings.join(" · ")}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Rewrites({ rewrites, start = 0 }: { rewrites: ReviewRewrite[]; start?: number }) {
  return (
    <ol className="space-y-3">
      {rewrites.map((r, i) => (
        <li key={`${r.itemId}-${i}`} className="rounded-lg border p-3.5">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand-soft text-xs text-primary tabular-nums">{start + i + 1}</span>
            {r.title}
          </p>
          {r.why && <p className="mt-1 text-[13px] text-muted-foreground">{r.why}</p>}
          <ul className="mt-2.5 space-y-2">
            {r.options.map((o, j) => (
              <li key={j} className="flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2">
                <p className="min-w-0 flex-1 text-[13px] whitespace-pre-line">{o}</p>
                <CopyButton text={o} />
              </li>
            ))}
          </ul>
          {r.warnings.length > 0 && (
            <ul className="mt-2 space-y-1">
              {r.warnings.map((w, k) => (
                <li key={k} className="flex items-start gap-1.5 text-xs text-warn">
                  <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
                  {w}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}

const TOP_REWRITES = 3;

export function ProfileScoreCard({
  account,
  history,
  feedImageUrl,
}: {
  account: ProfileScoreAccount;
  history: ReviewRow[];
  // 피드 합성 이미지의 서명 주소 (저장소는 비공개)
  feedImageUrl: string | null;
}) {
  const s = summarize(history);
  const snapshot = (s.latest?.snapshot ?? null) as ProfileSnapshot | null;
  // 캡처 값은 가장 최근 행에서 이어받는다(워커와 같은 규칙)
  const current = (history[0]?.manual_input ?? {}) as ProfileManualInput;
  const top = s.rewrites.slice(0, TOP_REWRITES);
  const rest = s.rewrites.slice(TOP_REWRITES);

  return (
    <Card id={`ps-${account.id}`} className="scroll-mt-20">
      <CardContent className="space-y-5 py-5">
        {/* 머리: 계정 · 점수 막대 · 요약 */}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <p className="truncate text-base font-semibold">{account.name}</p>
              <p className="shrink-0 text-xs text-muted-foreground">{formatFollowers(account.followers)}</p>
            </div>
            {s.score != null ? (
              <>
                <div className="flex items-end justify-between gap-2">
                  <p className="text-2xl leading-none font-bold">
                    {s.score}
                    <span className="text-sm font-semibold text-muted-foreground">/{s.max}점</span>
                  </p>
                  {s.rescore != null && (
                    <p className="text-xs text-muted-foreground">
                      아래대로 고치면 <b className="font-semibold text-primary">{s.rescore}점</b>
                    </p>
                  )}
                </div>
                <ScoreMeter score={s.score} rescore={s.rescore} max={s.max} />
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-full bg-primary" aria-hidden />
                    지금
                  </span>
                  {s.rescore != null && (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="size-2 rounded-full bg-primary/35" aria-hidden />
                      고치면 오를 몫
                    </span>
                  )}
                  <Delta delta={s.delta} />
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">아직 채점 전이에요. 매일 04:30에 자동으로 채점해요.</p>
            )}
          </div>

          <div className="space-y-1.5">
            {s.busy ? (
              <p className="flex items-center gap-1.5 text-xs text-primary">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                채점 중이에요. 1~2분 뒤 새로고침하세요.
              </p>
            ) : (
              s.latest?.finished_at && (
                <p className="text-xs text-muted-foreground">
                  <RelativeTime iso={s.latest.finished_at} /> 자동 채점 · {s.max < 100 ? `확인된 항목 ${s.max}점 만점 기준` : "100점 만점"} · 프로필이 바뀌거나 7일이
                  지나면 다시 채점해요
                </p>
              )
            )}
            {s.failed && !s.busy && (
              <p className="flex items-start gap-1.5 text-xs text-risk">
                <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
                마지막 채점이 실패했어요: {s.failed.error ?? "이유를 알 수 없어요."}
              </p>
            )}
            {s.latest?.summary && <p className="max-w-3xl text-sm text-ink-2">{s.latest.summary}</p>}
            {s.unknown.length > 0 && (
              <p className="max-w-3xl rounded-md bg-brand-soft px-3 py-2 text-xs text-ink-2">
                <b>모르는 항목</b> {s.unknown.map((i) => i.label).join(" · ")}은 점수에서 뺐어요. 하이라이트 · 고정 게시물 · 연락 버튼은 인스타가 알려
                주지 않아서 프로필 캡처를 한 장 올리면 채워져요.
              </p>
            )}
            <ScreenshotUpload accountId={account.id} current={current} />
          </div>
        </div>

        {snapshot?.feed_review && (
          <FeedReviewSection review={snapshot.feed_review} imageUrl={feedImageUrl} pinnedCount={snapshot.pinned_count} />
        )}

        {s.latest && (
          <div className="grid gap-6 border-t pt-5 xl:grid-cols-2">
            <section aria-label={`${account.name} 항목별 점수`} className="space-y-3">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold">항목별 점수</h3>
                <p className="text-xs text-muted-foreground">많이 깎인 것부터</p>
              </div>
              <ItemBars items={s.items} />
              <p className="text-xs text-muted-foreground">
                <b>규칙</b>은 글자 수 · 개수처럼 정해진 기준이라 다시 채점해도 같은 점수가 나와요. <b>AI 판단</b>은 기준표와 사진을 보고 AI가 매겨요.
              </p>
            </section>

            {top.length > 0 && (
              <section aria-label={`${account.name} 고칠 순서`} className="space-y-3">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold">고칠 순서</h3>
                  <p className="text-xs text-muted-foreground">위에서부터 하나씩 인스타 앱에서</p>
                </div>
                <Rewrites rewrites={top} />
                {rest.length > 0 && (
                  <details className="rounded-lg border">
                    <summary className="cursor-pointer px-3.5 py-2.5 text-[13px] font-medium">나머지 {rest.length}개 더 보기</summary>
                    <div className="border-t p-3">
                      <Rewrites rewrites={rest} start={TOP_REWRITES} />
                    </div>
                  </details>
                )}
              </section>
            )}
          </div>
        )}
        {!s.latest && !account.active && (
          <Badge variant="secondary">
            <Unplug className="size-3" aria-hidden /> 연결 끊김
          </Badge>
        )}
      </CardContent>
    </Card>
  );
}
