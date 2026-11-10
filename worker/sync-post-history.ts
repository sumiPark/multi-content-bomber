// .env.local 로드는 다른 어떤 import보다 먼저 (dev 전용 — GitHub Actions에선 no-op).
import "./load-env";

import sharp from "sharp";
import { firstLine } from "@/lib/benchmark/discovery";
import { decryptToken } from "@/lib/crypto";
import { resolveOrgId } from "@/lib/agents/playbook";
import { agentModel } from "@/lib/agents/runner";
import { InstagramApiError, getInstagramMedia } from "@/lib/platforms/instagram-comments";
import {
  getMediaInsights,
  getMediaInsightsBySystem,
  getProfile,
  isPermissionError,
  listRecentMedia,
  listSystemAccounts,
  type MetricValues,
} from "@/lib/platforms/instagram-insights";
import { suggestTopics, writeFindings, type Usage } from "@/lib/post-analysis/interpret";
import { baseByFormat, clip, computeStats, formatOf, type ReelRow } from "@/lib/post-analysis/stats";
import { warnIfError } from "@/lib/supabase/result";
import { createServiceClient } from "@/lib/supabase/service";
import { kstDate } from "@/lib/automation/time";
import type { Json } from "@/types/database";

// ─────────────────────────────────────────────────────────────────────────────
// 게시물 성과 워커(ig-audit-ko). "한 번 실행하고 종료"하는 배치. 인스타에는 쓰지 않는다.
//
// .github/workflows/post-history.yml이 매일 05:10(KST) 깨운다. 계정마다:
//   1. 지난 게시물 목록을 끝까지 한 번 읽어 릴스 전부와 2024년 이후 피드 게시물을 social_posts에 넣는다
//      (그 뒤 새 게시물은 성과 수집이 넣는다). 그 전 피드는 인스타가 조회수를 주지 않아 넣지 않는다
//      (2026-11-04 실측: 2022~2023년 사진 · 캐러셀 조회수 전부 0, 2021년 이전은 성과 없음)
//   2. 성과를 아직 안 읽은 게시물을 읽는다 — mcb 키 우선(실측 4,257번에 사용량 1%), 시간 예산을 넘으면 다음 실행에
//   3. 잘된 게시물 · 최근 게시물의 표지를 보관한다 — 인스타 표지 주소는 며칠 뒤 만료된다
//   4. 지난 분석이 7일 넘었으면 통계 + AI 해석을 새로 쓴다 (post_analyses)
//
// 옵션: --account <id> · --no-ai (해석 건너뜀) · --force-ai (7일 안 지났어도)
// ─────────────────────────────────────────────────────────────────────────────

const RUN_BUDGET_MS = 40 * 60_000;
const INSIGHT_CONCURRENCY = 4;
const FEED_SINCE = "2024-01-01";
const MAX_MEDIA = 30_000;
const ANALYSIS_DAYS = 7;
const THUMB_RECENT = 60;
const THUMB_PER_RUN = 300;
const THUMB_WIDTH = 240;
const PAGE = 1000;
const DAY_MS = 86_400_000;

type Service = ReturnType<typeof createServiceClient>;

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

const toInt = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);

interface StatRow {
  post_id: string;
  platform_media_id: string;
  media_type: string | null;
  media_product_type: string | null;
  permalink: string | null;
  caption: string | null;
  thumb_path: string | null;
  thumbnail_url: string | null;
  posted_at: string | null;
  insights_checked_at: string | null;
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  saved: number | null;
  shares: number | null;
  avg_watch_time_ms: number | null;
}

async function loadRows(service: Service, accountId: string): Promise<StatRow[]> {
  const rows: StatRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await service
      .from("account_post_stats")
      .select("post_id, platform_media_id, media_type, media_product_type, permalink, caption, thumb_path, thumbnail_url, posted_at, insights_checked_at, views, reach, likes, comments, saved, shares, avg_watch_time_ms")
      .eq("social_account_id", accountId)
      .order("posted_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`게시물 조회 실패: ${error.message}`);
    rows.push(...((data ?? []) as StatRow[]));
    if (!data || data.length < PAGE) return rows;
  }
}

