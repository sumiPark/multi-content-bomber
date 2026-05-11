"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

// publish_jobs UPDATE/DELETE 정책이 authenticated에 없으므로 서버 액션에서
// service_role 키로 처리한다. 권한 검증은 직접 수행: caller의 organization_id와
// 대상 publish_jobs.content.organization_id가 일치하는지 확인.

const idsSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
});

export type PostingActionResult =
  | { ok: true; affected: number }
  | { ok: false; error: string };

interface AuthOk {
  ok: true;
  userId: string;
  organizationId: string;
  role: string;
}

async function authorize(): Promise<
  AuthOk | { ok: false; error: string }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "로그인이 필요합니다." };

  const { data: profile } = await supabase
    .from("profiles")
    .select("organization_id, role")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile?.organization_id) {
    return { ok: false, error: "소속된 조직이 없습니다." };
  }
  return {
    ok: true,
    userId: user.id,
    organizationId: profile.organization_id,
    role: profile.role,
  };
}

interface JobOwnership {
  id: string;
  status: string;
  organization_id: string;
}

async function fetchJobsByIds(ids: string[]): Promise<JobOwnership[]> {
  const service = createServiceClient();
  const { data } = await service
    .from("publish_jobs")
    .select("id, status, contents!inner ( organization_id )")
    .in("id", ids);
  return (data ?? []).map((r) => ({
    id: r.id,
    status: r.status,
    organization_id: (r.contents as { organization_id: string }).organization_id,
  }));
}

function appendHistory(
  service: ReturnType<typeof createServiceClient>,
  ids: string[],
  entry: { status: string; message?: string },
) {
  // status_history는 jsonb 배열이라 RPC 없이 일괄 append 어려움. 단건으로 처리.
  // 사용자 액션이라 동시성 거의 없음. race risk는 의식적으로 무시.
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

function filterByOrg<T extends { organization_id: string }>(
  rows: T[],
  organizationId: string,
): T[] {
  return rows.filter((r) => r.organization_id === organizationId);
}

export async function retryPostingsAction(
  input: z.infer<typeof idsSchema>,
): Promise<PostingActionResult> {
  const parsed = idsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };

  const auth = await authorize();
  if (!auth.ok) return auth;

  const jobs = await fetchJobsByIds(parsed.data.ids);
  const owned = filterByOrg(jobs, auth.organizationId);
  // 실패 상태만 대상.
  const targets = owned.filter((j) => j.status === "FAILED");
  if (targets.length === 0) {
    return { ok: false, error: "재시도할 수 있는 항목이 없습니다." };
  }

  const ids = targets.map((t) => t.id);
  const service = createServiceClient();
  const { error } = await service
    .from("publish_jobs")
    .update({
      status: "PENDING",
      last_error: null,
      attempts: 0,
    })
    .in("id", ids);
  if (error) return { ok: false, error: error.message };

  await appendHistory(service, ids, {
    status: "PENDING",
    message: "사용자 재시도 요청",
  });

  revalidatePath("/postings");
  return { ok: true, affected: ids.length };
}

export async function cancelPostingsAction(
  input: z.infer<typeof idsSchema>,
): Promise<PostingActionResult> {
  const parsed = idsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };

  const auth = await authorize();
  if (!auth.ok) return auth;

  const jobs = await fetchJobsByIds(parsed.data.ids);
  const owned = filterByOrg(jobs, auth.organizationId);
  // 예약중(PENDING with future scheduled) 또는 RETRYING/PROCESSING은 대상 외 — 여기선 PENDING만 허용.
  const targets = owned.filter((j) => j.status === "PENDING");
  if (targets.length === 0) {
    return { ok: false, error: "취소할 수 있는 예약 항목이 없습니다." };
  }

  const ids = targets.map((t) => t.id);
  const service = createServiceClient();
  const nowIso = new Date().toISOString();
  const { error } = await service
    .from("publish_jobs")
    .update({
      // 0007 이후 enum에 CANCELLED 추가됨. 타입 재생성 전이므로 cast.
      status: "CANCELLED" as never,
      // @ts-expect-error cancelled_at은 0007 마이그레이션 이후 추가
      cancelled_at: nowIso,
    })
    .in("id", ids);
  if (error) return { ok: false, error: error.message };

  await appendHistory(service, ids, {
    status: "CANCELLED",
    message: "사용자 예약 취소",
  });

  revalidatePath("/postings");
  return { ok: true, affected: ids.length };
}

export async function deletePostingsAction(
  input: z.infer<typeof idsSchema>,
): Promise<PostingActionResult> {
  const parsed = idsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };

  const auth = await authorize();
  if (!auth.ok) return auth;

  const jobs = await fetchJobsByIds(parsed.data.ids);
  const owned = filterByOrg(jobs, auth.organizationId);
  if (owned.length === 0) {
    return { ok: false, error: "삭제할 항목이 없습니다." };
  }

  const ids = owned.map((t) => t.id);
  const service = createServiceClient();
  const { error } = await service
    .from("publish_jobs")
    .update({
      // @ts-expect-error deleted_at은 0007 마이그레이션 이후 추가
      deleted_at: new Date().toISOString(),
    })
    .in("id", ids);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/postings");
  return { ok: true, affected: ids.length };
}
