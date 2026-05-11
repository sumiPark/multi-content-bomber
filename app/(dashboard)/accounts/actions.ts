"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const disconnectSchema = z.object({
  accountId: z.string().uuid(),
});

// React 19 form action prop requires Promise<void>. Errors are surfaced via
// redirect to /accounts?error=... where the page renders an inline banner.
export async function disconnectAccountAction(
  formData: FormData,
): Promise<void> {
  const parsed = disconnectSchema.safeParse({
    accountId: formData.get("accountId"),
  });
  if (!parsed.success) {
    redirect(`/accounts?error=${encodeURIComponent("잘못된 입력")}`);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // RLS: ADMIN/MANAGER만 social_accounts 삭제 가능 (0001 정책).
  const { error } = await supabase
    .from("social_accounts")
    .delete()
    .eq("id", parsed.data.accountId);

  if (error) {
    redirect(`/accounts?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/accounts");
  revalidatePath("/");
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
    return { ok: false, error: "그룹 관리 권한이 없습니다." };
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
  // group_id가 0009 마이그레이션 이후 추가됨 — 타입 재생성 전이라 cast.
  const { error } = await supabase
    .from("social_accounts")
    .update({
      // @ts-expect-error group_id는 0009 마이그레이션 이후 추가
      group_id: parsed.data.groupId,
    })
    .in("id", parsed.data.accountIds);

  if (error) return { ok: false, error: error.message };

  revalidatePath("/accounts");
  revalidatePath("/upload");
  return { ok: true };
}
