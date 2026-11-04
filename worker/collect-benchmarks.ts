// .env.local 로드는 다른 어떤 import보다 먼저 (dev 전용 — GitHub Actions에선 no-op).
import "./load-env";

import { classifyHooks } from "@/lib/agents/ko-skills";
import { baselineViews, firstLine, HIT_MULTIPLE, isAdSuspected, readBenchmarkAccount, type BenchmarkMedia } from "@/lib/benchmark/discovery";
import { decryptToken } from "@/lib/crypto";
import { InstagramApiError } from "@/lib/platforms/instagram-comments";
import { getProfile, listSystemAccounts } from "@/lib/platforms/instagram-insights";
import { createServiceClient } from "@/lib/supabase/service";

// ─────────────────────────────────────────────────────────────────────────────
// 다른 계정 비교 워커(ig-viral-ko). "한 번 실행하고 종료"하는 배치. 인스타에는 쓰지 않는다.
//
// .github/workflows/benchmarks.yml이 깨운다:
//   · schedule 매일 04:50(KST) → 비교 목록에 있는 계정 + 우리 계정을 오래 안 읽은 순으로
//   · repository_dispatch      → 화면에서 비교 계정을 추가한 직후(아직 안 읽은 계정 먼저)
//
// 호출 한도(#4)가 앱 전체에 걸리므로 한 번에 MAX_CALLS만, 호출 사이를 띄워 읽는다. 한도에 걸리면
// 바로 멈추고 남은 계정은 다음 실행이 읽는다. mcb 키가 기존 연결과 따로라 계정 상태는 바꾸지 않는다.
//
// 옵션: --dry-run (DB에 안 씀)
// ─────────────────────────────────────────────────────────────────────────────

const MAX_CALLS = 60;
const CALL_GAP_MS = 1500;
const DAY_MS = 24 * 60 * 60_000;

type Service = ReturnType<typeof createServiceClient>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 우리 계정도 같은 공개 조회수로 비교하려고 함께 읽는다 — 아이디는 계정 토큰으로 확인. */
async function syncOwnAccounts(service: Service, dryRun: boolean) {
  const { data: accounts } = await service
    .from("social_accounts")
    .select("id, organization_id, access_token_encrypted")
    .eq("platform", "INSTAGRAM")
    .eq("is_active", true)
    .is("disconnected_at", null)
    .not("access_token_encrypted", "is", null);
  for (const a of accounts ?? []) {
    const { count } = await service.from("benchmark_links").select("id", { count: "exact", head: true }).eq("social_account_id", a.id);
    if (!count) continue; // 비교 목록이 없는 계정은 읽지 않는다
    try {
      const profile = await getProfile(decryptToken(a.access_token_encrypted as string));
      if (dryRun) continue;
      const username = profile.username.toLowerCase();
      await service.from("benchmark_accounts").upsert(
        { organization_id: a.organization_id, username, own_account_id: a.id },
        { onConflict: "organization_id,username" },
      );
    } catch (err) {
      console.warn(`[collect-benchmarks] 우리 계정 ${a.id} 확인 실패:`, err instanceof Error ? err.message : err);
    }
  }
}

