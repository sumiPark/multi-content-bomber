import assert from "node:assert/strict";
import test from "node:test";
import { transcriptForPlan, type EditPlan } from "@/lib/agents/edit-plan";
import { captionZones } from "@/lib/shoot/video-kit/compose";
import { liveCaptionLines, liveLineWords, planProblems, styleFinish, styleLiveGap, styleLiveSpeed, styleMusicSwitches } from "@/lib/shoot/video-kit/pipeline";
import { layoutBeats, layoutExtraSeconds, type Timeline } from "@/lib/shoot/video-kit/timeline";
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

// 사람 편집본과 비교해 고친 세 가지(2026-11-20 사용자 결정): 자막은 얼굴만 피하기 · 낱말 시각으로 자르기 · 길이 점검에 틈 포함

test("자막 자리: 얼굴 자리를 쟀으면 몸이 가려도 레퍼런스 자리에 두고, 얼굴이 있을 때만 피한다", () => {
  const tl = {
    duration: 10,
    lines: [],
    cuts: [],
    graphics: [],
    sfx: [],
    hook: { start: 0, end: 1, onScreen: "", highlight: "", position: "top" },
    captionPrefer: "lower",
    captions: [
      { id: "a", text: "가", emphasis: [], start: 2, end: 3, beat: 0 },
      { id: "b", text: "나", emphasis: [], start: 5, end: 6, beat: 1 },
      { id: "c", text: "다", emphasis: [], start: 8, end: 9, beat: 2 },
    ],
  } as unknown as Timeline;
  const zones = [
    // 몸이 아래를 90% 가리지만 얼굴은 위에 있다 → 아래 그대로
    { start: 0, end: 4, cover: { top: 0.5, mid: 0.8, lower: 0.9 }, face: { top: 1, mid: 0, lower: 0 } },
    // 얼굴이 아래에 걸쳤다 → 얼굴이 없는 자리 중 덜 가린 곳으로
    { start: 4, end: 7, cover: { top: 0.1, mid: 0.6, lower: 0.7 }, face: { top: 0, mid: 0.6, lower: 0.5 } },
    // 얼굴을 못 잰 컷은 예전 기준(절반 넘게 가리면 피한다)
    { start: 7, end: 10, cover: { top: 0, mid: 0.2, lower: 0.8 } },
  ];
  assert.deepEqual(captionZones(tl, zones), ["lower", "top", "top"]);
});

test("말소리 자막: 문장 중간에서 자른 컷에는 그 컷에 들어온 낱말만 쓴다", () => {
  const segments = [{ text: "어 오늘은 해물모듬을 소개할게요.", start: 1, end: 5 }];
  const words = [
    { text: "어", start: 1, end: 1.3 },
    { text: "오늘은", start: 2, end: 2.5 },
    { text: "해물모듬을", start: 2.6, end: 3.4 },
    { text: "소개할게요", start: 3.5, end: 4.6 },
  ];
  // 군말 "어"를 빼고 2초부터 쓴 컷
  const [part] = liveCaptionLines(segments, words, 1.95, 4.7, 10);
  assert.equal(part.text, "오늘은 해물모듬을 소개할게요");
  assert.ok(Math.abs(part.start - 10.05) < 1e-6 && Math.abs(part.end - 12.65) < 1e-6);
  // 문장이 다 들어오면 받아쓰기 문장 그대로(문장부호 유지)
  assert.equal(liveCaptionLines(segments, words, 0.9, 5, 0)[0].text, "어 오늘은 해물모듬을 소개할게요.");
  // 낱말이 하나도 안 들어온 컷(문장 끝의 쉼만 걸침)은 자막이 없다
  assert.deepEqual(liveCaptionLines(segments, words, 4.7, 5, 0), []);
  // 낱말 시각이 없으면 예전처럼 겹친 문장 전체
  assert.equal(liveCaptionLines(segments, [], 2, 4, 0)[0].text, "어 오늘은 해물모듬을 소개할게요.");
});

test("계획 AI에 넘기는 받아쓰기: 문장마다 낱말별 시각을 붙인다", () => {
  const out = transcriptForPlan({ transcript: [{ text: "가 나.", start: 0, end: 2 }, { text: "다.", start: 3, end: 4 }], transcriptWords: [{ text: "가", start: 0.1, end: 0.5 }, { text: "나", start: 0.7, end: 1.234 }] });
  assert.deepEqual(out, [{ text: "가 나.", start: 0, end: 2, words: [["가", 0.1, 0.5], ["나", 0.7, 1.23]] }, { text: "다.", start: 3, end: 4 }]);
});

