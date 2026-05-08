"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type OnboardingFormState = { error: string } | undefined;

export async function createOrganization(
  _prev: OnboardingFormState,
  formData: FormData,
): Promise<OnboardingFormState> {
  const name = String(formData.get("name") ?? "").trim();
  if (name.length < 2) {
    return { error: "워크스페이스 이름은 2글자 이상이어야 합니다." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("create_organization", { p_name: name });
  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  redirect("/");
}

export async function acceptInvitation(
  _prev: OnboardingFormState,
  formData: FormData,
): Promise<OnboardingFormState> {
  const token = String(formData.get("token") ?? "").trim();
  if (!token) return { error: "초대 토큰을 입력해주세요." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("accept_invitation", { p_token: token });
  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  redirect("/");
}
