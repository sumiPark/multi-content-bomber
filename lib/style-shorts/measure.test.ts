import assert from "node:assert/strict";
import test from "node:test";
import type { EditPlan } from "@/lib/agents/edit-plan";
import { captionZones } from "@/lib/shoot/video-kit/compose";
import { planProblems, styleFinish, styleMusicSwitches } from "@/lib/shoot/video-kit/pipeline";
import type { Timeline } from "@/lib/shoot/video-kit/timeline";
import { captionStats, cardNumbers, musicChangeAt, speechPauses } from "./analyze";
import type { OverlayScan, ReferenceAnalysis } from "./card";
import { sfxBoostDb } from "./sfx";

// 레퍼런스 카드에 더한 측정(2026-11-20): 말 사이 빈틈 · 말 자막 · 효과음 최소값

test("말 사이 빈틈: 0.6초 넘는 빈틈 수 · 가장 긴 빈틈 · 빈틈 비율", () => {
  const words = [
    { start: 0, end: 0.5 },
    { start: 0.6, end: 1.0 }, // 0.1
    { start: 2.0, end: 2.5 }, // 1.0 — 셈
    { start: 2.8, end: 3.2 }, // 0.3 — 비율에만
    { start: 3.3, end: 10.0 }, // 0.1
  ];
  const p = speechPauses(words)!;
  assert.equal(p.maxSec, 1);
  assert.equal(p.per10s, 1); // 10초에 1개
  assert.equal(p.silentShare, 0.13); // (1.0 + 0.3) / 10
  assert.equal(speechPauses([{ start: 0, end: 0.5 }]), null);
});

const frame = (t: number, caption: OverlayScan["frames"][number]["caption"]): OverlayScan["frames"][number] => ({ t, overlays: [], caption, zoomed: false });

test("말 자막: 이어진 같은 자막은 한 번, 10초당 수는 말한 글자 수로 어림", () => {
  const scan: OverlayScan = {
    frames: [
      frame(0.5, { text: "오메 8개?", lines: 1, color: "#ffd93d", place: "lower", big: false }),
      frame(1.5, { text: "오메 8개?", lines: 1, color: "#ffd93d", place: "lower", big: false }),
      frame(2.5, { text: "진짜 크다", lines: 1, color: "#FFFFFF", place: "mid", big: true }),
      frame(3.5, null),
      frame(4.5, { text: "수산시장 사장님이랑 다 알아요", lines: 2, color: "#FFD93D", place: "lower", big: false }),
    ],
  };
  const c = captionStats(scan, 10, 40)!;
  assert.equal(c.seen, 3);
  assert.equal(c.avgChars, 7.3); // (5 + 4 + 13) / 3
  assert.equal(c.oneLineShare, 0.67);
  assert.deepEqual(c.places, { lower: 2, mid: 1 });
  assert.equal(c.colors[0], "#FFD93D");
  assert.equal(c.bigShare, 0.33);
  assert.equal(c.per10s, 5.5); // 40자 ÷ 7.33자 ≈ 5.45개 / 10초
  // 말이 없으면 본 자막 수로
  assert.equal(captionStats(scan, 10, null)!.per10s, 3);
  assert.equal(captionStats({ frames: [frame(0.5, null)] }, 10, 40), null);
});

const ref = (extra: Partial<ReferenceAnalysis>): { analysis: ReferenceAnalysis; video: boolean } => ({
  video: true,
  analysis: {
    durationSec: 50,
    cuts: [],
    avgShotSec: 2,
    cutsPer10s: 5,
    first3sCuts: 1,
    speech: { has: true, transcript: "", charsPerSec: 7 },
    sound: null,
    soundNote: null,
    read: { captionStyle: "sentence" } as ReferenceAnalysis["read"],
    caption: null,
    ...extra,
  },
});

