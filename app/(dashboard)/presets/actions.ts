"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const presetInputSchema = z.object({
  name: z.string().min(1, "이름을 입력해주세요.").max(50, "이름은 50자 이내"),
  description: z.string().max(200).optional().nullable(),
  instructions: z
    .string()
    .min(10, "지시문은 10자 이상 작성해주세요.")
    .max(2000, "지시문은 2000자 이내"),
});

const updateInputSchema = presetInputSchema.extend({
  id: z.string().uuid(),
});

const idSchema = z.object({ id: z.string().uuid() });

export type PresetActionResult =
  | { ok: true }
  | { ok: false; error: string };

async function authorize() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "로그인이 필요합니다." } as const;

  const { data: profile } = await supabase
    .from("profiles")
    .select("organization_id")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile?.organization_id) {
    return { error: "소속된 조직이 없습니다." } as const;
  }

  return { supabase, userId: user.id, organizationId: profile.organization_id };
}

export async function createPresetAction(
  input: z.infer<typeof presetInputSchema>,
): Promise<PresetActionResult> {
  const parsed = presetInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "잘못된 입력" };
  }

  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };

  const { error } = await auth.supabase.from("caption_presets").insert({
    organization_id: auth.organizationId,
    created_by: auth.userId,
    name: parsed.data.name.trim(),
    description: parsed.data.description?.trim() || null,
    instructions: parsed.data.instructions.trim(),
  });

  if (error) return { ok: false, error: error.message };

  revalidatePath("/presets");
  revalidatePath("/");
  return { ok: true };
}

export async function updatePresetAction(
  input: z.infer<typeof updateInputSchema>,
): Promise<PresetActionResult> {
  const parsed = updateInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "잘못된 입력" };
  }

  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };

  const { error } = await auth.supabase
    .from("caption_presets")
    .update({
      name: parsed.data.name.trim(),
      description: parsed.data.description?.trim() || null,
      instructions: parsed.data.instructions.trim(),
    })
    .eq("id", parsed.data.id);

  if (error) return { ok: false, error: error.message };

  revalidatePath("/presets");
  revalidatePath("/");
  return { ok: true };
}

export async function deletePresetAction(
  input: z.infer<typeof idSchema>,
): Promise<PresetActionResult> {
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "잘못된 ID" };
  }

  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };

  const { error } = await auth.supabase
    .from("caption_presets")
    .delete()
    .eq("id", parsed.data.id);

  if (error) return { ok: false, error: error.message };

  revalidatePath("/presets");
  revalidatePath("/");
  return { ok: true };
}
