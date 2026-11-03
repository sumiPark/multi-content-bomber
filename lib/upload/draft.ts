// 콘텐츠 생성 '임시 저장' — 이어서 하기용 마법사 상태 (contents.draft_state, 0033).
// 화면 전용 값이라 서버 로직은 읽지 않는다. 저장된 JSON은 예전 버전일 수 있어 parseDraftState로
// 하나씩 확인해 읽고, 모르는 값은 기본값으로 둔다.

import type { Captions } from "@/lib/ai/caption-generator";
import type { ValidationResult } from "@/lib/upload/validation";

export type DraftCaptionMode = "ai" | "manual";
export type DraftScheduleMode = "now" | "scheduled";

export interface WizardDraftState {
  /** 저장할 때 있던 단계 — 이어서 하면 이 단계로 연다(3~5). */
  step: number;
  accountIds: string[];
  captionMode: DraftCaptionMode;
  presetId: string;
  description: string;
  scheduleMode: DraftScheduleMode;
  scheduledAt: string;
  seriesChoice: Record<string, string>;
  replyChoice: Record<string, boolean>;
  /** 캡션 분석에 쓴 경로(영상이면 첫 프레임 썸네일). 다시 쓰기 · 다른 스타일에 필요. */
  analyzePaths: string[];
  /** 저장할 때의 미디어 검증 결과 — 이어서 할 땐 원본 파일이 없어 다시 검증할 수 없다. */
  validation: ValidationResult | null;
}

/** 이어서 하기로 마법사를 열 때 넘기는 값 (upload/page.tsx가 만든다). */
export interface WizardDraft {
  contentId: string;
  mediaType: "IMAGE" | "VIDEO";
  mediaPaths: string[];
  metadata: Record<string, unknown>;
  captions: Captions;
  savedAt: string;
  draftSavedAt: string;
  thumbnailUrls: string[];
  internalTitle: string;
  state: WizardDraftState;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function strRecord(v: unknown): Record<string, string> {
  if (!isRecord(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) if (typeof x === "string") out[k] = x;
  return out;
}

function boolRecord(v: unknown): Record<string, boolean> {
  if (!isRecord(v)) return {};
  const out: Record<string, boolean> = {};
  for (const [k, x] of Object.entries(v)) if (typeof x === "boolean") out[k] = x;
  return out;
}

function parseValidation(v: unknown): ValidationResult | null {
  if (!isRecord(v) || typeof v.ok !== "boolean" || !Array.isArray(v.perPlatform)) {
    return null;
  }
  return v as unknown as ValidationResult;
}

export function parseDraftState(raw: unknown): WizardDraftState | null {
  if (!isRecord(raw)) return null;
  const step = typeof raw.step === "number" ? Math.round(raw.step) : 3;
  return {
    step: Math.min(5, Math.max(3, step)),
    accountIds: strArray(raw.accountIds),
    captionMode: raw.captionMode === "manual" ? "manual" : "ai",
    presetId: typeof raw.presetId === "string" ? raw.presetId : "",
    description: typeof raw.description === "string" ? raw.description : "",
    scheduleMode: raw.scheduleMode === "scheduled" ? "scheduled" : "now",
    scheduledAt: typeof raw.scheduledAt === "string" ? raw.scheduledAt : "",
    seriesChoice: strRecord(raw.seriesChoice),
    replyChoice: boolRecord(raw.replyChoice),
    analyzePaths: strArray(raw.analyzePaths),
    validation: parseValidation(raw.validation),
  };
}
