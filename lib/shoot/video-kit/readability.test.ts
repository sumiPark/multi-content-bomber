import assert from "node:assert/strict";
import test from "node:test";
import { accentBackground, buildSubtitleFile, type CaptionDesign } from "./caption-skill";
import { ACCENT_MIN_CONTRAST, contrast, DEFAULT_LOOK, normalizeLook, readableAccent, rgbLuminance } from "./caption-style";
import { nearlyFlat, pictureShare } from "./pipeline";

// 자막 강조색 대비와 빈 화면 검사. 2026-11-09 시험 영상(파이니티 리젠 버블 액티베이터) 재현값을 쓴다

const hue = (color: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (!d) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
const lum = (color: string) => rgbLuminance(...([1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)) as [number, number, number]));
const ratioTo = (color: string, bg: number) => (Math.max(lum(color), bg) + 0.05) / (Math.min(lum(color), bg) + 0.05);

// 37초 자막 자리(위쪽): 붉은 제품 화면 사이에 흰 펌프가 걸친다. 16×16 세 장을 쌓은 rgb24
function mixedZone(): Uint8Array {
  const px: number[] = [];
  for (let frame = 0; frame < 3; frame++) {
    for (let i = 0; i < 256; i++) {
      // 붉은 배경 72% · 펌프 그늘(중간 밝기) 18% · 흰 펌프 10%
      const c = i < 184 ? [176, 28, 48] : i < 230 ? [150, 128, 130] : [236, 232, 228];
      px.push(...c);
    }
  }
  return Uint8Array.from(px);
}

test("강조색은 이미 읽히는 어두운 배경에서는 그대로 둔다", () => {
  assert.equal(readableAccent("#FFD23F", 0.03, "#FFFFFF"), "#FFD23F");
  assert.equal(readableAccent("#F1B9C2", "#352529", "#FFF9F5"), "#F1B9C2");
});

test("밝은 펌프가 섞인 자막 자리에서는 강조색의 명도만 올려 대비를 맞춘다", () => {
  const bg = accentBackground(mixedZone())!;
  // 평균이 아니라 밝은 쪽(상위 4분의 1)과 잰다
  assert.ok(bg > 0.2, `배경 휘도 ${bg}`);
  // 고치기 전: 스킬 강조색 #FFD23F를 그대로 썼다
  const white = ratioTo("#FFFFFF", bg);
  const target = Math.min(ACCENT_MIN_CONTRAST, 0.85 * white);
  assert.ok(ratioTo("#FFD23F", bg) < target, "재현: 고치기 전 강조색은 기준보다 대비가 낮다");
  for (const accent of ["#FFD23F", "#F1B9C2"]) {
    const fixed = readableAccent(accent, bg, "#FFFFFF");
    assert.ok(ratioTo(fixed, bg) >= target - 1e-9, `${accent} → ${fixed} 대비 ${ratioTo(fixed, bg).toFixed(2)}`);
    assert.ok(lum(fixed) > lum(accent), "밝게만 고친다");
    assert.ok(Math.abs(hue(fixed) - hue(accent)) < 4, `색 계열 유지 ${hue(accent).toFixed(0)}° → ${hue(fixed).toFixed(0)}°`);
    assert.notEqual(fixed, "#FFFFFF", "흰색으로 바래지 않는다");
  }
});

test("어두운 글자 쪽이면 강조색을 어둡게 고친다", () => {
  const fixed = readableAccent("#FFD23F", "#FFFFFF", "#111111");
  assert.ok(contrast(fixed, "#FFFFFF") >= ACCENT_MIN_CONTRAST);
  assert.ok(Math.abs(hue(fixed) - hue("#FFD23F")) < 4);
});

const design: CaptionDesign = {
  key_fx: "39",
  small_fx: "cut",
  finish_fx: "39",
  key_font: "마루 부리",
  small_font: "이서윤체",
  reading: "",
  lines: [{ no: 0, rows: [{ text: "전성분의 ", role: "small" }, { text: "사이아노코발아민도 확인해 보세요.", role: "key" }], fx: "", spark: false }],
};
const cue = { id: "c21", text: "전성분의 사이아노코발아민도 확인해 보세요.", start: 35.569, end: 38.9, beat: 15, emphasis: ["사이아노코발아민"] };
type Row = { key?: boolean; color?: string; tone?: string };

