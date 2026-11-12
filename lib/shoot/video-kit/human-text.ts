import type { EditPlan } from "@/lib/agents/edit-plan";

// 사람이 정한 글(후킹 · 표지 · 끝 문구 · 예전 방식의 컷별 문구)을 편집 계획 위에 덮어쓴다.
// 편집 워커(pipeline)와 완성본 고치기의 미리 보기(lib/agents/edit-revise.ts, 앱)가 같은 함수를 써야
// 미리 본 내용과 실제 편집이 같다. 그래서 FFmpeg · 파일을 쓰는 pipeline에서 떼어 이 파일에 둔다.

export interface HumanTextInput {
  humanHook?: string | null;
  humanThumbnail?: string | null;
  fixedHook?: string | null;
  fixedEnding?: string | null;
  // 예전 방식(완성본 받기의 칸별 입력)으로 저장된 컷별 문구. 새로 저장하지 않지만 남아 있는 값은 반영한다
  overrides?: { no: number; onScreen?: string | null; subtitle?: string | null }[];
}

/** 사람이 넣은 문구는 AI 답과 상관없이 글자 그대로 쓴다. */
export function applyHumanText(plan: EditPlan, input: HumanTextInput): EditPlan {
  const out: EditPlan = JSON.parse(JSON.stringify(plan));
  const hook = input.humanHook?.trim() || input.fixedHook?.trim();
  if (hook) {
    out.hook.on_screen = hook;
    out.hook.spoken = hook;
    out.hook.highlight = hook.includes(out.hook.highlight) ? out.hook.highlight : "";
    const first = out.beats[0];
    if (first) {
      first.mode = "tts";
      first.tts = hook;
      first.captions = [];
    }
  }
  const thumb = input.humanThumbnail?.trim();
  if (thumb) {
    out.thumbnail.title = thumb;
    out.thumbnail.highlight = thumb.includes(out.thumbnail.highlight) ? out.thumbnail.highlight : "";
  }
  const ending = input.fixedEnding?.trim();
  const last = out.beats[out.beats.length - 1];
  if (ending && last && out.beats.length > 1 && last.mode === "tts") {
    last.tts = ending;
    last.captions = [ending];
  }
  for (const o of input.overrides ?? []) {
    const beatIndex = out.beats.findIndex((b) => b.cuts.some((c) => c.clip === o.no));
    if (beatIndex < 0) continue;
    const beat = out.beats[beatIndex];
    if (o.subtitle != null) beat.captions = o.subtitle.trim() ? [o.subtitle.trim()] : [];
    if (o.onScreen != null) {
      if (beatIndex === 0 && !hook) out.hook.on_screen = o.onScreen.trim();
      else {
        const g = beat.graphics.find((x) => ["badge", "title", "chip", "notice", "stat", "end_card"].includes(x.type));
        if (g) g.text = o.onScreen.trim();
      }
    }
  }
  return out;
}