test("말소리 스타일 쇼츠: 점프 컷 사이에 틈이 없고, 다른 경로는 0.14초 틈 그대로", () => {
  const live = (i: number): EditPlan["beats"][number] => ({ mode: "live", tts: "", captions: [], big: false, emphasis: [], cuts: [{ clip: 1, in: i * 3, out: i * 3 + 2, what: "" }], graphics: [], sfx: [] });
  const plan = { beats: [live(0), live(1), live(2)] } as unknown as EditPlan;
  const voices = plan.beats.map((b) => ({ file: "a.mov", fileIn: b.cuts[0].in, fileOut: b.cuts[0].out }));
  const seconds = new Map([[1, 20]]);
  const before = layoutBeats(plan, voices, seconds);
  assert.deepEqual(before.lines.map((l) => l.start), [0.05, 2.19, 4.33]);
  const tight = layoutBeats(plan, voices, seconds, undefined, { liveGap: styleLiveGap({ voiceMode: "LIVE" }) });
  assert.deepEqual(tight.lines.map((l) => l.start), [0.05, 2.05, 4.05]);
  assert.ok(Math.abs(tight.duration - 6.25) < 0.02);
  // AI 음성 스타일 쇼츠는 틈을 그대로 둔다
  assert.equal(styleLiveGap({ voiceMode: "AI" }), undefined);
  // 길이 점검이 쓰는 값과 시각표가 맞는다
  assert.ok(Math.abs(layoutExtraSeconds(plan, 0) - 0.25) < 1e-9);
  assert.ok(Math.abs(layoutExtraSeconds(plan) - 0.53) < 1e-9);
});

test("길이 점검: 말소리 영상은 고른 구간 + 시각표 여유로 재고 5%만 넘어간다", () => {
  const live = (len: number, i: number): EditPlan["beats"][number] => ({ mode: "live", tts: "", captions: [], big: false, emphasis: [], cuts: [{ clip: i + 1, in: 0, out: len, what: "" }], graphics: [], sfx: [] });
  const of = (len: number) => ({ hook: { on_screen: "첫 글자" }, caption_style: "sentence", beats: Array.from({ length: 20 }, (_, i) => live(len, i)) }) as unknown as EditPlan;
  const style = { sfxPer10s: null, avgShotSec: null, durationSec: [44, 55.8] as [number, number], footageSeconds: 500, liveGap: 0 };
  const long = (p: EditPlan, s = style) => planProblems(p, undefined, s).filter((x) => x.includes("길어요"));
  // 20컷 × 3.2초 = 64초: 예전(15% 여유)에는 통과했다
  assert.match(long(of(3.2))[0], /영상이 64\.3초라 레퍼런스\(44~55\.8초\)보다 길어요.*낱말 시각/);
  // 20컷 × 2.9초 = 58.25초: 5% 안
  assert.deepEqual(long(of(2.9)), []);
  // 틈이 있는 경로(liveGap 없음)는 틈 2.66초까지 더해 잰다
  assert.match(long(of(2.9), { ...style, liveGap: undefined as never })[0], /60\.9초\(장면 사이 틈 · 끝 여유 2\.9초 포함\)라 레퍼런스/);
});

test("말소리 스타일 쇼츠: 원본(화면 + 말)을 1.3배속으로 돌리고 자막 시각 · 길이 점검도 같은 배수로 잰다", () => {
  const live = (i: number): EditPlan["beats"][number] => ({ mode: "live", tts: "", captions: [], big: false, emphasis: [], cuts: [{ clip: 1, in: i * 5, out: i * 5 + 2.6, what: "" }], graphics: [], sfx: [] });
  const plan = { beats: [live(0), live(1)] } as unknown as EditPlan;
  const voices = plan.beats.map((b) => ({ file: "a.mov", fileIn: b.cuts[0].in, fileOut: b.cuts[0].out }));
  const speed = styleLiveSpeed({ voiceMode: "LIVE" });
  assert.equal(speed, 1.3);
  assert.equal(styleLiveSpeed({ voiceMode: "AI" }), undefined);
  const tl = layoutBeats(plan, voices, new Map([[1, 20]]), undefined, { liveGap: 0, liveSpeed: speed });
  // 2.6초짜리 말이 2초가 된다
  assert.deepEqual(tl.lines.map((l) => [l.start, l.end, l.speed]), [[0.05, 2.05, 1.3], [2.05, 4.05, 1.3]]);
  // 화면도 같은 배수: 컷 길이 × 1.3만큼의 원본을 쓴다
  for (const c of tl.cuts) {
    assert.equal(c.rate, 1.3);
    assert.ok(Math.abs((c.out - c.in) / c.duration - 1.3) < 0.01);
  }
  // 넘기지 않으면 원래 빠르기
  assert.equal(layoutBeats(plan, voices, new Map([[1, 20]])).cuts[0].rate, 1);
  // 자막: 원본에서 1.3초 뒤에 시작한 말은 완성본에서 1초 뒤
  const [cap] = liveCaptionLines([{ text: "가 나", start: 1.3, end: 2.6 }], [], 0, 2.6, 10, 1.3);
  assert.ok(Math.abs(cap.start - 11) < 1e-6 && Math.abs(cap.end - 12) < 1e-6);
  // 길이 점검: 20컷 × 3.6초 = 72초 원본 → 55.4초 영상이라 통과, 배속이 없으면 길다
  const of = { hook: { on_screen: "첫 글자" }, caption_style: "sentence", beats: Array.from({ length: 20 }, (_, i) => ({ ...live(0), cuts: [{ clip: i + 1, in: 0, out: 3.6, what: "" }] })) } as unknown as EditPlan;
  const style = { sfxPer10s: null, avgShotSec: null, durationSec: [44, 55.8] as [number, number], footageSeconds: 500, liveGap: 0 };
  assert.deepEqual(planProblems(of, undefined, { ...style, liveSpeed: 1.3 }).filter((x) => x.includes("길어요")), []);
  assert.equal(planProblems(of, undefined, style).filter((x) => x.includes("길어요")).length, 1);
});

