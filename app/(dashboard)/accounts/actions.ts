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
