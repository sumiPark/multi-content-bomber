import type { Job } from "bullmq";
import { type PublishJobData } from "@/lib/queue/publish-queue";
import { createServiceClient } from "@/lib/supabase/service";
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

interface PublishResult {
  platformPostId: string;
  platformPostUrl: string;
}

/**
 * BullMQ processor — publish_jobs 상태 머신.
 *
 * 흐름:
 *   PENDING → (워커 pickup) → PROCESSING → SUCCESS
 *                                       ↘ (throw, 아직 재시도 남음) → RETRYING → (BullMQ backoff) → PROCESSING …
 *                                       ↘ (마지막 시도 실패) → FAILED
 *
 * 멱등성:
 *   - 이미 SUCCESS/CANCELLED인 row가 들어오면 skip. BullMQ가 같은 jobId 중복 처리
 *     하거나, 외부에서 row 상태가 먼저 바뀐 경우(예: 사용자가 CANCEL) 안전.
 *
 * 재시도:
 *   - processor 내부에서 throw → BullMQ가 attempt++ 후 backoff 후 재호출.
 *   - 우리는 매 호출 시 attempts 컬럼과 status_history를 갱신.
 *   - 마지막 시도까지 실패하면 status=FAILED + completed_at 기록.
 */
export async function processPublishJob(job: Job<PublishJobData>) {
  const supabase = createServiceClient();
  const { publishJobId } = job.data;
  const attemptNumber = job.attemptsMade + 1;
  const maxAttempts = job.opts.attempts ?? 1;

  // 1. DB row 조회 (service_role — RLS 우회)
  const { data: row, error: fetchError } = await supabase
    .from("publish_jobs")
    .select(
      "id, content_id, social_account_id, status, attempts, status_history",
    )
    .eq("id", publishJobId)
    .maybeSingle<PublishJobRow>();

  if (fetchError) {
    throw new Error(`publish_jobs fetch 실패: ${fetchError.message}`);
  }
  if (!row) {
    // BullMQ에 재시도해도 의미 없는 영구 실패. 다만 throw하면 재시도가 발동한다.
    // 추후 cron 정합성 작업에서 처리할 일이므로 일단 throw.
    throw new Error(`publish_jobs row가 없습니다: ${publishJobId}`);
  }

  // 멱등성 가드
  if (row.status === "SUCCESS" || row.status === "CANCELLED") {
    return { skipped: true, reason: `이미 ${row.status} 상태` };
  }

  const baseHistory: StatusHistoryEntry[] = Array.isArray(row.status_history)
    ? (row.status_history as unknown as StatusHistoryEntry[])
    : [];

  const nowIso = () => new Date().toISOString();

  // 2. PROCESSING으로 전환 + history 기록
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
      status: "PROCESSING",
      attempts: attemptNumber,
      status_history: processingHistory,
      updated_at: nowIso(),
    })
    .eq("id", publishJobId);

  if (lockError) {
    throw new Error(`PROCESSING update 실패: ${lockError.message}`);
  }

  try {
    // 3. 실제 게시 — Phase 4b ④에서 lib/platforms 어댑터 호출로 교체.
    const result = await stubPublish(row);

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

    const failureHistory: StatusHistoryEntry[] = [
      ...processingHistory,
      { status: nextStatus, timestamp: nowIso(), message: errorMsg },
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

    // BullMQ에 throw 다시 — 재시도 메커니즘(또는 최종 failed 이벤트) 발동.
    throw err;
  }
}

/**
 * 임시 stub. Phase 4b ④에서 lib/platforms/{youtube,instagram,tiktok}.ts의
 * publish() 어댑터 호출로 교체된다. 지금은 happy path만 검증하기 위한 mock.
 */
async function stubPublish(row: PublishJobRow): Promise<PublishResult> {
  // 가짜 API latency
  await new Promise((resolve) => setTimeout(resolve, 200));
  return {
    platformPostId: `stub-${row.id.slice(0, 8)}-${Date.now()}`,
    platformPostUrl: `https://example.com/stub/${row.id}`,
  };
}
