// .env.local 로드는 다른 어떤 import보다 먼저 (dev 전용 — GitHub Actions에선 no-op).
import "./load-env";

import { getProfileDetails } from "@/lib/account-review/instagram-profile";
import { scoreProfile } from "@/lib/account-review/score-profile";
import type { ProfileManualInput } from "@/lib/account-review/types";
import { decryptToken } from "@/lib/crypto";
import { InstagramApiError } from "@/lib/platforms/instagram-comments";
import type { ContentRule } from "@/lib/rules/check";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";

// ─────────────────────────────────────────────────────────────────────────────
// 계정 점검 워커 — 프로필 점수(ig-profile-ko). "한 번 실행하고 종료"하는 배치.
//
// .github/workflows/profile-review.yml이 깨운다: 계정 점검 화면의 "채점하기"(repository_dispatch).
// 요청(profile_reviews PENDING)마다 인스타 프로필을 읽고 → 규칙 채점(profile_ko.py, 러너의 python3) →
// AI 판단 채점 · 다시 쓸 문구 → DONE. 20분 넘게 RUNNING인 건 멈춘 것으로 보고 다시 집는다.
//
// 인스타에는 아무것도 쓰지 않는다(읽기만). 기존 테이블도 agent_runs 기록 말고는 쓰지 않는다.
//
// 옵션: --dry-run (DB에 안 씀) · --review <id> (그 요청만, dry-run이면 상태 무관)
// ─────────────────────────────────────────────────────────────────────────────

const STALE_MS = 20 * 60_000;
const MAX_PER_RUN = 10;

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

// 화면에 그대로 보여 줄 실패 이유
class ReviewError extends Error {}

function failMessage(err: unknown): string {
  if (err instanceof ReviewError) return err.message;
  if (err instanceof InstagramApiError) {
    if (err.kind === "TOKEN") return "인스타 연결이 끊겼어요. 계정 연동에서 다시 연결한 뒤 채점하세요.";
    if (err.kind === "RATE_LIMIT") return "인스타 호출 한도에 걸렸어요. 1시간쯤 뒤 다시 채점하세요.";
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/insufficient_quota|exceeded your current quota/i.test(msg)) return "OpenAI 크레딧이 부족해요. 충전한 뒤 다시 채점하세요.";
  return `채점 실패: ${msg.slice(0, 300)}`;
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const onlyReview = arg(argv, "--review");
  const service = createServiceClient();

  const { data: ruleRows } = await service
    .from("content_rules")
    .select("id, scope, rule_type, phrase, match_type, reason, suggestion")
    .eq("active", true);
  const rules: ContentRule[] = (ruleRows ?? []).map((r) => ({
    id: r.id,
    scope: r.scope as ContentRule["scope"],
    ruleType: r.rule_type as ContentRule["ruleType"],
    phrase: r.phrase,
    matchType: r.match_type as ContentRule["matchType"],
    reason: r.reason,
    suggestion: r.suggestion,
  }));

  let q = service
    .from("profile_reviews")
    .select("id, status, started_at, social_account_id, manual_input")
    .order("created_at", { ascending: true })
    .limit(MAX_PER_RUN);
  if (onlyReview) q = q.eq("id", onlyReview);
  else q = q.in("status", ["PENDING", "RUNNING"]);
  const { data: reviews, error } = await q;
  if (error) {
    console.error("[review-profiles] 요청 조회 실패:", error.message);
    process.exitCode = 1;
    return;
  }

  const now = Date.now();
  const due = (reviews ?? []).filter(
    (r) =>
      (dryRun && onlyReview) ||
      r.status === "PENDING" ||
      (r.status === "RUNNING" && (!r.started_at || now - Date.parse(r.started_at) > STALE_MS)),
  );
  if (due.length === 0) {
    console.log("[review-profiles] 채점할 요청 없음");
    return;
  }

  for (const review of due) {
    // 같은 요청을 두 run이 같이 집지 않게 — 읽은 상태 그대로일 때만 RUNNING으로
    if (!dryRun) {
      const { data: claimed } = await service
        .from("profile_reviews")
        .update({ status: "RUNNING", started_at: new Date().toISOString(), error: null })
        .eq("id", review.id)
        .eq("status", review.status)
        .select("id");
      if (!claimed?.length) continue;
    }

    const { data: account } = await service
      .from("social_accounts")
      .select("id, display_name, role_focus, role_note, access_token_encrypted, is_active, disconnected_at")
      .eq("id", review.social_account_id)
      .maybeSingle();

    try {
      if (!account || account.disconnected_at) throw new ReviewError("연결이 해제된 계정이에요.");
      if (!account.access_token_encrypted) throw new ReviewError("계정 토큰이 없어요. 계정 연동에서 다시 연결하세요.");
      const token = decryptToken(account.access_token_encrypted);

      const api = await getProfileDetails(token);
      const result = await scoreProfile({
        service: dryRun ? null : service,
        reviewId: review.id,
        account,
        api,
        manual: (review.manual_input ?? {}) as ProfileManualInput,
        rules,
      });

      console.log(
        `[review-profiles] @${result.snapshot.handle}: ${result.total}/100 → 고치면 ${result.rescore} | ` +
          `API 칸 ${api.fields.length}개 | 토큰 ${result.tokens.input}/${result.tokens.output}`,
      );
      if (dryRun) {
        console.log(JSON.stringify({ items: result.items, rewrites: result.rewrites, summary: result.summary }, null, 2));
        continue;
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
        .eq("id", review.id);
    } catch (err) {
      const message = failMessage(err);
      console.error(`[review-profiles] ${account?.display_name ?? review.social_account_id}: ${message}`);
      process.exitCode = 1;
      if (!dryRun) {
        await service
          .from("profile_reviews")
          .update({ status: "FAILED", error: message, finished_at: new Date().toISOString() })
          .eq("id", review.id);
      }
    }
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("[review-profiles] 치명적 오류:", err);
    process.exit(1);
  });
