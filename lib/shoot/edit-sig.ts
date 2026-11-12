// 지난 편집 계획을 다시 쓸 수 있는지 가르는 서명 — 촬영본(편집 순서) + 하고 싶은 말.
// 편집 서버(worker/edit-shoots.ts)가 완성본과 함께 저장하고(edit.kit.clipsSig), 다음 편집 때 서명이 같아야만 지난 계획을 다시 쓴다.
// 서명이 다르면 완성본 고치기로 고친 계획도 쓰지 않고 처음부터 새로 편집한다 — 화면이 그 전에 안내하려고 같은 계산을 쓴다.

type SigClip = { cut: number; path: string };

const BRIEF_MARK = "brief:";

/** 편집 서버가 저장하는 서명. 형식을 바꾸면 이미 저장된 완성본이 모두 "처음부터 새로 편집"으로 넘어간다. */
export function editSig(clips: SigClip[], brief: string | null | undefined): string {
  const paths = clips
    .slice()
    .sort((a, b) => a.cut - b.cut)
    .map((c) => c.path);
  return [...paths, `${BRIEF_MARK}${brief?.trim() ?? ""}`].join("|");
}

function splitSig(sig: string): { clips: string; brief: string | null } {
  const at = sig.startsWith(BRIEF_MARK) ? 0 : sig.indexOf(`|${BRIEF_MARK}`);
  // 2026-11-10 전 서명에는 하고 싶은 말이 없다
  if (at < 0) return { clips: sig, brief: null };
  return { clips: sig.slice(0, at), brief: sig.slice(at === 0 ? BRIEF_MARK.length : at + 1 + BRIEF_MARK.length) };
}

/** 지난 편집에 쓴 하고 싶은 말. 서명이 없거나 예전 서명이면 null. */
export function lastEditBrief(lastSig: string | null | undefined): string | null {
  return lastSig ? splitSig(lastSig).brief : null;
}

/** 처음부터 새로 편집하게 되는 이유. old = 2026-11-10 전에 편집해 서명에 하고 싶은 말이 없는 완성본(항상 새로 편집한다). */
export type EditRestart = "brief" | "clips" | "both" | "old";

/**
 * 지금 다시 편집하면 지난 편집 계획을 못 쓰고 처음부터 새로 편집하는지. 그대로 쓸 수 있으면 null.
 * 지난 편집 계획이 있는 완성본에만 부른다(없으면 잃을 계획이 없다).
 */
export function editRestart(lastSig: string | null | undefined, clips: SigClip[], brief: string | null | undefined): EditRestart | null {
  const now = editSig(clips, brief);
  if (lastSig === now) return null;
  if (!lastSig) return "old";
  const last = splitSig(lastSig);
  if (last.brief === null) return "old";
  const current = splitSig(now);
  const clipsChanged = last.clips !== current.clips;
  const briefChanged = last.brief !== current.brief;
  return clipsChanged && briefChanged ? "both" : briefChanged ? "brief" : "clips";
}

/** 안내 문구의 앞 문장 — 왜 처음부터 새로 편집하는지. */
export const EDIT_RESTART_REASON: Record<EditRestart, string> = {
  brief: "지난 편집 뒤에 하고 싶은 말이 바뀌었어요.",
  clips: "지난 편집 뒤에 촬영본이 바뀌었어요.",
  both: "지난 편집 뒤에 촬영본과 하고 싶은 말이 바뀌었어요.",
  old: "11월 10일 전에 편집한 완성본이에요.",
};
