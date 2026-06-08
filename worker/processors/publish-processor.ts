import { createServiceClient } from "@/lib/supabase/service";
import { decryptToken, encryptToken } from "@/lib/crypto";
import {
  getAdapter,
  MediaError,
  PublishError,
  RateLimitedError,
  TokenExpiredError,
  type Platform,
  type PublishContext,
  type RefreshedTokens,
} from "@/lib/platforms";
import type { Json } from "@/types/database";

// publish_jobs.status_history는 jsonb. 워커가 쓰는 항목 형태.
// (DB 컬럼 정의: docs/functional-specification.md §6.8, migration 0007)
// index signature는 `Json` 타입과의 구조적 호환을 위해 필요 — jsonb 컬럼에
// 그대로 update하려면 `{ [key: string]: Json | undefined }`를 만족해야 한다.
interface StatusHistoryEntry {
  status: string;
  timestamp: string;
  message?: string;
  [key: string]: Json | undefined;
}

interface PublishJobRow {
  id: string;
  content_id: string;
  social_account_id: string;
  status: string;
  attempts: number;
  status_history: Json | null;
}

interface AccountRow {
  id: string;
  platform: Platform;
  platform_account_id: string;
  is_active: boolean;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expires_at: string | null;
}

interface ContentRow {
  id: string;
  media_type: "VIDEO" | "PHOTO";
  media_urls: string[];
  title: string | null;
  internal_title: string | null;
  ai_captions: Json | null;
}

const MEDIA_BUCKET = "media";
const SIGNED_URL_TTL_SEC = 600; // 10분 — YouTube 업로드 한 번에 끝나기 충분
const TOKEN_REFRESH_BUFFER_MS = 60_000; // 만료 1분 전부터 미리 갱신

/**
 * BullMQ processor — publish_jobs 상태 머신.
 *
 * 흐름:
 *   PENDING → (claim RPC가 PROCESSING으로 선점) → 처리 → SUCCESS
 *                                       ↘ (throw, 아직 재시도 남음) → RETRYING → (다음 cron/dispatch) → PROCESSING …
 *                                       ↘ (마지막 시도 실패) → FAILED
 *
 * 큐 모델 (Phase 4b — Postgres 큐):
 *   - BullMQ 대신 claim_due_publish_jobs RPC가 FOR UPDATE SKIP LOCKED로 due job을
 *     선점(status=PROCESSING)한 뒤 이 함수에 그 row를 넘긴다.
 *   - 재시도는 BullMQ backoff가 아니라, 실패 시 status=RETRYING으로 남기면 다음 cron
 *     sweep(또는 dispatch)이 다시 claim해 처리한다. attempts < maxAttempts 동안 반복.
 *   - 처리 중 워커가 크래시하면 PROCESSING으로 멈추지만, claim RPC가 stale PROCESSING
 *     (updated_at 오래됨)을 회수하므로 유실되지 않는다.
 *
 * 에러 분기 (Phase 4b ④):
 *   - TokenExpiredError → social_accounts.is_active=false 마킹 후 throw (재시도해도
 *     같은 토큰이라 의미 없음 — 마지막 시도에서 FAILED로 안착).
 *   - RateLimitedError / MediaError / PublishError → throw → RETRYING으로 다음 sweep 위임.
 */