test("자막 자리: 화면 밖 목소리는 아래, 화면 속 사람의 말은 가운데 · 위 중 얼굴이 없는 자리", () => {
  const cap = (id: string, start: number, speaker?: "on_screen" | "off_screen") => ({ id, text: "가", emphasis: [], start, end: start + 1, beat: 0, ...(speaker ? { speaker } : {}) });
  const tl = {
    duration: 20,
    lines: [],
    cuts: [],
    graphics: [],
    sfx: [],
    hook: { start: 0, end: 1, onScreen: "", highlight: "", position: "top" },
    captionPrefer: "lower",
    captions: [cap("a", 2, "off_screen"), cap("b", 5, "on_screen"), cap("c", 8, "on_screen"), cap("d", 11), cap("e", 14, "on_screen")],
  } as unknown as Timeline;
  const zones = [
    // 얼굴이 가운데에 있는 컷: 화면 밖 목소리는 아래, 화면 속 사람의 말은 위
    { start: 0, end: 7, cover: { top: 0.3, mid: 0.8, lower: 0.9 }, face: { top: 0.1, mid: 0.8, lower: 0 } },
    // 얼굴이 위에 있는 컷: 가운데가 비어 가운데에
    { start: 7, end: 10, cover: { top: 0.6, mid: 0.4, lower: 0.9 }, face: { top: 0.9, mid: 0.1, lower: 0 } },
    // 말하는 사람을 모르는 자막은 예전처럼 레퍼런스 자리
    { start: 10, end: 13, cover: { top: 0, mid: 0.5, lower: 0.9 }, face: { top: 0, mid: 0.8, lower: 0 } },
    // 위 · 가운데 모두 얼굴이 걸치면 덜 걸친 쪽
    { start: 13, end: 20, cover: { top: 0.5, mid: 0.9, lower: 0.9 }, face: { top: 0.4, mid: 0.9, lower: 0.2 } },
  ];
  assert.deepEqual(captionZones(tl, zones), ["lower", "top", "mid", "lower", "top"]);
});

test("말소리 영상의 낱말 시각: 원본 받아쓰기의 낱말 시각을 완성본 시각으로 옮긴다(다시 받아쓰지 않는다)", () => {
  const plan = { beats: [{ cuts: [{ clip: 1, in: 2, out: 4.6 }] }, { cuts: [{ clip: 2, in: 0, out: 1.3 }] }] } as unknown as EditPlan;
  const lines = [
    { beat: 0, start: 0.05, fileIn: 2, fileOut: 4.6, live: true, speed: 1.3 },
    { beat: 1, start: 2.05, fileIn: 0, fileOut: 1.3, live: true, speed: 1.3 },
  ];
  const clips = [
    { no: 1, hasAudio: true, transcriptWords: [{ text: "앞", start: 0.5, end: 0.9 }, { text: "가", start: 2, end: 2.65 }, { text: "나", start: 3.3, end: 3.95 }] },
    { no: 2, hasAudio: false },
  ];
  const words = liveLineWords(lines, plan, clips)!;
  assert.deepEqual(words.map((w) => [w.text, Number(w.start.toFixed(2)), Number(w.end.toFixed(2))]), [["가", 0.05, 0.55], ["나", 1.05, 1.55]]);
  // AI 음성 줄이 섞였거나, 소리가 있는데 낱말 시각이 없으면 예전처럼 완성본을 받아쓴다
  assert.equal(liveLineWords([{ ...lines[0], live: false }], plan, clips), null);
  assert.equal(liveLineWords(lines, plan, [{ no: 1, hasAudio: true }, clips[1]]), null);
});
