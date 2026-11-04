// .env.local 로드는 다른 어떤 import보다 먼저 (dev 전용 — GitHub Actions에선 no-op).
import "./load-env";

import { writeFileSync } from "fs";
import { getProfileDetails, type ProfileDetails } from "@/lib/account-review/instagram-profile";
import { profileFingerprint, scoreProfile } from "@/lib/account-review/score-profile";
import type { ProfileManualInput, ProfileSnapshot } from "@/lib/account-review/types";
import { kstDate } from "@/lib/automation/time";
import { decryptToken } from "@/lib/crypto";
import { InstagramApiError } from "@/lib/platforms/instagram-comments";
import type { ContentRule } from "@/lib/rules/check";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";

// ─────────────────────────────────────────────────────────────────────────────
// 프로필 자동 채점 워커(ig-profile-ko). "한 번 실행하고 종료"하는 배치. 사람이 누르는 버튼은 없다.
//
// .github/workflows/profile-review.yml이 깨운다:
//   · schedule 매일 04:30(KST)  → 계정마다 스토리 기록 + 필요하면 채점
//   · repository_dispatch       → 분석 화면에서 프로필 캡처를 저장한 직후(그 계정 요청만)
//
// 계정마다(인스타는 읽기만):
//   1. 지금 떠 있는 스토리 수 → account_story_days (스토리는 24시간이라 하루 한 번 보면 지난 하루가 보인다)
//   2. 다시 채점할지: 채점한 적 없음 · 이름 칸 / 소개 / 링크 / 캡처 값이 바뀜 · 마지막 채점이 7일 넘음
//   3. 채점 → profile_reviews DONE. 캡처에서 읽은 값(manual_input)은 마지막 행에서 이어받는다.
// 대기 요청(PENDING, 캡처 저장)은 그 계정 차례에 같이 처리한다. 20분 넘게 RUNNING이면 멈춘 것으로 본다.
//
// 옵션: --dry-run (DB에 안 씀) · --account <id> (그 계정만) · --force (바뀐 게 없어도 채점) ·
//       --mosaic-out <파일> (dry-run 때 피드 합성 이미지 저장)
// ─────────────────────────────────────────────────────────────────────────────

const STALE_MS = 20 * 60_000;
const RESCORE_DAYS = 7;
const STORY_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;

type Service = ReturnType<typeof createServiceClient>;

// 화면에 그대로 보여 줄 실패 이유
class ReviewError extends Error {}

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function failMessage(err: unknown): string {
  if (err instanceof ReviewError) return err.message;
  if (err instanceof InstagramApiError) {
    if (err.kind === "TOKEN") return "인스타 연결이 끊겼어요. 계정 연동에서 다시 연결하세요.";
    if (err.kind === "RATE_LIMIT") return "인스타 호출 한도에 걸렸어요. 다음 자동 채점 때 다시 해요.";
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/insufficient_quota|exceeded your current quota/i.test(msg)) return "OpenAI 크레딧이 부족해요. 충전하면 다음 자동 채점 때 다시 해요.";
  return `채점 실패: ${msg.slice(0, 300)}`;
}

async function loadRules(service: Service): Promise<ContentRule[]> {
  const { data } = await service
    .from("content_rules")
    .select("id, scope, rule_type, phrase, match_type, reason, suggestion")
    .eq("active", true);
  return (data ?? []).map((r) => ({
    id: r.id,
    scope: r.scope as ContentRule["scope"],
    ruleType: r.rule_type as ContentRule["ruleType"],
    phrase: r.phrase,
    matchType: r.match_type as ContentRule["matchType"],
    reason: r.reason,
    suggestion: r.suggestion,
  }));
}

/** 최근 7일 스토리 기록 — 올린 날 수 · 기록한 날 수. 기록이 하루도 없으면 null. */
async function storyRecord(service: Service, accountId: string): Promise<{ days: number; observed: number } | null> {
  const since = kstDate(-(STORY_WINDOW_DAYS - 1));
  const { data } = await service
    .from("account_story_days")
    .select("day, stories_count")
    .eq("social_account_id", accountId)
    .gte("day", since);
  if (!data?.length) return null;
  return { days: data.filter((d) => d.stories_count > 0).length, observed: data.length };
}