function notFoundMessage(err: InstagramApiError): string {
  return err.code === 100 || err.status === 400
    ? "조회되지 않아요. 아이디가 틀렸거나 비즈니스 · 크리에이터 계정이 아니에요."
    : `읽지 못했어요: ${err.message.slice(0, 200)}`;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const token = process.env.IG_DISCOVERY_TOKEN?.trim();
  if (!token) {
    console.error("[collect-benchmarks] IG_DISCOVERY_TOKEN이 없어 읽을 수 없음");
    process.exitCode = 1;
    return;
  }
  const service = createServiceClient();

  const systemAccounts = await listSystemAccounts(token);
  const baseIgId = systemAccounts.values().next().value as string | undefined;
  if (!baseIgId) {
    console.error("[collect-benchmarks] mcb 키에 할당된 인스타 계정이 없음");
    process.exitCode = 1;
    return;
  }

  await syncOwnAccounts(service, dryRun);

  // 비교 목록에 있는 계정 + 우리 계정만. 아직 안 읽은 계정 → 오래된 순.
  const { data: rows, error } = await service
    .from("benchmark_accounts")
    .select("id, organization_id, username, own_account_id, benchmark_links(id)")
    .order("last_collected_at", { ascending: true, nullsFirst: true });
  if (error) {
    console.error("[collect-benchmarks] 목록 조회 실패:", error.message);
    process.exitCode = 1;
    return;
  }
  const targets = (rows ?? []).filter((r) => r.own_account_id || (r.benchmark_links as unknown[]).length > 0);

  let calls = 0;
  let ok = 0;
  let failed = 0;
  for (const t of targets) {
    if (calls >= MAX_CALLS) {
      console.log(`[collect-benchmarks] 이번 실행 한도 ${MAX_CALLS}번 — 나머지는 다음 실행에`);
      break;
    }
    if (calls > 0) await sleep(CALL_GAP_MS);
    calls++;
    try {
      const profile = await readBenchmarkAccount(token, baseIgId, t.username);
      const media = profile.media?.data ?? [];
      const { median, sampled } = baselineViews(media);
      const now = Date.now();
      const reels30 = media.filter((m) => m.media_product_type === "REELS" && m.timestamp && now - Date.parse(m.timestamp) < 30 * DAY_MS).length;
      const multipleOf = (m: BenchmarkMedia) => (median && m.view_count != null ? Math.round((m.view_count / median) * 100) / 100 : null);

      // 잘된 릴스만 훅 공식 · 점수를 매긴다(나머지는 볼 일이 없다)
      const hits = media.filter((m) => m.media_product_type === "REELS" && (multipleOf(m) ?? 0) >= HIT_MULTIPLE && !isAdSuspected(m) && firstLine(m.caption));
      const hooks = new Map<string, { formula: string; score: number | null }>();
      if (hits.length) {
        try {
          for (const h of classifyHooks(hits.map((m) => ({ id: m.id, hook: firstLine(m.caption), views: m.view_count ?? 0 })))) {
            hooks.set(h.id, { formula: h.formula, score: h.score });
          }
        } catch (err) {
          console.warn(`[collect-benchmarks] @${t.username} 훅 분류 실패:`, err instanceof Error ? err.message : err);
        }
      }

      console.log(
        `[collect-benchmarks] @${t.username}: 팔로워 ${profile.followers_count} | 평소 ${median ?? "-"} (릴스 ${sampled}개) | 잘된 릴스 ${hits.length}개`,
      );
      ok++;
      if (dryRun) continue;

      if (media.length) {
        const { error: postErr } = await service.from("benchmark_posts").upsert(
          media.map((m) => ({
            organization_id: t.organization_id,
            benchmark_account_id: t.id,
            platform_media_id: m.id,
            media_product_type: m.media_product_type ?? null,
            permalink: m.permalink ?? null,
            caption: m.caption?.slice(0, 2000) ?? null,
            thumbnail_url: m.thumbnail_url ?? (m.media_product_type === "REELS" ? null : m.media_url ?? null),
            posted_at: m.timestamp ?? null,
            view_count: m.view_count ?? null,
            like_count: m.like_count ?? null,
            comments_count: m.comments_count ?? null,
            reposts_count: m.reposts_count ?? null,
            multiple: multipleOf(m),
            ad_suspected: isAdSuspected(m),
            formula: hooks.get(m.id)?.formula ?? null,
            hook_score: hooks.get(m.id)?.score ?? null,
            updated_at: new Date().toISOString(),
          })),
          { onConflict: "benchmark_account_id,platform_media_id" },
        );
        if (postErr) throw new Error(`게시물 저장 실패: ${postErr.message}`);
      }
      await service
        .from("benchmark_accounts")
        .update({
          status: "OK",
          error: null,
          display_name: profile.name ?? null,
          biography: profile.biography?.slice(0, 500) ?? null,
          followers_count: profile.followers_count ?? null,
          media_count: profile.media_count ?? null,
          median_views: median,
          reels_sampled: sampled,
          reels_30d: reels30,
          last_post_at: media[0]?.timestamp ?? null,
          last_collected_at: new Date().toISOString(),
        })
        .eq("id", t.id);
    } catch (err) {
      // 호출 한도 · 키 문제는 그 계정 잘못이 아니다 — 멈추고 다음 실행에
      if (err instanceof InstagramApiError && (err.kind === "RATE_LIMIT" || err.kind === "TOKEN")) {
        console.warn(`[collect-benchmarks] ${err.kind} — 여기서 멈춤: ${err.message}`);
        process.exitCode = err.kind === "TOKEN" ? 1 : 0;
        break;
      }
      failed++;
      const message = err instanceof InstagramApiError ? notFoundMessage(err) : err instanceof Error ? err.message.slice(0, 300) : String(err);
      console.warn(`[collect-benchmarks] @${t.username}: ${message}`);
      if (!dryRun) {
        await service
          .from("benchmark_accounts")
          .update({
            status: err instanceof InstagramApiError ? "NOT_FOUND" : "ERROR",
            error: message,
            last_collected_at: new Date().toISOString(),
          })
          .eq("id", t.id);
      }
    }
  }
  console.log(`[collect-benchmarks] 끝: 대상 ${targets.length} | 호출 ${calls} | 성공 ${ok} | 실패 ${failed}`);
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("[collect-benchmarks] 치명적 오류:", err);
    process.exit(1);
  });
