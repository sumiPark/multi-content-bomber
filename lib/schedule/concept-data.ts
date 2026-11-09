import type { ConceptCardData } from "@/components/schedule/account-concept";
import { scriptStyleOf } from "@/lib/agents/script-style";
import { describeEditStyle, parseEditStyle } from "@/lib/shoot/edit-style";
import type { Tables } from "@/types/database";

// 영상 참고 내용 카드에 넘길 값 — 자동 콘텐츠 설정과 촬영 설정이 같이 쓴다. 카드는 자기 방식의 값만 보여 주고 저장한다.

export const CONCEPT_SELECT =
  "social_account_id, auto_role_focus, auto_script_style, auto_notes, auto_hooks, auto_endings, auto_voice_id, shoot_voice_id, shoot_role_focus, shoot_voice_mode, shoot_concept, shoot_hooks, shoot_endings, shoot_tone, shoot_edit_style, shoot_edit_params, updated_at";

export type ConceptRow = Pick<
  Tables<"account_concepts">,
  | "auto_role_focus"
  | "auto_script_style"
  | "auto_notes"
  | "auto_hooks"
  | "auto_endings"
  | "shoot_role_focus"
  | "shoot_voice_mode"
  | "shoot_concept"
  | "shoot_hooks"
  | "shoot_endings"
  | "shoot_tone"
  | "shoot_edit_style"
  | "shoot_edit_params"
  | "auto_voice_id"
  | "shoot_voice_id"
  | "updated_at"
>;

export function roleLabel(role: string | null | undefined): string | null {
  return role === "PERSON" ? "사람 중심" : role === "PRODUCT" ? "상품 중심" : null;
}

export function conceptCardData(input: { accountId: string; name: string; row: ConceptRow | null | undefined }): ConceptCardData {
  const c = input.row;
  const edit = parseEditStyle(c?.shoot_edit_params);
  return {
    accountId: input.accountId,
    name: input.name,
    autoRole: c?.auto_role_focus ?? "",
    autoScriptStyle: scriptStyleOf(c?.auto_script_style),
    autoNotes: c?.auto_notes ?? "",
    autoHooks: (c?.auto_hooks ?? []).join("\n"),
    autoEndings: (c?.auto_endings ?? []).join("\n"),
    autoVoiceId: c?.auto_voice_id ?? "",
    shootVoiceId: c?.shoot_voice_id ?? "",
    shootRole: c?.shoot_role_focus ?? "",
    shootVoice: c?.shoot_voice_mode ?? "AI",
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

/** 목록에 보여 줄 "저장한 내용" — 방식별로 자기 값만 센다. */
export function savedConceptItems(c: ConceptRow | null | undefined, mode: "auto" | "shoot"): string[] {
  if (!c) return [];
  const items =
    mode === "auto"
      ? [
          c.auto_script_style === "STORY" ? "이야기형" : null,
          c.auto_hooks?.length ? `후킹 문구 ${c.auto_hooks.length}개` : null,
          c.auto_endings?.length ? `마지막 문구 ${c.auto_endings.length}개` : null,
          c.auto_notes?.trim() ? "바꾸고 싶은 점" : null,
        ]
      : [
          c.shoot_hooks?.length ? `후킹 문구 ${c.shoot_hooks.length}개` : null,
          c.shoot_endings?.length ? `마지막 문구 ${c.shoot_endings.length}개` : null,
          c.shoot_tone?.trim() ? "말투" : null,
          c.shoot_edit_style?.trim() ? "편집 스타일" : null,
          c.shoot_concept?.trim() ? "메모" : null,
        ];
  return items.filter((x): x is string => !!x);
}