test("카드 숫자: 새 측정은 측정한 레퍼런스만으로, 예전 레퍼런스는 빼고 낸다", () => {
  const sound = { sections: [], events: [], sfxPer10s: 1.5, kinds: {}, tempo: null, steadyBeat: false, loudnessLufs: -8.3, cutsWithSound: 0.9, hasMusic: true, hasVoice: true };
  const n = cardNumbers([
    ref({ sound: { ...sound, sfxCapped: true, sfxOverBedDb: 15.8, truePeakDb: 0.7, endDrop: true }, speech: { has: true, transcript: "", charsPerSec: 7.4, chars: 386, pauses: { per10s: 0.2, maxSec: 0.6, silentShare: 0.06 } } }),
    ref({ sound: { ...sound, sfxCapped: false, sfxOverBedDb: 13, truePeakDb: -1, endDrop: false } }),
    // 예전 분석(새 칸 없음)
    ref({ sound }),
  ]);
  assert.equal(n.sfxIsMin, true);
  assert.equal(n.sfxOverBedDb, 14.4);
  assert.equal(n.endDropShare, 0.5);
  assert.equal(n.maxPauseSec, 0.6);
  assert.equal(n.silentShare, 0.06);
  assert.equal(n.captionPer10s, undefined);
  // 예전 레퍼런스만 있으면 새 칸이 없다
  assert.equal(cardNumbers([ref({ sound })]).sfxIsMin, undefined);
});

test("효과음 최소값 레퍼런스: 개수 상한 없이, 적으면 더 넣게", () => {
  const beats = Array.from({ length: 10 }, (_, i) => ({
    mode: "live" as const,
    tts: "",
    cuts: [{ clip: 1, in: i * 3, out: i * 3 + 3, what: "" }],
    captions: [],
    emphasis: [],
    graphics: [],
    big: false,
    sfx: Array.from({ length: 3 }, () => ({ name: "swish/soft", at: 0, at_word: "" })),
  }));
  const plan = { beats, hook: { on_screen: "후킹", highlight: "", spoken: "" }, caption_style: "sentence" } as unknown as EditPlan;
  const style = { sfxPer10s: 1.5, avgShotSec: 3, durationSec: null, footageSeconds: 60, revise: false };
  // 30초에 효과음 30개: 최소값이 아니면 상한에 걸린다
  assert.ok(planProblems(plan, undefined, style).some((p) => p.startsWith("효과음이 30개")));
  assert.ok(!planProblems(plan, undefined, { ...style, sfxIsMin: true }).some((p) => p.startsWith("효과음")));
  // 최소값 레퍼런스인데 효과음이 없으면 더 넣으라고 한다
  const none = { ...plan, beats: beats.map((b) => ({ ...b, sfx: [] })) } as EditPlan;
  assert.ok(planProblems(none, undefined, { ...style, sfxIsMin: true }).some((p) => p.includes("5개 이상")));
});

// 렌더를 레퍼런스에 맞추기(2026-11-20 사용자 결정): 자막 자리 · 효과음 크기 · 끝 음악 끊기 · 음량

test("자막 자리: 레퍼런스 자리를 먼저 쓰고, 사람 · 상품이 절반 넘게 가리면 평소처럼 피한다", () => {
  const tl = {
    duration: 10,
    lines: [],
    cuts: [],
    graphics: [],
    sfx: [],
    hook: { start: 0, end: 1, onScreen: "", highlight: "", position: "top" },
    captions: [
      { id: "a", text: "가", emphasis: [], start: 2, end: 3, beat: 0 },
      { id: "b", text: "나", emphasis: [], start: 5, end: 6, beat: 1 },
    ],
  } as unknown as Timeline;
  // 2~4초는 아래를 몸이 30% 가림, 4~10초는 아래를 80% 가림
  const zones = [
    { start: 0, end: 4, cover: { top: 0, mid: 0.1, lower: 0.3 } },
    { start: 4, end: 10, cover: { top: 0, mid: 0.2, lower: 0.8 } },
  ];
  // 지금(레퍼런스 자리 없음): 18% 넘게 가리면 피해 위 · 가운데로
  assert.deepEqual(captionZones(tl, zones), ["mid", "top"]);
  // 레퍼런스 아래: 30%는 아래에 두고, 80%는 피한다
  assert.deepEqual(captionZones({ ...tl, captionPrefer: "lower" }, zones), ["lower", "top"]);
});

