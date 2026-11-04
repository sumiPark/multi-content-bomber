import type { ConceptCardData } from "@/components/schedule/account-concept";
import { describeEditStyle, parseEditStyle } from "@/lib/shoot/edit-style";
import type { Tables } from "@/types/database";

// 계정 컨셉 카드에 넘길 값 — 자동 업로드 일정(AI 자동)과 촬영 설정(직접 촬영)이 같이 쓴다. 저장은 한 행에 함께 한다.

type ConceptRow = Pick<
  Tables<"account_concepts">,
  | "auto_concept"
  | "auto_hooks"
  | "auto_endings"
  | "auto_tone"
  | "auto_video_style"
  | "shoot_concept"
  | "shoot_hooks"
  | "shoot_endings"
  | "shoot_tone"
  | "shoot_edit_style"
  | "shoot_edit_params"
  | "updated_at"
>;

export function conceptCardData(input: { accountId: string; name: string; role: string | null; autoSlots: number; row: ConceptRow | undefined }): ConceptCardData {
  const c = input.row;
  const edit = parseEditStyle(c?.shoot_edit_params);
  return {
    accountId: input.accountId,
    name: input.name,
    role: input.role,
    autoSlots: input.autoSlots,
    autoConcept: c?.auto_concept ?? "",
    autoHooks: (c?.auto_hooks ?? []).join("\n"),
    autoEndings: (c?.auto_endings ?? []).join("\n"),
    autoTone: c?.auto_tone ?? "",
    autoVideoStyle: c?.auto_video_style ?? "",
    shootConcept: c?.shoot_concept ?? "",
    shootHooks: (c?.shoot_hooks ?? []).join("\n"),
    shootEndings: (c?.shoot_endings ?? []).join("\n"),
    shootTone: c?.shoot_tone ?? "",
    shootEditStyle: c?.shoot_edit_style ?? "",
    editApplied: describeEditStyle(edit.style),
    editUnsupported: edit.unsupported,
    updatedAt: c?.updated_at ?? null,
  };
}