/** 1. 지난 게시물 목록 — 한 번만. */
async function listHistory(service: Service, account: { id: string; organization_id: string }, token: string): Promise<void> {
  const { data: sync } = await service.from("post_history_sync").select("all_listed_at").eq("social_account_id", account.id).maybeSingle();
  if (sync?.all_listed_at) return;
  const media = await listRecentMedia(token, MAX_MEDIA);
  const reels = media.filter((m) => m.mediaProductType === "REELS");
  const posts = media.filter((m) => m.mediaProductType === "REELS" || (m.timestamp ?? "") >= FEED_SINCE);
  for (let i = 0; i < posts.length; i += 500) {
    const { error } = await service.from("social_posts").upsert(
      posts.slice(i, i + 500).map((m) => ({
        organization_id: account.organization_id,
        social_account_id: account.id,
        platform_media_id: m.id,
        media_type: m.mediaType,
        media_product_type: m.mediaProductType,
        permalink: m.permalink,
        caption: m.caption ? clip(m.caption, 2000) : null,
        thumbnail_url: m.thumbnailUrl,
        posted_at: m.timestamp,
      })),
      { onConflict: "social_account_id,platform_media_id" },
    );
    if (error) throw new Error(`게시물 저장 실패: ${error.message}`);
  }
  // 게시물은 이미 저장했다 — 못 남기면 다음 실행이 목록을 한 번 더 읽을 뿐이라 이번 실행은 이어 간다
  warnIfError(
    await service.from("post_history_sync").upsert({
      social_account_id: account.id,
      organization_id: account.organization_id,
      listed_at: new Date().toISOString(),
      all_listed_at: new Date().toISOString(),
      media_listed: media.length,
      reels_listed: reels.length,
      updated_at: new Date().toISOString(),
    }),
    `지난 게시물 목록 완료 표시 (account=${account.id})`,
  );
  console.log(`[post-history] 지난 게시물 ${media.length}개 중 릴스 ${reels.length}개, 읽을 게시물 ${posts.length}개`);
}

/** 2. 성과를 아직 안 읽은 게시물 (최신순, 동시에 몇 개씩). 시간 예산을 넘으면 false (다음 실행에 이어서). */
async function fillInsights(service: Service, accountToken: string, systemToken: string | null, inSystemList: boolean, rows: StatRow[], deadline: number): Promise<{ read: number; finished: boolean }> {
  const todo = rows.filter((r) => r.views == null && !r.insights_checked_at);
  const today = kstDate();
  let read = 0;
  let useAccount = !systemToken || !inSystemList;

  /** false면 이 계정은 여기서 멈춘다 (호출 한도 · 권한). */
  const readOne = async (r: StatRow): Promise<boolean> => {
    const media = { id: r.platform_media_id, mediaProductType: r.media_product_type };
    let v: MetricValues = {};
    try {
      v = useAccount ? await getMediaInsights(accountToken, media) : await getMediaInsightsBySystem(systemToken as string, media);
    } catch (err) {
      if (err instanceof InstagramApiError && err.kind === "RATE_LIMIT") return false;
      // 시스템 키 문제는 계정 토큰으로 돌아간다. 계정을 비활성으로 표시하지 않는다. 이 게시물은 다음 실행이 다시 읽는다.
      if (!useAccount && err instanceof InstagramApiError && err.kind === "TOKEN") {
        useAccount = true;
        return true;
      }
      if (useAccount && systemToken && isPermissionError(err)) {
        // 시스템 키 계정 목록에 없어도 읽히는 계정이 있다 (cuma.note). 그래도 안 되면 권한이 없는 계정으로 보고 멈춘다.
        try {
          v = await getMediaInsightsBySystem(systemToken, media);
        } catch {
          return false;
        }
      } else if (isPermissionError(err) || (err instanceof InstagramApiError && err.kind === "TOKEN")) {
        return false;
      }
      // 삭제된 게시물 등은 표시만 하고 넘어간다
    }
    if (Object.keys(v).length) {
      const { error } = await service.from("post_metrics").upsert(
        {
          post_id: r.post_id,
          collected_on: today,
          views: toInt(v.views),
          reach: toInt(v.reach),
          likes: toInt(v.likes),
          comments: toInt(v.comments),
          saved: toInt(v.saved),
          shares: toInt(v.shares),
          total_interactions: toInt(v.total_interactions),
          avg_watch_time_ms: toInt(v.ig_reels_avg_watch_time),
          total_watch_time_ms: toInt(v.ig_reels_video_view_total_time),
          raw: v as unknown as Json,
          collected_at: new Date().toISOString(),
        },
        { onConflict: "post_id,collected_on" },
      );
      if (error) throw new Error(`성과 저장 실패: ${error.message}`);
      read++;
    }
    // 못 남기면 다음 실행이 이 게시물을 한 번 더 읽는다
    warnIfError(await service.from("social_posts").update({ insights_checked_at: new Date().toISOString() }).eq("id", r.post_id), `성과 확인 시각 기록 (post=${r.post_id})`);
    return true;
  };

  for (let i = 0; i < todo.length; i += INSIGHT_CONCURRENCY) {
    if (Date.now() > deadline) return { read, finished: false };
    const results = await Promise.all(todo.slice(i, i + INSIGHT_CONCURRENCY).map(readOne));
    if (results.includes(false)) return { read, finished: false };
  }
  return { read, finished: true };
}

