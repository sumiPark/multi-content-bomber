import assert from "node:assert/strict";
import test from "node:test";
import type { EditPlan } from "@/lib/agents/edit-plan";
import { partSubtitles } from "./edit-parts";
import { planProblems, sanitizePlan, styleRhythmProblems, type KitClip } from "./pipeline";
import { layoutBeats, timeText, type VoiceClip } from "./timeline";

// 스타일 쇼츠를 레퍼런스와 비슷하게(2026-11-19): 컷 속도 · 화면 위 글자 · 확대 빈도 점검과 반응 글자 · 확대 시각

const beat = (tts: string, cuts: { clip: number; in: number; out: number }[]): EditPlan["beats"][number] => ({
  mode: "tts",
  tts,
  captions: [tts],
  big: false,
  emphasis: [],
  cuts: cuts.map((c) => ({ ...c, what: "" })),
  graphics: [],
  sfx: [],
});

function plan(beats: EditPlan["beats"], extra: Partial<EditPlan> = {}): EditPlan {
  return {
    look: {} as EditPlan["look"],
    caption_style: "sentence",
    analysis: [],
    hook: { on_screen: "첫 글자", highlight: "", position: "top", spoken: beats[0]?.tts ?? "" },
    thumbnail: { title: "표지", highlight: "", position: "top", sub: "", clip: 1, at: 0 },
    beats,
    visuals: [],
    warnings: [],
    ...extra,
  };
}

test("컷이 레퍼런스 평균의 1.5배보다 느리면 나누라고 한다", () => {
  const p = plan([beat("가", [{ clip: 1, in: 0, out: 5 }])]);
  const slow = styleRhythmProblems(p, 4, 20, { sfxPer10s: null, avgShotSec: 2 });
  assert.equal(slow.length, 1);
  assert.match(slow[0], /평균 5\.0초라 레퍼런스\(평균 2초\)보다 느려요\. 컷을 10개 안팎/);
  // 1.5배 안이면 통과
  assert.deepEqual(styleRhythmProblems(p, 7, 20, { sfxPer10s: null, avgShotSec: 2 }), []);
});

test("말소리 영상은 구절마다 비트를 나누라고 한다", () => {
  const p = plan([{ ...beat("", [{ clip: 1, in: 0, out: 10 }]), mode: "live" }]);
  const [msg] = styleRhythmProblems(p, 2, 20, { sfxPer10s: null, avgShotSec: 2 });
  assert.match(msg, /구절마다 다른 비트/);
});

test("화면 위 글자 · 그래픽이 레퍼런스의 절반보다 적으면 더 넣으라고 하고, 확대가 없으면 넣으라고 한다", () => {
  const p = plan([beat("가", [{ clip: 1, in: 0, out: 1 }])], {
    reactions: [{ beat: 0, at_word: "", at: 0.5, kind: "reaction", text: "헉!", place: "mid", fx: "popIn", look: "", color: "#FFFFFF" }],
  });
  const out = styleRhythmProblems(p, 20, 40, { sfxPer10s: null, avgShotSec: null, overlayPer10s: 2, zoomPer10s: 0.5 });
  assert.equal(out.length, 2);
  assert.match(out[0], /1개예요\. 레퍼런스는 10초당 2개라 8개 안팎/);
  assert.match(out[1], /화면 확대가 없어요/);
  // 측정값이 없는 예전 카드는 재지 않는다
  assert.deepEqual(styleRhythmProblems(p, 20, 40, { sfxPer10s: null, avgShotSec: null }), []);
});

test("주석 수정은 컷 속도 · 글자 빈도로 다시 쓰게 하지 않는다", () => {
  const p = plan([beat("가나다라마바사아자차카타파하".repeat(4), [1, 2, 3, 4, 5, 6].map((i) => ({ clip: i, in: 0, out: 9 })))]);
  // 대본 약 9초 · 컷 6개(평균 1.5초) — 레퍼런스 0.5초의 1.5배를 넘는다
  const style = { sfxPer10s: null, avgShotSec: 0.5, overlayPer10s: 3 };
  assert.ok(planProblems(p, undefined, style).some((x) => x.includes("느려요")));
  assert.ok(!planProblems(p, undefined, { ...style, revise: true }).some((x) => x.includes("느려요") || x.includes("화면 위 글자")));
});

test("비트가 빠지면 반응 글자 · 확대의 비트 번호도 당긴다", () => {
  const clips = [{ no: 1, duration: 10 }] as KitClip[];
  const p = plan([beat("가", [{ clip: 1, in: 0, out: 1 }]), beat("", [{ clip: 1, in: 1, out: 2 }]), beat("다", [{ clip: 1, in: 2, out: 3 }])], {
    reactions: [
      { beat: 1, at_word: "", at: 0, kind: "reaction", text: "빠질 글자", place: "mid", fx: "popIn", look: "", color: "" },
      { beat: 2, at_word: "", at: 0, kind: "inner_voice", text: "(남는 글자)", place: "top", fx: "creep", look: "", color: "" },
    ],
    zooms: [{ beat: 2, at_word: "", at: 0.5 }],
  });
  const fixed = sanitizePlan(p, clips, false);
  assert.equal(fixed.beats.length, 2);
  assert.deepEqual(fixed.reactions?.map((r) => [r.beat, r.text]), [[1, "(남는 글자)"]]);
  assert.deepEqual(fixed.zooms?.map((z) => z.beat), [1]);
});

test("반응 글자 · 확대 시각을 비트 안 위치로 정하고, 확대는 그 컷 끝까지 둔다", () => {
  const p = plan([beat("첫 말", [{ clip: 1, in: 0, out: 2 }]), beat("둘째 말", [{ clip: 1, in: 2, out: 3 }, { clip: 1, in: 5, out: 6 }])], {
    reactions: [{ beat: 1, at_word: "", at: 0.5, kind: "reaction", text: "헉!", place: "mid", fx: "popIn", look: "", color: "#FFE600" }],
    zooms: [{ beat: 1, at_word: "", at: 0.1 }],
  });
  const voices: VoiceClip[] = [{ file: null, fileIn: 0, fileOut: 0, estimated: 2 }, { file: null, fileIn: 0, fileOut: 0, estimated: 2 }];
  const base = layoutBeats(p, voices, new Map([[1, 10]]));
  const tl = timeText(p, base, [], new Map());
  const line = tl.lines[1];
  assert.equal(tl.reactions?.length, 1);
  assert.ok(Math.abs(tl.reactions![0].start - (line.start + 1)) < 0.01);
  assert.ok(tl.reactions![0].end > tl.reactions![0].start + 0.8);
  const zoomCut = base.cuts.find((c) => c.start <= tl.zooms![0].start && tl.zooms![0].start < c.end)!;
  assert.equal(tl.zooms![0].end, zoomCut.end);
  // 편집용 파일 묶음의 글자 자막에도 반응 글자가 들어간다
  assert.match(partSubtitles(tl).titles, /헉!/);
});

test("반응 글자 · 확대가 없는 계획(직접 촬영 · AI 자동)은 시각표에 칸을 만들지 않는다", () => {
  const p = plan([beat("첫 말", [{ clip: 1, in: 0, out: 2 }])]);
  const base = layoutBeats(p, [{ file: null, fileIn: 0, fileOut: 0, estimated: 2 }], new Map([[1, 10]]));
  const tl = timeText(p, base, [], new Map());
  assert.equal("reactions" in tl, false);
  assert.equal("zooms" in tl, false);
});