test("스킬 자막의 강조어 줄은 그 자막 배경에 맞춘 강조색을 받는다", () => {
  const bg = accentBackground(mixedZone())!;
  const file = buildSubtitleFile("video.mp4", [cue], ["top"], design, [null], [], [], undefined, { captions: [bg] });
  const [small, key] = file.lines[0].rows as Row[];
  assert.equal(small.color, undefined, "작은 줄은 기본 글자색");
  assert.equal(key.tone, undefined);
  assert.equal(key.color, readableAccent("#FFD23F", bg, "#FFFFFF"));
  assert.notEqual(key.color, "#FFD23F");
  // 블록이 없으면 전체 강조색은 그대로
  assert.equal(file.style.accent, "#FFD23F");
  // 배경을 재지 못하면 예전처럼 전체 강조색(tone hi)
  const unknown = buildSubtitleFile("video.mp4", [cue], ["top"], design, [null]);
  assert.equal((unknown.lines[0].rows as Row[])[1].tone, "hi");
  // 밝은 배경 자막은 강조어 줄도 어두운 글자 그대로
  const bright = buildSubtitleFile("video.mp4", [cue], ["top"], design, [200], [], [], undefined, { captions: [0.8] });
  assert.equal((bright.lines[0].rows as Row[])[1].color, "#1B1F27");
});

test("후킹 · 끝 화면 강조 낱말의 전체 강조색은 흰 글자 블록 배경에 맞춘다", () => {
  const hook = { start: 0, end: 2.6, zone: "top" as const, fx: "39", highlight: "이름", rows: [{ text: "비타민, 이름이 달라요", role: "key" as const }] };
  const file = buildSubtitleFile("video.mp4", [], [], design, [], [hook], [null], undefined, { blocks: [0.3] });
  assert.equal(file.style.accent, readableAccent("#FFD23F", 0.3, "#FFFFFF"));
  // 밝은 블록(어두운 글자)은 계산에서 뺀다
  const bright = buildSubtitleFile("video.mp4", [], [], design, [], [hook], [200], undefined, { blocks: [0.9] });
  assert.equal(bright.style.accent, "#FFD23F");
});

test("기본 자막 look도 상자 · 외곽선과 강조색 대비를 기준(3:1)에 맞추고 색 계열은 둔다", () => {
  // 시험 영상의 look은 이미 충분히 읽혀 그대로
  const trial = normalizeLook({ ...DEFAULT_LOOK, treatment: "box", text_color: "#FFF9F5", accent_color: "#F1B9C2", box_color: "#352529" });
  assert.equal(trial.accent_color, "#F1B9C2");
  const box = normalizeLook({ ...DEFAULT_LOOK, treatment: "box", text_color: "#FFFFFF", accent_color: "#7A3B46", box_color: "#352529" });
  assert.ok(contrast(box.accent_color, "#352529") >= ACCENT_MIN_CONTRAST, box.accent_color);
  assert.ok(Math.abs(hue(box.accent_color) - hue("#7A3B46")) < 4);
  const stroke = normalizeLook({ ...DEFAULT_LOOK, treatment: "stroke", text_color: "#111111", accent_color: "#F1B9C2" });
  assert.ok(contrast(stroke.accent_color, "#FFFFFF") >= ACCENT_MIN_CONTRAST, stroke.accent_color);
  assert.equal(normalizeLook(DEFAULT_LOOK).accent_color, DEFAULT_LOOK.accent_color);
});

// 64×128 회색 화면을 만든다. rows(y)가 그 줄의 화소를 낸다
const frame = (w: number, h: number, rows: (y: number, x: number) => number) => Uint8Array.from({ length: w * h }, (_, i) => rows(Math.floor(i / w), i % w));
const texture = (y: number, x: number) => 60 + ((x * 37 + y * 91) % 120);

test("가로로 긴 움직이는 이미지를 폭에 맞춰 위아래를 단색으로 채운 컷은 그림이 작다", () => {
  // 시험 영상 24.0~26.0초: 위 40줄 · 아래 41줄이 채운 띠(그림 0.37)
  const gif = frame(64, 128, (y, x) => (y < 40 || y >= 87 ? 18 : texture(y, x)));
  assert.ok(Math.abs(pictureShare(gif, 64, 128) - 47 / 128) < 1e-9);
  assert.ok(pictureShare(gif, 64, 128) < 0.45);
  // 화면 전체 편차는 커서 예전 검사(거의 한 색)로는 못 잡는다
  assert.equal(nearlyFlat(frame(64, 64, (y, x) => (y < 20 || y >= 44 ? 18 : texture(y, x)))), false);
  // 꽉 찬 컷 · 위만 결 있는 민 바탕인 그림은 띠로 보지 않는다
  assert.equal(pictureShare(frame(64, 128, texture), 64, 128), 1);
  const paper = frame(64, 128, (y, x) => (y < 60 ? 220 + ((x * 7 + y * 3) % 9) : texture(y, x)));
  assert.equal(pictureShare(paper, 64, 128), 1);
  // 화면 전체가 한 색이면 0
  assert.equal(pictureShare(frame(64, 128, () => 40), 64, 128), 0);
});

test("거의 한 색인 화면은 빈 화면으로 본다", () => {
  assert.equal(nearlyFlat(frame(64, 64, (y) => 50 + (y % 3))), true);
  assert.equal(nearlyFlat(frame(64, 64, texture)), false);
  assert.equal(nearlyFlat(new Uint8Array()), false);
});