function toReelRows(rows: StatRow[], publicViews: Map<string, number>): ReelRow[] {
  return rows.map((r) => ({
    id: r.post_id,
    format: formatOf(r.media_product_type, r.media_type),
    mediaId: r.platform_media_id,
    postedAt: r.posted_at,
    url: r.permalink,
    title: firstLine(r.caption),
    views: r.views,
    publicViews: r.media_product_type === "REELS" ? publicViews.get(r.platform_media_id) ?? null : null,
    reach: r.reach,
    likes: r.likes,
    comments: r.comments,
    shares: r.shares,
    saved: r.saved,
    watchSec: r.avg_watch_time_ms != null ? r.avg_watch_time_ms / 1000 : null,
    thumb: r.thumb_path,
  }));
}

/** 3. 표지 보관 — 같은 유형 평소의 2배 넘은 게시물과 최근 게시물. 하위 폴더라 임시 저장 정리가 보지 않는다. */
async function keepThumbs(service: Service, orgId: string, accountId: string, token: string, rows: StatRow[]): Promise<number> {
  const bases = baseByFormat(toReelRows(rows, new Map()), Date.now());
  const baseOf = (r: StatRow) => bases.get(formatOf(r.media_product_type, r.media_type)) ?? 0;
  const wanted = [
    ...rows.slice(0, THUMB_RECENT),
    ...rows.filter((r) => baseOf(r) && (r.views ?? 0) >= baseOf(r) * 2).sort((a, b) => (b.views ?? 0) - (a.views ?? 0)),
  ];
  const seen = new Set<string>();
  let saved = 0;
  for (const r of wanted) {
    if (saved >= THUMB_PER_RUN) break;
    if (seen.has(r.post_id) || r.thumb_path) continue;
    seen.add(r.post_id);
    try {
      let res = r.thumbnail_url ? await fetch(r.thumbnail_url, { signal: AbortSignal.timeout(15_000) }) : null;
      if (!res?.ok) {
        // 만료된 주소 — 새 주소를 받아 다시 시도
        const fresh = await getInstagramMedia(r.platform_media_id, token);
        if (!fresh.previewUrl) continue;
        res = await fetch(fresh.previewUrl, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) continue;
      }
      const jpeg = await sharp(Buffer.from(await res.arrayBuffer())).resize({ width: THUMB_WIDTH }).jpeg({ quality: 72 }).toBuffer();
      const path = `${orgId}/reel-thumbs/${accountId}/${r.post_id}.jpg`;
      const { error } = await service.storage.from("media").upload(path, jpeg, { contentType: "image/jpeg", upsert: true });
      if (error) continue;
      // 아래 catch는 조용히 넘어가므로 throw하지 않고 여기서 경고를 남긴다 — 다음 실행이 다시 보관한다
      if (!warnIfError(await service.from("social_posts").update({ thumb_path: path }).eq("id", r.post_id), `표지 경로 저장 (post=${r.post_id})`)) continue;
      saved++;
    } catch (err) {
      if (err instanceof InstagramApiError && err.kind === "RATE_LIMIT") break;
      // 표지 하나 못 받아도 분석은 계속
    }
  }
  return saved;
}

