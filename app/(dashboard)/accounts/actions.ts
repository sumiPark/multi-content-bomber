"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { appendPublishHistory } from "@/lib/publish-history";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

const disconnectSchema = z.object({
  accountId: z.string().uuid(),
});

// React 19 form action prop requires Promise<void>. Errors are surfaced via
// redirect to /accounts?error=... where the page renders an inline banner.
//
// 연결 해제는 소프트 삭제다 (0016). 행을 지우면 발행 이력이 같이 사라지므로
// disconnected_at만 기록하고 토큰은 즉시 비운다 (개인정보처리방침의 "해제 시 토큰 즉시
// 삭제" 약속). 같은 계정을 다시 연결하면 OAuth 콜백 upsert가 같은 행을 되살린다.
export async function disconnectAccountAction(
  formData: FormData,
): Promise<void> {
  const parsed = disconnectSchema.safeParse({
    accountId: formData.get("accountId"),
  });
  if (!parsed.success) {
    redirect(`/accounts?error=${encodeURIComponent("잘못된 입력")}`);
  }

  const auth = await authorize();
  if (!auth.ok) {
    redirect(`/accounts?error=${encodeURIComponent(auth.error)}`);
  }

  // 토큰 컬럼은 authenticated에서 UPDATE가 revoke돼 있어 service_role로 처리.
  // 권한은 위 authorize()에서, 조직 범위는 organization_id 조건으로 직접 건다.
  const service = createServiceClient();
  const nowIso = new Date().toISOString();
  const { data: disconnected, error } = await service
    .from("social_accounts")
    .update({
      disconnected_at: nowIso,
      is_active: false,
      access_token_encrypted: null,
      refresh_token_encrypted: null,
      token_expires_at: null,
    })
    .eq("id", parsed.data.accountId)
    .eq("organization_id", auth.organizationId)
    .is("disconnected_at", null)
    .select("id");

  if (error) {
    redirect(`/accounts?error=${encodeURIComponent(error.message)}`);
  }
  if (!disconnected || disconnected.length === 0) {
    redirect(
      `/accounts?error=${encodeURIComponent("이미 해제됐거나 찾을 수 없는 계정입니다.")}`,
    );
  }

  // 워커가 아직 잡지 않은 발행 건(예약/대기·재시도 대기)은 취소로 남긴다. 그대로 두면
  // 토큰이 없어 시도마다 실패만 쌓인다. PROCESSING은 워커 결과 기록에 덮이므로 건드리지 않음.
  const { data: cancelled } = await service
    .from("publish_jobs")
    .update({ status: "CANCELLED", cancelled_at: nowIso })
    .eq("social_account_id", parsed.data.accountId)
    .in("status", ["PENDING", "RETRYING"])
    .is("deleted_at", null)
    .select("id");

  const cancelledIds = (cancelled ?? []).map((r) => r.id);
  if (cancelledIds.length > 0) {
    await appendPublishHistory(service, cancelledIds, {
      status: "CANCELLED",
      message: "계정 연결 해제로 발행 취소",
    });
  }

  revalidatePath("/accounts");
  revalidatePath("/");
  revalidatePath("/postings");
  revalidatePath("/upload");
}

// ─────────────────────────────────────────────────────────────────────────────
// 계정 그룹 (account_groups) — 0009 마이그레이션 기준
// 1:N: 계정 1개는 그룹 0~1개에 속함. 그룹 미지정도 정상.
// ─────────────────────────────────────────────────────────────────────────────

const VALID_COLORS = [
  "zinc",
  "red",
  "amber",
  "green",
  "blue",
  "pink",
  "purple",
] as const;

const groupInputSchema = z.object({
  name: z.string().min(1, "이름을 입력해주세요.").max(50, "이름은 50자 이내"),
  description: z.string().max(200).optional().nullable(),
  color: z.enum(VALID_COLORS).default("zinc"),
});

const updateGroupSchema = groupInputSchema.extend({
  id: z.string().uuid(),
});

const idSchema = z.object({ id: z.string().uuid() });

