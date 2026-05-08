"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const disconnectSchema = z.object({
  accountId: z.string().uuid(),
});

export type DisconnectResult =
  | { ok: true }
  | { ok: false; error: string };

export async function disconnectAccountAction(
  formData: FormData,
): Promise<DisconnectResult> {
  const parsed = disconnectSchema.safeParse({
    accountId: formData.get("accountId"),
  });
  if (!parsed.success) {
    return { ok: false, error: "잘못된 입력" };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "로그인 필요" };

  // RLS: ADMIN/MANAGER만 social_accounts 삭제 가능 (0001 정책).
  const { error } = await supabase
    .from("social_accounts")
    .delete()
    .eq("id", parsed.data.accountId);

  if (error) return { ok: false, error: error.message };

  revalidatePath("/accounts");
  revalidatePath("/");
  return { ok: true };
}