export async function processClaimedPublishJob(
  supabase: ReturnType<typeof createServiceClient>,
  row: PublishJobRow,
  maxAttempts: number,
) {
  const publishJobId = row.id;
  const attemptNumber = row.attempts + 1;

  const baseHistory: StatusHistoryEntry[] = Array.isArray(row.status_history)
    ? (row.status_history as unknown as StatusHistoryEntry[])
    : [];

  const nowIso = () => new Date().toISOString();

  // status=PROCESSING은 claim_due_publish_jobs RPC가 이미 원자적으로 선점했다.
  // 여기서는 attempts 증가 + history 기록만 한다.
  const processingHistory: StatusHistoryEntry[] = [
    ...baseHistory,
    {
      status: "PROCESSING",
      timestamp: nowIso(),
      message: `attempt ${attemptNumber}/${maxAttempts}`,
    },
  ];

  const { error: lockError } = await supabase
    .from("publish_jobs")
    .update({
      attempts: attemptNumber,
      status_history: processingHistory,
      updated_at: nowIso(),
    })
    .eq("id", publishJobId);

  if (lockError) {
    throw new Error(`PROCESSING update 실패: ${lockError.message}`);
  }

  try {
    // 3. social_accounts + contents 조회 → 어댑터로 게시
    const result = await runPublish(supabase, row);

    // 4. SUCCESS 마킹
    const successHistory: StatusHistoryEntry[] = [
      ...processingHistory,
      { status: "SUCCESS", timestamp: nowIso() },
    ];

    const { error: successError } = await supabase
      .from("publish_jobs")
      .update({
        status: "SUCCESS",
        completed_at: nowIso(),
        platform_post_id: result.platformPostId,
        platform_post_url: result.platformPostUrl,
        status_history: successHistory,
        updated_at: nowIso(),
        last_error: null,
      })
      .eq("id", publishJobId);

    if (successError) {
      // DB는 실패했지만 외부 게시는 이미 성공한 상태. 워커 로그로 남기고
      // 다음 단계(데이터 정합성 cron)에서 sweep하도록 둔다.
      console.error(
        `[publish-processor] SUCCESS update 실패 (외부 게시는 완료): ${successError.message}`,
      );
    }

    return { ok: true, ...result };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const isLastAttempt = attemptNumber >= maxAttempts;
    const nextStatus = isLastAttempt ? "FAILED" : "RETRYING";

    // 토큰 만료 / revoke는 계정 자체가 죽은 상태 — 같은 토큰으로 재시도 의미 없음.
    // social_accounts.is_active=false로 마킹해 UI/스케줄러가 재시도 안 하게.
    if (err instanceof TokenExpiredError) {
      await supabase
        .from("social_accounts")
        .update({ is_active: false, updated_at: nowIso() })
        .eq("id", row.social_account_id);
    }

    const failureHistory: StatusHistoryEntry[] = [
      ...processingHistory,
      {
        status: nextStatus,
        timestamp: nowIso(),
        message: `${classifyError(err)}: ${errorMsg}`,
      },
    ];

    await supabase
      .from("publish_jobs")
      .update({
        status: nextStatus,
        last_error: errorMsg,
        status_history: failureHistory,
        updated_at: nowIso(),
        ...(isLastAttempt ? { completed_at: nowIso() } : {}),
      })
      .eq("id", publishJobId);

    // status는 위에서 이미 RETRYING/FAILED로 기록됨. 호출측(process-due)이 job별로
    // catch해 로그만 남긴다 — 재시도는 RETRYING row를 다음 sweep이 다시 claim.
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 실제 게시 흐름. 외부 호출(어댑터/Storage) 전부 이 함수 안. 실패는 던지면
// 위 try/catch가 status_history에 기록.
// ─────────────────────────────────────────────────────────────────────────────

async function runPublish(
  supabase: ReturnType<typeof createServiceClient>,
  row: PublishJobRow,
) {
  // 3a. social_accounts 조회 (토큰 컬럼 포함 — service_role 필수)
  const { data: account, error: accountError } = await supabase
    .from("social_accounts")
    .select(
      "id, platform, platform_account_id, is_active, access_token_encrypted, refresh_token_encrypted, token_expires_at",
    )
    .eq("id", row.social_account_id)
    .maybeSingle<AccountRow>();

  if (accountError || !account) {
    throw new PublishError(
      `social_accounts 조회 실패: ${accountError?.message ?? "row 없음"}`,
    );
  }
  if (!account.is_active) {
    throw new TokenExpiredError(
      `social_account가 비활성 상태입니다 (id=${account.id})`,
    );
  }
  if (!account.access_token_encrypted) {
    throw new TokenExpiredError(
      `access_token이 없습니다 (id=${account.id}) — 재연동 필요`,
    );
  }

  // 3b. contents 조회
  const { data: content, error: contentError } = await supabase
    .from("contents")
    .select("id, media_type, media_urls, title, internal_title, ai_captions")
    .eq("id", row.content_id)
    .maybeSingle<ContentRow>();

  if (contentError || !content) {
    throw new PublishError(
      `contents 조회 실패: ${contentError?.message ?? "row 없음"}`,
    );
  }

  // 3c. adapter 선택
  const adapter = getAdapter(account.platform);
  if (!adapter) {
    throw new PublishError(`지원하지 않는 플랫폼: ${account.platform}`);
  }

  // 3d. 토큰 — 만료 임박이면 refresh
  const accessToken = await ensureFreshToken(supabase, account, adapter);

  // 3e. Storage 단기 서명 URL
  const mediaSignedUrls = await signMedia(supabase, content.media_urls);

  // 3f. 캡션 컨텍스트 조립 + 미디어 URL/계정 ID 주입
  const publishCtx: PublishContext = {
    ...buildPublishContext(content, account.platform),
    platformAccountId: account.platform_account_id,
    mediaSignedUrls,
  };

  // 3g. 게시
  return await adapter.publish(publishCtx, accessToken);
}

// ─────────────────────────────────────────────────────────────────────────────
// 토큰 정책: 만료까지 1분 미만이면 refresh를 시도. refresh_token이 없으면 그대로
// 현재 토큰 사용 (Instagram short-lived처럼 refresh API가 없는 케이스).
// 새 토큰은 즉시 암호화해서 DB 저장 — 같은 워커 인스턴스가 다음 job에서도 신선한
// 토큰을 쓰도록.
// ─────────────────────────────────────────────────────────────────────────────

async function ensureFreshToken(
  supabase: ReturnType<typeof createServiceClient>,
  account: AccountRow,
  adapter: ReturnType<typeof getAdapter>,
): Promise<string> {
  if (!adapter) throw new PublishError("adapter가 null");
  if (!account.access_token_encrypted) {
    throw new TokenExpiredError("access_token_encrypted가 비어있습니다");
  }

  const accessToken = decryptToken(account.access_token_encrypted);
  const expiresAt = account.token_expires_at
    ? new Date(account.token_expires_at).getTime()
    : null;
  const needsRefresh =
    expiresAt !== null && expiresAt - Date.now() < TOKEN_REFRESH_BUFFER_MS;

  if (!needsRefresh) return accessToken;
  if (!account.refresh_token_encrypted) {
    // 만료됐지만 refresh 수단이 없으면 일단 access_token으로 시도. 어댑터가
    // 401을 받으면 TokenExpiredError로 위에서 처리됨.
    return accessToken;
  }

  const refreshTokenPlain = decryptToken(account.refresh_token_encrypted);

  let refreshed: RefreshedTokens;
  try {
    refreshed = await adapter.refreshToken(refreshTokenPlain);
  } catch (err) {
    // refresh가 TokenExpiredError를 던지면 그대로 위로 — 계정 비활성 처리됨.
    throw err;
  }

  // 새 토큰 암호화 저장. refresh_token이 응답에 있으면 갱신, 없으면 기존 유지.
  const newAccessEncrypted = encryptToken(refreshed.accessToken);
  const newRefreshEncrypted = refreshed.refreshToken
    ? encryptToken(refreshed.refreshToken)
    : account.refresh_token_encrypted;
  const newExpiresAt = refreshed.expiresAt
    ? refreshed.expiresAt.toISOString()
    : null;

  const { error: updateError } = await supabase
    .from("social_accounts")
    .update({
      access_token_encrypted: newAccessEncrypted,
      refresh_token_encrypted: newRefreshEncrypted,
      token_expires_at: newExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", account.id);

  if (updateError) {
    // 외부에선 새 토큰 발급됐지만 DB 저장 실패. 다음 job에서 또 refresh됨 — idempotent.
    console.error(
      `[publish-processor] 새 토큰 DB 저장 실패 (id=${account.id}): ${updateError.message}`,
    );
  }

  return refreshed.accessToken;
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage 서명 URL. media_urls는 "userId/uuid.mp4" 같은 경로 배열.
// ─────────────────────────────────────────────────────────────────────────────

async function signMedia(
  supabase: ReturnType<typeof createServiceClient>,
  paths: string[],
): Promise<string[]> {
  if (paths.length === 0) {
    throw new MediaError("contents.media_urls가 비어있습니다");
  }
  const { data, error } = await supabase.storage
    .from(MEDIA_BUCKET)
    .createSignedUrls(paths, SIGNED_URL_TTL_SEC);
  if (error) {
    throw new MediaError(`Storage 서명 URL 생성 실패: ${error.message}`);
  }
  const urls: string[] = [];
  for (const item of data ?? []) {
    if (item.error || !item.signedUrl) {
      throw new MediaError(`서명 URL 항목 실패: ${item.error ?? "no url"}`);
    }
    urls.push(item.signedUrl);
  }
  return urls;
}

// ─────────────────────────────────────────────────────────────────────────────
// ai_captions(jsonb)에서 플랫폼별 필드를 풀어 PublishContext에 채운다.
// captions schema는 lib/ai/caption-generator.ts와 동기화:
//   youtube   { title, description, hashtags, category? }
//   instagram { caption, hashtags, cover_text? }
//   tiktok    { caption, hashtags }
// ─────────────────────────────────────────────────────────────────────────────

function buildPublishContext(
  content: ContentRow,
  platform: Platform,
): PublishContext {
  const captions = (content.ai_captions ?? {}) as Record<string, unknown>;

  const empty: PublishContext = {
    contentId: content.id,
    // platformAccountId / mediaSignedUrls는 runPublish가 spread로 주입.
    platformAccountId: "",
    mediaType: content.media_type,
    mediaSignedUrls: [],
    title: null,
    description: null,
    caption: null,
    hashtags: [],
  };

  if (platform === "YOUTUBE") {
    const yt = (captions.youtube ?? {}) as {
      title?: string;
      description?: string;
      hashtags?: string[];
    };
    // YouTube는 title 필수. ?? 만 쓰면 빈 문자열("")도 통과해버려 어댑터에서
    // throw — trim 후 truthy인 첫 값을 고른다. 최종 fallback은 콘텐츠 id로.
    const pick = (...vals: Array<string | null | undefined>) =>
      vals.find((v) => v && v.trim().length > 0)?.trim();
    return {
      ...empty,
      title:
        pick(yt.title, content.internal_title, content.title) ??
        `MCB upload ${content.id.slice(0, 8)}`,
      description: yt.description ?? null,
      hashtags: Array.isArray(yt.hashtags) ? yt.hashtags : [],
    };
  }

  if (platform === "INSTAGRAM") {
    const ig = (captions.instagram ?? {}) as {
      caption?: string;
      hashtags?: string[];
    };
    return {
      ...empty,
      caption: ig.caption ?? null,
      hashtags: Array.isArray(ig.hashtags) ? ig.hashtags : [],
    };
  }

  // TIKTOK
  const tt = (captions.tiktok ?? {}) as {
    caption?: string;
    hashtags?: string[];
  };
  return {
    ...empty,
    caption: tt.caption ?? null,
    hashtags: Array.isArray(tt.hashtags) ? tt.hashtags : [],
  };
}

function classifyError(err: unknown): string {
  if (err instanceof TokenExpiredError) return "TOKEN_EXPIRED";
  if (err instanceof RateLimitedError) return "RATE_LIMITED";
  if (err instanceof MediaError) return "MEDIA_ERROR";
  if (err instanceof PublishError) return "PUBLISH_ERROR";
  return "UNKNOWN";
}