const assignSchema = z.object({
  accountIds: z.array(z.string().uuid()).min(1).max(100),
  groupId: z.string().uuid().nullable(),
});

export type GroupActionResult =
  | { ok: true }
  | { ok: false; error: string };

interface AuthCtx {
  ok: true;
  organizationId: string;
  userId: string;
  role: string;
}

async function authorize(): Promise<AuthCtx | { ok: false; error: string }> {
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
  if (profile.role !== "ADMIN" && profile.role !== "MANAGER") {
    return { ok: false, error: "계정 관리 권한이 없습니다." };
  }
  return {
    ok: true,
    organizationId: profile.organization_id,
    userId: user.id,
    role: profile.role,
  };
}

export async function createGroupAction(
  input: z.infer<typeof groupInputSchema>,
): Promise<GroupActionResult> {
  const parsed = groupInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "잘못된 입력" };
  }

  const auth = await authorize();
  if (!auth.ok) return auth;

  const supabase = await createClient();
  // 0009 마이그레이션 이후 추가된 테이블. 타입 재생성 전이라 cast.
  const untyped = supabase as unknown as {
    from: (t: string) => {
      insert: (v: unknown) => Promise<{ error: { message: string } | null }>;
    };
  };
  const { error } = await untyped.from("account_groups").insert({
    organization_id: auth.organizationId,
    created_by: auth.userId,
    name: parsed.data.name.trim(),
    description: parsed.data.description?.trim() || null,
    color: parsed.data.color,
  });

  if (error) {
    if (error.message.includes("account_groups_name_per_org_unique")) {
      return { ok: false, error: "이미 같은 이름의 그룹이 있어요." };
    }
    return { ok: false, error: error.message };
  }

  revalidatePath("/accounts");
  revalidatePath("/upload");
  return { ok: true };
}

export async function updateGroupAction(
  input: z.infer<typeof updateGroupSchema>,
): Promise<GroupActionResult> {
  const parsed = updateGroupSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "잘못된 입력" };
  }

  const auth = await authorize();
  if (!auth.ok) return auth;

  const supabase = await createClient();
  const untyped = supabase as unknown as {
    from: (t: string) => {
      update: (v: unknown) => {
        eq: (
          col: string,
          val: string,
        ) => Promise<{ error: { message: string } | null }>;
      };
    };
  };
  const { error } = await untyped
    .from("account_groups")
    .update({
      name: parsed.data.name.trim(),
      description: parsed.data.description?.trim() || null,
      color: parsed.data.color,
    })
    .eq("id", parsed.data.id);

  if (error) return { ok: false, error: error.message };

  revalidatePath("/accounts");
  revalidatePath("/upload");
  return { ok: true };
}

export async function deleteGroupAction(
  input: z.infer<typeof idSchema>,
): Promise<GroupActionResult> {
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 ID" };

  const auth = await authorize();
  if (!auth.ok) return auth;

  // ON DELETE SET NULL이라 소속 계정의 group_id가 자동 NULL로 풀림.
  const supabase = await createClient();
  const untyped = supabase as unknown as {
    from: (t: string) => {
      delete: () => {
        eq: (
          col: string,
          val: string,
        ) => Promise<{ error: { message: string } | null }>;
      };
    };
  };
  const { error } = await untyped
    .from("account_groups")
    .delete()
    .eq("id", parsed.data.id);

  if (error) return { ok: false, error: error.message };

  revalidatePath("/accounts");
  revalidatePath("/upload");
  return { ok: true };
}

export async function assignAccountsToGroupAction(
  input: z.infer<typeof assignSchema>,
): Promise<GroupActionResult> {
  const parsed = assignSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };

  const auth = await authorize();
  if (!auth.ok) return auth;

  const supabase = await createClient();
  // RLS: social_accounts UPDATE는 ADMIN/MANAGER 정책 (기존 0001 정책).
  const { error } = await supabase
    .from("social_accounts")
    .update({
      group_id: parsed.data.groupId,
    })
    .in("id", parsed.data.accountIds);

  if (error) return { ok: false, error: error.message };

  revalidatePath("/accounts");
  revalidatePath("/upload");
  return { ok: true };
}
