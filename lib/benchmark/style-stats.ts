// 다른 계정 릴스 영상 스타일 — 판정 값과 집계(순수 함수). 화면과 워커가 같이 쓴다.
//
// "왜 잘됐나"를 잘된 릴스만 보고 말하면 그 계정이 원래 늘 하던 방식을 원인으로 착각한다.
// 그래서 같은 계정의 평소 릴스(평소의 0.5~1.5배)를 같이 판정해 비율을 나란히 둔다.
// 판정하는 AI에게는 어느 쪽 릴스인지 알려 주지 않는다.

export const OPENING = ["얼굴로 말하기", "제품 클로즈업", "손 · 사용 장면", "전후 · 결과 먼저", "글자 화면", "상황 연기", "공간 · 풍경", "기타", "알 수 없음"] as const;
export const SCREEN_TEXT = ["큰 문구", "말 자막만", "글자 없음", "알 수 없음"] as const;
export const SHOOTING = ["셀카 · 말하기", "고정 촬영", "손 · 위에서 찍기", "일상 브이로그", "사진 넘기기", "그래픽 · 화면 녹화", "여러 영상 짜깁기", "기타", "알 수 없음"] as const;
export const PERSON = ["얼굴 나옴", "손 · 몸만", "사람 없음", "알 수 없음"] as const;
export const CONTENT_FORMAT = ["정보 · 방법", "후기 · 경험", "비교 · 테스트", "상황극 · 유머", "제품 소개", "할인 · 이벤트", "일상", "기타"] as const;

export interface ReelStyle {
  opening: (typeof OPENING)[number];
  screenText: (typeof SCREEN_TEXT)[number];
  shooting: (typeof SHOOTING)[number];
  person: (typeof PERSON)[number];
  format: (typeof CONTENT_FORMAT)[number];
  // 첫 화면 문구나 첫 마디를 짧게
  hookLine: string;
  // 이 영상의 특징 한 줄
  note: string;
  // 아래는 영상을 본 릴스만 — 코드가 잰 값
  durationSec?: number;
  cutsPer10s?: number;
  speech?: boolean;
}

export type StyleSource = "VIDEO" | "COVER";

export interface StyleRow {
  id: string;
  isHit: boolean;
  source: StyleSource;
  style: ReelStyle;
}

const UNKNOWN = new Set(["알 수 없음", "기타"]);

export function paceLabel(cutsPer10s: number | undefined): string | null {
  if (cutsPer10s == null) return null;
  return cutsPer10s < 1 ? "거의 안 끊김" : cutsPer10s < 3 ? "보통" : "빠르게 끊김";
}

export function lengthLabel(sec: number | undefined): string | null {
  if (sec == null) return null;
  return sec <= 15 ? "15초 이하" : sec <= 30 ? "16~30초" : sec <= 60 ? "31~60초" : "1분 넘음";
}

interface Dimension {
  key: string;
  label: string;
  // 표지만 본 릴스로도 판단할 수 있나
  coverOk: boolean;
  value: (s: ReelStyle) => string | null;
}

const DIMENSIONS: Dimension[] = [
  { key: "opening", label: "첫 장면", coverOk: false, value: (s) => s.opening },
  { key: "screenText", label: "첫 3초 글자", coverOk: false, value: (s) => s.screenText },
  { key: "shooting", label: "촬영 방식", coverOk: false, value: (s) => s.shooting },
  { key: "person", label: "사람", coverOk: false, value: (s) => s.person },
  { key: "format", label: "내용", coverOk: true, value: (s) => s.format },
  { key: "pace", label: "편집 속도", coverOk: false, value: (s) => paceLabel(s.cutsPer10s) },
  { key: "speech", label: "말", coverOk: false, value: (s) => (s.speech == null ? null : s.speech ? "말함" : "말 없음") },
  { key: "length", label: "길이", coverOk: false, value: (s) => lengthLabel(s.durationSec) },
];

export interface StyleValue {
  value: string;
  hit: number;
  normal: number;
}

export interface StyleDimension {
  key: string;
  label: string;
  hitTotal: number;
  normalTotal: number;
  values: StyleValue[];
}

export interface StyleStandout {
  id: string;
  label: string;
  value: string;
  hit: number;
  hitTotal: number;
  normal: number;
  normalTotal: number;
}

export interface StyleStats {
  hits: { total: number; video: number; cover: number };
  normals: { total: number; video: number; cover: number };
  dimensions: StyleDimension[];
  standouts: StyleStandout[];
}

// 잘된 릴스에서 3개 넘게 나오고, 평소 릴스보다 비율이 20%포인트 넘게 높은 것만 특징으로 본다
const MIN_HITS = 3;
const MIN_GROUP = 5;
const MIN_GAP = 0.2;

export function computeStyleStats(rows: StyleRow[]): StyleStats {
  const group = (hit: boolean) => {
    const list = rows.filter((r) => r.isHit === hit);
    return { total: list.length, video: list.filter((r) => r.source === "VIDEO").length, cover: list.filter((r) => r.source === "COVER").length };
  };

  const dimensions: StyleDimension[] = DIMENSIONS.map((d) => {
    const usable = rows.flatMap((r) => {
      if (r.source === "COVER" && !d.coverOk) return [];
      const value = d.value(r.style);
      return value && !UNKNOWN.has(value) ? [{ value, isHit: r.isHit }] : [];
    });
    const names = [...new Set(usable.map((u) => u.value))];
    const values = names
      .map((value) => ({
        value,
        hit: usable.filter((u) => u.value === value && u.isHit).length,
        normal: usable.filter((u) => u.value === value && !u.isHit).length,
      }))
      .sort((a, b) => b.hit - a.hit || b.normal - a.normal);
    return { key: d.key, label: d.label, hitTotal: usable.filter((u) => u.isHit).length, normalTotal: usable.filter((u) => !u.isHit).length, values };
  });

  const standouts = dimensions
    .flatMap((d) =>
      d.hitTotal >= MIN_GROUP && d.normalTotal >= MIN_GROUP
        ? d.values
            .filter((v) => v.hit >= MIN_HITS && v.hit / d.hitTotal - v.normal / d.normalTotal >= MIN_GAP)
            .map((v) => ({ id: `${d.key}:${v.value}`, label: d.label, value: v.value, hit: v.hit, hitTotal: d.hitTotal, normal: v.normal, normalTotal: d.normalTotal }))
        : [],
    )
    .sort((a, b) => b.hit / b.hitTotal - b.normal / b.normalTotal - (a.hit / a.hitTotal - a.normal / a.normalTotal));

  return { hits: group(true), normals: group(false), dimensions, standouts };
}

export interface InsightPoint {
  standoutId: string;
  title: string;
  detail: string;
  apply: string;
}

export interface InsightSummary {
  headline: string;
  points: InsightPoint[];
  styleSummary: string;
  caution: string;
}