test("효과음 크기: 레퍼런스가 더 크게 쓰면 그만큼(최대 6dB) 올린다", () => {
  assert.equal(sfxBoostDb(15.8), 2.8);
  assert.equal(sfxBoostDb(12), 0);
  assert.equal(sfxBoostDb(30), 6);
  assert.equal(sfxBoostDb(null), 0);
});

test("믹스 마무리: 레퍼런스 대부분이 끝에 음악을 끊으면 마지막 말 직전에, 음량은 -14~-11 LUFS", () => {
  const tl = { duration: 40, lines: [{ start: 0 }, { start: 36.5 }] } as unknown as Timeline;
  assert.deepEqual(styleFinish({ endDropShare: 0.67, loudnessLufs: -8.3 }, tl), { musicDropAt: 36.5, targetLufs: -11 });
  assert.deepEqual(styleFinish({ endDropShare: 0.33, loudnessLufs: -16 }, tl), { musicDropAt: null, targetLufs: -14 });
  // 예전 카드: 아무것도 바꾸지 않는다
  assert.deepEqual(styleFinish({}, tl), { musicDropAt: null, targetLufs: null });
});

// 배경음악 바꾸기(2026-11-20 사용자 결정, (가) 측정 방식)

test("곡 바뀜 위치: 처음 · 끝 10% 안(음악이 들어오고 나간 곳)은 뺀다", () => {
  // 사람 편집 추황배 실측: 3.7(음악 시작) · 18.3 · 34.2 · 47.0(음악 끝), 길이 50.7초
  assert.deepEqual(musicChangeAt([3.7, 18.3, 34.2, 47.0], 50.7), [0.36, 0.67]);
  assert.deepEqual(musicChangeAt([], 40), []);
});

test("카드: 곡을 바꾼 레퍼런스 비율과 첫 · 두 번째 바뀜 위치의 중앙값", () => {
  const withMusic = (dur: number, changes: number[] | null | undefined) =>
    ref({ durationSec: dur, sound: { sections: [], events: [], sfxPer10s: 1, kinds: {}, tempo: null, steadyBeat: false, loudnessLufs: -10, cutsWithSound: 1, hasMusic: true, hasVoice: true, musicChanges: changes } });
  // 사람 편집 6개 실측: 해물모듬 · 사과 · 추황배는 두 번, 나머지는 한 곡
  const n = cardNumbers([withMusic(52.8, [14.3, 44.8]), withMusic(46.1, [17.2, 35.8]), withMusic(50.7, [3.7, 18.3, 34.2, 47.0]), withMusic(44, []), withMusic(46.3, []), withMusic(55.8, [])]);
  assert.equal(n.musicChangeShare, 0.5);
  assert.deepEqual(n.musicChangeAt, [0.36, 0.78]);
  // 재지 못한 레퍼런스뿐이면 칸이 없다
  assert.equal(cardNumbers([withMusic(40, null)]).musicChangeShare, undefined);
});

test("곡 바꿈 시각: 레퍼런스 절반 이상이 바꾸면 그 위치에서 가장 가까운 컷 시작에", () => {
  const tl = { duration: 40, cuts: [0, 4, 9, 13.5, 16, 22, 27, 30.5, 35].map((start) => ({ start })) } as unknown as Timeline;
  assert.deepEqual(styleMusicSwitches({ musicChangeShare: 0.5, musicChangeAt: [0.36, 0.78] }, tl), [13.5, 30.5]);
  assert.deepEqual(styleMusicSwitches({ musicChangeShare: 0.33, musicChangeAt: [0.36] }, tl), []);
  assert.deepEqual(styleMusicSwitches({}, tl), []);
  // 끝 3초 안의 컷에는 두지 않는다
  assert.deepEqual(styleMusicSwitches({ musicChangeShare: 1, musicChangeAt: [0.99] }, tl), [35]);
});