interface AccountRow {
  id: string;
  organization_id: string;
  display_name: string | null;
  role_focus: string | null;
  role_note: string | null;
  access_token_encrypted: string | null;
}

async function reviewAccount(
  service: Service,
  account: AccountRow,
  rules: ContentRule[],
  opts: { dryRun: boolean; force: boolean; today: string; mosaicOut?: string },
): Promise<string> {
  const label = account.display_name ?? account.id;
  const { data: rows } = await service
    .from("profile_reviews")
    .select("id, status, created_at, started_at, finished_at, manual_input, snapshot")
    .eq("social_account_id", account.id)
    .order("created_at", { ascending: false })
    .limit(10);
  const history = rows ?? [];
  const now = Date.now();
  const pending = history.filter(
    (r) => r.status === "PENDING" || (r.status === "RUNNING" && (!r.started_at || now - Date.parse(r.started_at) > STALE_MS)),
  );
  const busy = history.find((r) => r.status === "RUNNING" && r.started_at && now - Date.parse(r.started_at) <= STALE_MS);
  if (busy && !opts.dryRun) return `${label}: 다른 run이 채점 중 — 건너뜀`;
  const lastDone = history.find((r) => r.status === "DONE") ?? null;
  // 캡처 값은 가장 최근 행(대기 요청이면 그 값)에서 이어받는다
  const manual = ((pending[0] ?? history[0])?.manual_input ?? {}) as ProfileManualInput;

  let api: ProfileDetails;
  try {
    if (!account.access_token_encrypted) throw new ReviewError("계정 토큰이 없어요. 계정 연동에서 다시 연결하세요.");
    api = await getProfileDetails(decryptToken(account.access_token_encrypted));
  } catch (err) {
    // 인스타를 못 읽으면 대기 요청만 실패로 남긴다(자동 채점은 다음 날 다시)
    const message = failMessage(err);
    if (!opts.dryRun) {
      for (const p of pending) {
        await service.from("profile_reviews").update({ status: "FAILED", error: message, finished_at: new Date().toISOString() }).eq("id", p.id);
      }
    }
    throw new Error(`${label}: ${message}`);
  }

  // 1. 스토리 기록
  if (!opts.dryRun && api.liveStories != null) {
    await service.from("account_story_days").upsert(
      {
        social_account_id: account.id,
        day: opts.today,
        organization_id: account.organization_id,
        stories_count: api.liveStories,
        checked_at: new Date().toISOString(),
      },
      { onConflict: "social_account_id,day" },
    );
  }

  // 2. 다시 채점할지
  const lastSnap = (lastDone?.snapshot ?? null) as ProfileSnapshot | null;
  // 피드 진열 분석이 없는 옛 채점도 다시 한다
  const changed = !lastSnap || !lastSnap.feed_review || lastSnap.fingerprint !== profileFingerprint(api, manual);
  const old = !lastDone?.finished_at || now - Date.parse(lastDone.finished_at) > RESCORE_DAYS * DAY_MS;
  if (!opts.force && pending.length === 0 && !changed && !old) {
    return `${label}: 바뀐 것 없음 — 채점 안 함 (스토리 ${api.liveStories ?? "?"}개)`;
  }

  // 3. 채점 — 대기 요청이 있으면 그 행을, 없으면 새 행을 쓴다
  let reviewId: string | null = pending[0]?.id ?? null;
  if (!opts.dryRun) {
    if (reviewId) {
      const { data: claimed } = await service
        .from("profile_reviews")
        .update({ status: "RUNNING", started_at: new Date().toISOString(), error: null })
        .eq("id", reviewId)
        .in("status", ["PENDING", "RUNNING"])
        .select("id");
      if (!claimed?.length) return `${label}: 다른 run이 먼저 집음 — 건너뜀`;
      // 같은 계정의 나머지 대기 요청은 이 채점으로 갈음
      const rest = pending.slice(1).map((p) => p.id);
      if (rest.length) {
        await service.from("profile_reviews").update({ status: "FAILED", error: "더 새 채점으로 갈음했어요.", finished_at: new Date().toISOString() }).in("id", rest);
      }
    } else {
      const { data: created, error } = await service
        .from("profile_reviews")
        .insert({
          organization_id: account.organization_id,
          social_account_id: account.id,
          status: "RUNNING",
          started_at: new Date().toISOString(),
          manual_input: manual as unknown as Json,
        })
        .select("id")
        .single();
      if (error || !created) throw new Error(`${label}: 채점 행을 만들지 못함 — ${error?.message ?? ""}`);
      reviewId = created.id;
    }
  }

  try {
    const result = await scoreProfile({
      service: opts.dryRun ? null : service,
      reviewId,
      account,
      api,
      manual,
      story: await storyRecord(service, account.id),
      rules,
    });
    if (opts.dryRun) {
      console.log(JSON.stringify({ items: result.items, rewrites: result.rewrites, summary: result.summary, feed: result.snapshot.feed_review }, null, 2));
      if (result.feedMosaic && opts.mosaicOut) writeFileSync(opts.mosaicOut, result.feedMosaic);
    } else {
      // 피드 합성 이미지 — 하위 폴더라 임시 저장 정리(cleanup-drafts)가 보지 않는다. 못 올려도 채점 결과는 저장한다.
      if (result.feedMosaic && result.snapshot.feed_review) {
        const path = `${account.organization_id}/profile-feed/${account.id}/${reviewId}.jpg`;
        const { error: upErr } = await service.storage.from("media").upload(path, result.feedMosaic, { contentType: "image/jpeg", upsert: true });
        if (upErr) console.warn(`[review-profiles] ${label}: 피드 이미지 저장 실패: ${upErr.message}`);
        else {
          result.snapshot.feed_review.mosaic_path = path;
          const oldPath = lastSnap?.feed_review?.mosaic_path;
          if (oldPath && oldPath !== path) await service.storage.from("media").remove([oldPath]);
        }
      }
      await service
        .from("profile_reviews")
        .update({
          status: "DONE",
          snapshot: result.snapshot as unknown as Json,
          items: result.items as unknown as Json,
          rewrites: result.rewrites as unknown as Json,
          total_score: result.total,
          rescore: result.rescore,
          summary: result.summary,
          model: result.model,
          tokens_input: result.tokens.input,
          tokens_output: result.tokens.output,
          finished_at: new Date().toISOString(),
        })
        .eq("id", reviewId as string);
    }
    const why = pending.length ? "캡처 저장" : !lastSnap ? "첫 채점" : changed ? "프로필 바뀜" : opts.force ? "강제" : "7일 지남";
    return `${label}: ${result.total}/${result.max} → 고치면 ${result.rescore} (${why}) | API 칸 ${api.fields.length}개 | 토큰 ${result.tokens.input}/${result.tokens.output}`;
  } catch (err) {
    const message = failMessage(err);
    if (!opts.dryRun && reviewId) {
      await service.from("profile_reviews").update({ status: "FAILED", error: message, finished_at: new Date().toISOString() }).eq("id", reviewId);
    }
    throw new Error(`${label}: ${message}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const force = argv.includes("--force");
  const onlyAccount = arg(argv, "--account");
  const service = createServiceClient();
  const today = kstDate();
  const rules = await loadRules(service);

  let q = service
    .from("social_accounts")
    .select("id, organization_id, display_name, role_focus, role_note, access_token_encrypted")
    .eq("platform", "INSTAGRAM")
    .eq("is_active", true)
    .is("disconnected_at", null)
    .order("created_at", { ascending: true });
  if (onlyAccount) q = q.eq("id", onlyAccount);
  const { data: accounts, error } = await q;
  if (error) {
    console.error("[review-profiles] 계정 조회 실패:", error.message);
    process.exitCode = 1;
    return;
  }
  if (!accounts?.length) {
    console.log("[review-profiles] 채점할 인스타 계정 없음");
    return;
  }

  // 계정 수가 적고 계정마다 호출 한도가 따로라 순서대로 — 로그가 읽기 쉽다.
  let failed = 0;
  for (const account of accounts as AccountRow[]) {
    try {
      console.log(`[review-profiles] ${await reviewAccount(service, account, rules, { dryRun, force, today, mosaicOut: arg(argv, "--mosaic-out") })}`);
    } catch (err) {
      failed++;
      console.error(`[review-profiles] ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failed === accounts.length) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("[review-profiles] 치명적 오류:", err);
    process.exit(1);
  });
