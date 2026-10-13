import type { createServiceClient } from "@/lib/supabase/service";

/**
 * publish_jobs.status_history(jsonb 배열)에 항목을 덧붙인다. service_role 전용.
 * 배열이라 RPC 없이 일괄 append가 어려워 단건으로 처리 — 사용자 액션이라
 * 동시성이 거의 없어 race risk는 의식적으로 무시한다.
 */
export function appendPublishHistory(
  service: ReturnType<typeof createServiceClient>,
  ids: string[],
  entry: { status: string; message?: string },
) {
  return Promise.all(
    ids.map(async (id) => {
      const { data } = await service
        .from("publish_jobs")
        .select("status_history")
        .eq("id", id)
        .maybeSingle<{ status_history: unknown }>();
      const prev = Array.isArray(data?.status_history)
        ? (data.status_history as unknown[])
        : [];
      const next = [
        ...prev,
        { ...entry, timestamp: new Date().toISOString() },
      ];
      await service
        .from("publish_jobs")
        // @ts-expect-error status_history는 0007 마이그레이션 이후 추가
        .update({ status_history: next })
        .eq("id", id);
    }),
  );
}