/** 4. 통계 + AI 해석. 실행 기록은 agent_runs(analyze). */
async function analyze(service: Service, account: { id: string; organization_id: string; display_name: string | null; role_note: string | null }, handle: string, posts: ReelRow[], rows: StatRow[], force: boolean) {
  if (!force) {
    const { data: last } = await service.from("post_analyses").select("created_at").eq("social_account_id", account.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (last && Date.now() - Date.parse(last.created_at) < ANALYSIS_DAYS * DAY_MS) return "최근 분석 있음";
  }
  const usable = posts.filter((r) => r.views != null);
  if (usable.length < 10) return `게시물 ${usable.length}개뿐이라 분석 안 함`;

  const now = Date.now();
  const captions = new Map(rows.map((r) => [r.post_id, r.caption ?? ""]));
  const usage: Usage = { input: 0, output: 0 };
  const model = agentModel();
  const runRes = await service
    .from("agent_runs")
    .insert({
      organization_id: await resolveOrgId(service, { accountId: account.id }),
      agent: "analyze",
      model,
      input: { task: "post_analysis", account: handle, reels: usable.length } as Json,
    })
    .select("id")
    .single();
  // 실행 기록은 부가 정보 — 못 남겨도 분석은 계속한다
  warnIfError(runRes, `agent_runs 기록 (account=${account.id})`);
  const run = runRes.data;
  const finish = async (patch: { status: "success" | "failed"; output?: unknown; error?: string }) => {
    if (!run) return;
    warnIfError(
      await service
        .from("agent_runs")
        .update({ status: patch.status, output: (patch.output ?? null) as Json, error: patch.error ?? null, tokens_input: usage.input, tokens_output: usage.output, finished_at: new Date().toISOString() })
        .eq("id", run.id),
      `agent_runs 마감 (id=${run.id})`,
    );
  };
  try {
    const titles = [...usable].sort((a, b) => (b.views as number) - (a.views as number)).map((r) => r.title).filter(Boolean);
    const topics = await suggestTopics(titles, usage);
    const stats = computeStats(usable, captions, now, topics);
    const { headline, findings, actions, dropped } = await writeFindings(handle, account.role_note, stats, usage);
    const { error } = await service.from("post_analyses").insert({
      organization_id: account.organization_id,
      social_account_id: account.id,
      reels_count: usable.length,
      headline: headline || null,
      stats: stats as unknown as Json,
      findings: findings as unknown as Json,
      actions: actions as unknown as Json,
      model,
      tokens_input: usage.input,
      tokens_output: usage.output,
    });
    if (error) throw new Error(`분석 저장 실패: ${error.message}`);
    await finish({ status: "success", output: { reels: usable.length, findings: findings.length, dropped } });
    return `분석 ${findings.length}개${dropped ? ` (근거 없는 숫자로 ${dropped}개 버림)` : ""} | 토큰 ${usage.input}/${usage.output}`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finish({ status: "failed", error: message });
    return `분석 실패: ${message.slice(0, 200)}`;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const onlyAccount = arg(argv, "--account");
  const noAi = argv.includes("--no-ai");
  const forceAi = argv.includes("--force-ai");
  const service = createServiceClient();
  const deadline = Date.now() + RUN_BUDGET_MS;

  const systemToken = process.env.IG_DISCOVERY_TOKEN?.trim() || null;
  let system: Map<string, string> | null = null;
  if (systemToken) {
    try {
      system = await listSystemAccounts(systemToken);
    } catch (err) {
      console.warn("[post-history] 시스템 키를 못 씀:", err instanceof Error ? err.message : err);
    }
  }

  let q = service
    .from("social_accounts")
    .select("id, organization_id, display_name, role_note, access_token_encrypted")
    .eq("platform", "INSTAGRAM")
    .eq("is_active", true)
    .is("disconnected_at", null)
    .not("access_token_encrypted", "is", null);
  if (onlyAccount) q = q.eq("id", onlyAccount);
  const { data: accounts, error } = await q;
  if (error) {
    console.error("[post-history] 계정 조회 실패:", error.message);
    process.exitCode = 1;
    return;
  }

  for (const account of accounts ?? []) {
    const label = account.display_name ?? account.id;
    try {
      const token = decryptToken(account.access_token_encrypted as string);
      const profile = await getProfile(token);
      await listHistory(service, account, token);
      let rows = await loadRows(service, account.id);
      const inSystemList = !!system?.has(profile.username.toLowerCase());
      const { read, finished } = await fillInsights(service, token, systemToken, inSystemList, rows, deadline);
      if (read) rows = await loadRows(service, account.id);
      const thumbs = await keepThumbs(service, account.organization_id, account.id, token, rows);

      // 공개 조회수 — 다른 계정 비교 수집이 읽은 최근 릴스만 있다
      const { data: own } = await service.from("benchmark_accounts").select("id").eq("own_account_id", account.id).maybeSingle();
      const { data: pub } = own
        ? await service.from("benchmark_posts").select("platform_media_id, view_count").eq("benchmark_account_id", own.id).not("view_count", "is", null)
        : { data: [] };
      const publicViews = new Map((pub ?? []).map((p) => [p.platform_media_id, p.view_count as number]));
      const posts = toReelRows(rows, publicViews);
      const left = rows.filter((r) => r.views == null && !r.insights_checked_at).length;
      const analysis = noAi || !finished ? "건너뜀" : await analyze(service, account, profile.username, posts, rows, forceAi);
      console.log(`[post-history] ${label}: 게시물 ${rows.length} | 이번에 성과 ${read}개 읽음 | 남음 ${finished ? left : "다음 실행"} | 표지 ${thumbs}개 | ${analysis}`);
    } catch (err) {
      // 이 워커는 계정 상태를 바꾸지 않는다 — 연결 끊김 표시는 성과 수집 워커 몫
      console.error(`[post-history] ${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (Date.now() > deadline) {
      console.log("[post-history] 시간 예산 끝 — 나머지는 다음 실행에");
      break;
    }
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("[post-history] 치명적 오류:", err);
    process.exit(1);
  });
