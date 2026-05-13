import type { Job } from "bullmq";
import { type TokenRefreshJobData } from "@/lib/queue/token-refresh-queue";
import { createServiceClient } from "@/lib/supabase/service";
import { decryptToken, encryptToken } from "@/lib/crypto";
import {
  getAdapter,
  TokenExpiredError,
  type Platform,
} from "@/lib/platforms";

// 만료까지 이 시간 미만 남은 계정을 sweep 대상으로 본다. YouTube access_token이
// 1시간 짜리라 1시간 윈도우면 30분 주기 sweep과 합쳐 적어도 한 번은 잡힌다.
const REFRESH_THRESHOLD_MS = 60 * 60 * 1000;

// 한 번 sweep에서 처리할 최대 계정 수. 만료가 동시에 몰려도 ioredis blocking + 외부
// API 호출이 너무 길어지지 않게. 못 잡힌 잔여는 다음 30분 주기에 자연스럽게 처리.
const BATCH_LIMIT = 100;

interface AccountRow {
  id: string;
  platform: Platform;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expires_at: string | null;
}

interface SweepStats {
  total: number;
  refreshed: number;
  deactivated: number;
  failed: number;
}

/**
 * 만료 임박 토큰 sweep. publish processor와 달리 row 하나가 실패해도 sweep job
 * 자체는 성공으로 끝낸다 (BullMQ가 30분 주기로 다시 불러줄 거니까).
 *
 * 정책:
 *   - TokenExpiredError (invalid_grant) → social_accounts.is_active=false
 *   - 그 외 에러 → 로그만 남기고 다음 sweep에서 재시도
 *
 * accountIds가 명시되면 만료 여부 무관하게 그 계정들만 강제 refresh — 운영 디버깅용.
 */
export async function processTokenRefreshSweep(
  job: Job<TokenRefreshJobData>,
): Promise<SweepStats> {
  const supabase = createServiceClient();
  const now = new Date();
  const stats: SweepStats = { total: 0, refreshed: 0, deactivated: 0, failed: 0 };

  // 1. 대상 계정 조회
  let query = supabase
    .from("social_accounts")
    .select(
      "id, platform, access_token_encrypted, refresh_token_encrypted, token_expires_at",
    )
    .eq("is_active", true)
    .not("refresh_token_encrypted", "is", null);

  const targetIds = job.data.accountIds;
  if (targetIds && targetIds.length > 0) {
    query = query.in("id", targetIds);
  } else {
    // 만료까지 1시간 미만 남은 것들. token_expires_at IS NULL은 영구 토큰
    // (Instagram 비즈니스 long-lived 등)이거나 만료 시각 미상 — sweep 대상 아님.
    const cutoff = new Date(now.getTime() + REFRESH_THRESHOLD_MS).toISOString();
    query = query.lt("token_expires_at", cutoff);
  }

  const { data: accounts, error } = await query
    .limit(BATCH_LIMIT)
    .returns<AccountRow[]>();

  if (error) {
    console.error("[token-refresh] social_accounts 조회 실패:", error.message);
    return stats;
  }

  stats.total = accounts?.length ?? 0;
  if (stats.total === 0) return stats;

  console.log(`[token-refresh] sweep start | targets=${stats.total}`);

  // 2. 직렬 처리. 100개여도 API당 ~수백ms라 1-2분 안에 끝난다.
  for (const account of accounts ?? []) {
    try {
      await refreshOne(supabase, account);
      stats.refreshed++;
    } catch (err) {
      if (err instanceof TokenExpiredError) {
        // refresh_token이 revoke됨. 사용자 재연동 필요.
        await supabase
          .from("social_accounts")
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq("id", account.id);
        stats.deactivated++;
        console.warn(
          `[token-refresh] ${account.id} (${account.platform}) deactivated: ${err.message}`,
        );
      } else {
        stats.failed++;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[token-refresh] ${account.id} (${account.platform}) failed: ${msg}`,
        );
      }
    }
  }

  console.log(`[token-refresh] sweep done`, stats);
  return stats;
}

async function refreshOne(
  supabase: ReturnType<typeof createServiceClient>,
  account: AccountRow,
): Promise<void> {
  if (!account.refresh_token_encrypted) {
    // 위 쿼리에서 not null 필터링하므로 사실상 도달 안 함. 방어.
    throw new Error("refresh_token_encrypted가 비어있습니다");
  }
  const adapter = getAdapter(account.platform);
  if (!adapter) {
    throw new Error(`지원하지 않는 플랫폼: ${account.platform}`);
  }

  const refreshPlain = decryptToken(account.refresh_token_encrypted);
  const refreshed = await adapter.refreshToken(refreshPlain);

  const newAccessEnc = encryptToken(refreshed.accessToken);
  // refresh_token이 응답에 같이 오면 갱신, 없으면 기존 유지 (Google이 일반적으로 이 케이스).
  const newRefreshEnc = refreshed.refreshToken
    ? encryptToken(refreshed.refreshToken)
    : account.refresh_token_encrypted;
  const newExpiresAt = refreshed.expiresAt
    ? refreshed.expiresAt.toISOString()
    : null;

  const { error } = await supabase
    .from("social_accounts")
    .update({
      access_token_encrypted: newAccessEnc,
      refresh_token_encrypted: newRefreshEnc,
      token_expires_at: newExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", account.id);

  if (error) {
    throw new Error(`DB 업데이트 실패: ${error.message}`);
  }
}
