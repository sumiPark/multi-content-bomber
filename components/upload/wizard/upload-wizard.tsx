"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CalendarCheck,
  Check,
  CircleAlert,
  CircleCheck,
  ImageIcon,
  Info,
  OctagonAlert,
  Pencil,
  RefreshCw,
  Save,
  Send,
  Sparkles,
} from "lucide-react";
import {
  CaptionResult,
  type CaptionResultHandle,
} from "@/components/ai/caption-result";
import { ImageDropzone } from "@/components/upload/image-dropzone";
import { VideoDropzone } from "@/components/upload/video-dropzone";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PlatformIcon } from "@/components/ui/platform-icon";
import { RelativeTime } from "@/components/ui/relative-time";
import { Segmented } from "@/components/ui/segmented";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  clearDraftAction,
  createBlankContentAction,
  createPublishJobsAction,
  generateCaptionsAction,
  regenerateCaptionsAction,
  saveDraftAction,
  type CreateBlankContentResult,
  type GenerateCaptionsResult,
  type RegenerateCaptionsResult,
} from "@/app/(dashboard)/actions";
import type { Captions } from "@/lib/ai/caption-generator";
import type { Platform } from "@/lib/platforms";
import type { WizardDraft, WizardDraftState } from "@/lib/upload/draft";
import { uploadMedia, uploadOne } from "@/lib/storage/upload";
import {
  extractImageMeta,
  extractVideoMeta,
} from "@/lib/upload/extract-meta";
import {
  validateMedia,
  type MediaItem,
  type PlatformVerdict,
  type ValidationResult,
} from "@/lib/upload/validation";
import { extractFirstFrame } from "@/lib/video/extract-frame";
import { StepIndicator } from "./step-indicator";

const STEPS = [
  { key: 1, label: "계정 고르기", description: "올릴 계정을 고르세요. 그룹마다 한 번에 고를 수 있어요." },
  { key: 2, label: "사진 · 영상", description: "계정마다 올릴 수 있는 형식인지 바로 확인해요." },
  { key: 3, label: "캡션 쓰기", description: "플랫폼마다 글자 수 · 해시태그 규칙에 맞춰 따로 써요." },
  { key: 4, label: "미리 보기", description: "계정마다 어떻게 보일지 확인하세요." },
  { key: 5, label: "올릴 시각", description: "바로 올리거나 시각을 정하세요." },
];

const PLATFORM_LABEL: Record<Platform, string> = {
  INSTAGRAM: "인스타그램",
  YOUTUBE: "유튜브",
  TIKTOK: "틱톡",
};

interface SocialAccountSummary {
  id: string;
  platform: Platform;
  display_name: string | null;
  is_active: boolean;
  token_expires_at: string | null;
  group_id: string | null;
}

interface AccountGroupSummary {
  id: string;
  name: string;
  color: string;
}

interface PresetSummary {
  id: string;
  name: string;
  description: string | null;
}

// 시리즈 댓글 자동화(0017) — 인스타 계정의 시리즈. 고르면 발행 성공 시 다음 회차로 기록된다.
interface SeriesOption {
  id: string;
  name: string;
  socialAccountId: string;
  nextEpisodeNo: number;
  // 이 시리즈에 아직 안 올라간 예약 수 — 다음 화 번호에 이미 더해져 있다
  pendingCount: number;
}

interface UploadWizardProps {
  organizationId: string;
  userId: string;
  socialAccounts: SocialAccountSummary[];
  accountGroups: AccountGroupSummary[];
  presets: PresetSummary[];
  seriesOptions?: SeriesOption[];
  /** 보관함에서 '이어서 하기'로 열었을 때 임시 저장한 상태 (0033). */
  initialDraft?: WizardDraft | null;
}

// 이어서 할 땐 원본 파일이 없어 다시 검증할 수 없다 — 저장할 때의 검증 결과를 지금 고른 플랫폼만큼
// 다시 쓴다. 저장 뒤 새로 고른 플랫폼이 있으면 결과가 없으니 null(사진 · 영상을 다시 올려야 한다).
function restoredValidationFor(
  snapshot: ValidationResult | null,
  platforms: Platform[],
): ValidationResult | null {
  if (!snapshot || platforms.length === 0) return null;
  const perPlatform = platforms.map((p) =>
    snapshot.perPlatform.find((v) => v.platform === p),
  );
  if (perPlatform.some((v) => !v)) return null;
  const list = perPlatform as PlatformVerdict[];
  const blockedPlatforms = list
    .filter((v) => v.status === "blocked")
    .map((v) => v.platform);
  return {
    ok: blockedPlatforms.length === 0,
    blockedPlatforms,
    perPlatform: list,
    issues: list.flatMap((v) => v.issues),
  };
}

type MediaType = "IMAGE" | "VIDEO";
type ScheduleMode = "now" | "scheduled";
type CaptionMode = "ai" | "manual";

export function UploadWizard({
  organizationId,
  userId,
  socialAccounts = [],
  accountGroups = [],
  presets = [],
  seriesOptions = [],
  initialDraft = null,
}: UploadWizardProps) {
  const router = useRouter();
  const draft = initialDraft;
  // 이어서 하기: 지금도 고를 수 있는 계정만 되살린다(그 사이 연결이 끊긴 계정은 뺀다).
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>(() =>
    draft
      ? draft.state.accountIds.filter((id) =>
          socialAccounts.some((a) => a.id === id && a.is_active),
        )
      : [],
  );
  const [step, setStep] = useState(() =>
    draft ? (selectedAccountIds.length > 0 ? draft.state.step : 1) : 1,
  );
  const [mediaType, setMediaType] = useState<MediaType>(
    draft?.mediaType ?? "IMAGE",
  );
  const [files, setFiles] = useState<File[]>([]);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  // 사용자가 고른 커버 프레임 시점(초). null이면 미지정. 영상 모드에서만 사용.
  const [coverSeconds, setCoverSeconds] = useState<number | null>(null);
  // 고른 프레임을 캡처한 JPEG. YouTube 썸네일 업로드용 (TikTok/IG는 시점 ms만 사용).
  const [coverBlob, setCoverBlob] = useState<Blob | null>(null);
  const [mediaPaths, setMediaPaths] = useState<string[]>(
    draft?.mediaPaths ?? [],
  );
  const [analyzePaths, setAnalyzePaths] = useState<string[]>(
    draft?.state.analyzePaths ?? [],
  );
  const [mediaMetadata, setMediaMetadata] = useState<Record<string, unknown>>(
    draft?.metadata ?? {},
  );
  // 이어서 하기로 열어 임시 저장한 사진 · 영상을 그대로 쓰는 중인지. 새 파일을 고르면 false.
  const [resumedMedia, setResumedMedia] = useState(!!draft);
  const [validation, setValidation] = useState<ValidationResult | null>(() =>
    draft
      ? restoredValidationFor(
          draft.state.validation,
          Array.from(
            new Set(
              socialAccounts
                .filter((a) => selectedAccountIds.includes(a.id))
                .map((a) => a.platform),
            ),
          ),
        )
      : null,
  );
  const [uploading, setUploading] = useState(false);
  const [internalTitle, setInternalTitle] = useState(draft?.internalTitle ?? "");
  const [presetId, setPresetId] = useState<string>(draft?.state.presetId ?? "");
  const [description, setDescription] = useState(draft?.state.description ?? "");
  const [generating, setGenerating] = useState(false);
  const [captions, setCaptions] = useState<Captions | null>(
    draft?.captions ?? null,
  );
  const [contentId, setContentId] = useState<string | null>(
    draft?.contentId ?? null,
  );
  const [savedAt, setSavedAt] = useState<string | null>(draft?.savedAt ?? null);
  const [thumbnailUrls, setThumbnailUrls] = useState<string[]>(
    draft?.thumbnailUrls ?? [],
  );
  const [captionMode, setCaptionMode] = useState<CaptionMode>(
    draft?.state.captionMode ?? "ai",
  );
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>(
    draft?.state.scheduleMode ?? "now",
  );
  const [scheduledAt, setScheduledAt] = useState(draft?.state.scheduledAt ?? "");
  // 계정 id → "다음 화로 올리기"로 고른 시리즈 id. 빈 문자열이면 시리즈 아님.
  const [seriesChoice, setSeriesChoice] = useState<Record<string, string>>(
    draft?.state.seriesChoice ?? {},
  );
  // 계정 id → 올라가면 바로 이전 화 댓글에 답글을 달지. 기본 꺼짐.
  const [replyChoice, setReplyChoice] = useState<Record<string, boolean>>(
    draft?.state.replyChoice ?? {},
  );
  // 임시 저장 — 누른 시각(보관함에 들어간 시각). 이어서 하기면 예전 저장 시각부터.
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(
    draft?.draftSavedAt ?? null,
  );
  const [savingDraft, setSavingDraft] = useState(false);
  const [completing, setCompleting] = useState(false);
  // '완료' 재진입 잠금 — state 반영(다음 렌더)보다 먼저 걸린다. 성공하면 페이지를
  // 벗어날 때까지 잠긴 채로 둔다(실패 시에만 해제).
  const completingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  // 직접 작성 모드 등에서 카드 안의 "저장"을 누르지 않고 "다음 단계"로 넘어가도
  // 미저장 초안이 확정 저장되도록 CaptionResult에 imperative 접근한다.
  const captionRef = useRef<CaptionResultHandle>(null);

  const selectedPreset = useMemo(
    () => presets.find((p) => p.id === presetId),
    [presets, presetId],
  );

  const selectedAccounts = useMemo(
    () => socialAccounts.filter((a) => selectedAccountIds.includes(a.id)),
    [socialAccounts, selectedAccountIds],
  );

  const selectedPlatforms = useMemo<Platform[]>(() => {
    const set = new Set<Platform>();
    for (const acc of selectedAccounts) set.add(acc.platform);
    return Array.from(set);
  }, [selectedAccounts]);

  const includesTiktok = selectedPlatforms.includes("TIKTOK");

  const seriesRows = useMemo(
    () =>
      selectedAccounts
        .filter((a) => a.platform === "INSTAGRAM")
        .map((account) => ({
          account,
          options: seriesOptions.filter((o) => o.socialAccountId === account.id),
        }))
        .filter((row) => row.options.length > 0),
    [selectedAccounts, seriesOptions],
  );

  // TikTok이 포함되면 영상 모드 강제 (TikTok Content Posting API는 영상만 지원)
  useEffect(() => {
    if (includesTiktok && mediaType === "IMAGE") {
      setMediaType("VIDEO");
      setResumedMedia(false);
      setFiles([]);
      setMediaPaths([]);
      setAnalyzePaths([]);
      setMediaMetadata({});
    }
  }, [includesTiktok, mediaType]);

  // 메타데이터(해상도/길이) 추출 후 정확한 검증.
  // 드롭 직후와 "다음" 직후의 검증 결과가 달라지지 않도록 처음부터 메타를 뽑는다.
  useEffect(() => {
    if (selectedPlatforms.length === 0) {
      setValidation(null);
      return;
    }
    let cancelled = false;

    async function run() {
      if (mediaType === "IMAGE") {
        if (files.length === 0) {
          setValidation(
            resumedMedia
              ? restoredValidationFor(draft?.state.validation ?? null, selectedPlatforms)
              : null,
          );
          return;
        }
        const items: MediaItem[] = await Promise.all(
          files.map(async (f) => {
            try {
              const meta = await extractImageMeta(f);
              return { file: f, width: meta.width, height: meta.height };
            } catch {
              return { file: f };
            }
          }),
        );
        if (cancelled) return;
        setValidation(validateMedia("IMAGE", items, selectedPlatforms));
      } else {
        if (!videoFile) {
          setValidation(
            resumedMedia
              ? restoredValidationFor(draft?.state.validation ?? null, selectedPlatforms)
              : null,
          );
          return;
        }
        try {
          const meta = await extractVideoMeta(videoFile);
          if (cancelled) return;
          setValidation(
            validateMedia(
              "VIDEO",
              [
                {
                  file: videoFile,
                  width: meta.width,
                  height: meta.height,
                  durationSeconds: meta.durationSeconds,
                },
              ],
              selectedPlatforms,
            ),
          );
        } catch {
          if (cancelled) return;
          setValidation(
            validateMedia("VIDEO", [{ file: videoFile }], selectedPlatforms),
          );
        }
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [files, videoFile, mediaType, selectedPlatforms, resumedMedia, draft]);

  const canAdvanceStep1 = selectedAccountIds.length > 0;

  // 이어서 하기: 새 파일을 안 골랐으면 임시 저장한 사진 · 영상을 그대로 쓴다.
  const usingResumedMedia =
    resumedMedia &&
    mediaPaths.length > 0 &&
    (mediaType === "IMAGE" ? files.length === 0 : !videoFile);

  const canAdvanceStep2 = useMemo(() => {
    if (usingResumedMedia) return validation?.ok ?? false;
    if (mediaType === "IMAGE" && files.length === 0) return false;
    if (mediaType === "VIDEO" && !videoFile) return false;
    return validation?.ok ?? false;
  }, [mediaType, files, videoFile, validation, usingResumedMedia]);

  const canAdvanceStep3 = !!captions;

  const canAdvanceStep4 =
    !!captions &&
    selectedAccountIds.length > 0 &&
    (validation?.ok ?? false);

  function switchMediaType(next: MediaType) {
    if (mediaType === next) return;
    setMediaType(next);
    setResumedMedia(false);
    setFiles([]);
    setVideoFile(null);
    setCoverSeconds(null);
    setCoverBlob(null);
    setMediaPaths([]);
    setAnalyzePaths([]);
    setMediaMetadata({});
    setError(null);
  }

  // 영상 파일이 바뀌면 이전에 고른 커버는 무의미해지므로 초기화.
  function handleChangeVideo(file: File | null) {
    // 드롭존이 다시 그려지며 같은 영상을 알려 오면(단계를 오갈 때) 아무것도 바꾸지 않는다 — 고른 커버 유지
    if (file === videoFile) return;
    // 드롭존은 처음 그려질 때 null을 한 번 알린다 — 실제로 고른 때만 임시 저장 미디어를 버린다.
    if (file) setResumedMedia(false);
    setVideoFile(file);
    setCoverSeconds(null);
    setCoverBlob(null);
  }

  function handleChangeFiles(next: File[]) {
    // 드롭존이 다시 그려지며 같은 파일을 같은 순서로 알려 오면(단계를 오갈 때) 아무것도 바꾸지 않는다
    if (next.length === files.length && next.every((f, i) => f === files[i])) return;
    // 드롭존은 처음 그려질 때 빈 배열을 한 번 알린다 — 실제로 고른 때만 임시 저장 미디어를 버린다.
    if (next.length > 0) setResumedMedia(false);
    setFiles(next);
  }

  // 미리보기에서 캡처한 커버 프레임 — 시점(초)과 JPEG blob을 함께 받는다.
  function handleCoverChange(seconds: number, blob: Blob | null) {
    setCoverSeconds(seconds);
    setCoverBlob(blob);
  }

  function toggleAccount(id: string, checked: boolean) {
    setSelectedAccountIds((prev) =>
      checked ? [...prev, id] : prev.filter((x) => x !== id),
    );
    // 계정 변경 시 captions stale 처리
    setCaptions(null);
    setContentId(null);
    setThumbnailUrls([]);
  }

  // 올린 사진 · 영상의 지문 — 같은 파일 · 순서 · 커버면 다시 올리지 않는다
  const uploadedKeyRef = useRef<string | null>(null);
  function mediaKey(): string {
    const sig = (f: File) => `${f.name}:${f.size}:${f.lastModified}`;
    return mediaType === "IMAGE" ? `I|${files.map(sig).join("|")}` : `V|${videoFile ? sig(videoFile) : ""}|${coverSeconds ?? ""}`;
  }

  async function advanceFromStep2() {
    setError(null);
    if (!canAdvanceStep2) return;
    if (usingResumedMedia) {
      setStep(3);
      return;
    }
    // 이미 올린 것과 같은 사진 · 영상(커버 포함)이면 다시 올리지 않는다 — 다시 올리면 써 둔 캡션이 지워졌다(2026-11-04)
    if (mediaPaths.length > 0 && uploadedKeyRef.current === mediaKey()) {
      setStep(3);
      return;
    }
    setUploading(true);
    try {
      if (mediaType === "IMAGE") {
        const uploaded = await uploadMedia({ files, organizationId, userId });
        const paths = uploaded.map((u) => u.path);
        setMediaPaths(paths);
        setAnalyzePaths(paths);
        setMediaMetadata({});
      } else if (videoFile) {
        // 검증은 이미 useEffect에서 정확한 메타데이터로 끝남.
        // 여기서는 thumbnail 추출 + 업로드만.
        const frame = await extractFirstFrame(videoFile);
        const [videoUpload, thumbUpload] = await Promise.all([
          uploadOne({
            file: videoFile,
            contentType: videoFile.type,
            organizationId,
            userId,
          }),
          uploadOne({
            file: frame.blob,
            contentType: "image/jpeg",
            organizationId,
            userId,
          }),
        ]);
        setMediaPaths([videoUpload.path]);
        setAnalyzePaths([thumbUpload.path]);

        // 커버 프레임: 사용자가 미리보기에서 캡처한 시점이 있으면 metadata에 ms로 기록.
        //  - TikTok/Instagram은 이 ms(cover_ms)만 있으면 됨(워커가 그대로 전달).
        //  - YouTube는 프레임 타임스탬프 API가 없어, 캡처해둔 그 프레임 이미지(coverBlob)를
        //    업로드(cover_path)하고 워커가 thumbnails.set으로 올린다. 유튜브가 선택된
        //    경우에만 이미지를 올린다(불필요한 업로드 방지).
        const coverMeta: Record<string, unknown> = {};
        if (coverSeconds !== null) {
          coverMeta.cover_ms = Math.round(coverSeconds * 1000);
          if (coverBlob && selectedPlatforms.includes("YOUTUBE")) {
            const coverUpload = await uploadOne({
              file: coverBlob,
              contentType: "image/jpeg",
              organizationId,
              userId,
            });
            coverMeta.cover_path = coverUpload.path;
          }
        }

        setMediaMetadata({
          thumbnail_path: thumbUpload.path,
          duration_seconds: frame.durationSeconds,
          width: frame.width,
          height: frame.height,
          original_size_bytes: videoFile.size,
          original_mime: videoFile.type,
          ...coverMeta,
        });
      }
      uploadedKeyRef.current = mediaKey();
      // 캡션을 만든 뒤 사진 · 영상을 새로 올렸으면 그 캡션 · 콘텐츠는 옛 미디어 것이다.
      // 그대로 두면 옛 미디어로 발행되므로 캡션을 다시 쓰게 한다.
      if (contentId) {
        setCaptions(null);
        setContentId(null);
        setSavedAt(null);
        setThumbnailUrls([]);
      }
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : "업로드 실패");
    } finally {
      setUploading(false);
    }
  }

  async function handleGenerate() {
    setError(null);
    setGenerating(true);
    try {
      const result: GenerateCaptionsResult = await generateCaptionsAction({
        mediaType,
        mediaPaths,
        analyzePaths,
        metadata: mediaMetadata,
        description: description.trim() || undefined,
        presetId: presetId || undefined,
        platforms: selectedPlatforms,
        internalTitle: internalTitle.trim() || undefined,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCaptions(result.captions);
      setContentId(result.contentId);
      setSavedAt(result.savedAt);
      setThumbnailUrls(result.thumbnailUrls);
    } finally {
      setGenerating(false);
    }
  }

  async function handleRegenerate() {
    if (!contentId || !captions) return;
    setError(null);
    setGenerating(true);
    try {
      const result: RegenerateCaptionsResult = await regenerateCaptionsAction({
        contentId,
        mediaType,
        analyzePaths,
        description: description.trim() || undefined,
        presetId: presetId || undefined,
        platforms: selectedPlatforms,
        previousCaptions: captions,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCaptions(result.captions);
      setSavedAt(result.savedAt);
      setThumbnailUrls(result.thumbnailUrls);
    } finally {
      setGenerating(false);
    }
  }

  async function handleStartManual() {
    setError(null);
    setGenerating(true);
    try {
      const result: CreateBlankContentResult = await createBlankContentAction({
        mediaType,
        mediaPaths,
        analyzePaths,
        metadata: mediaMetadata,
        platforms: selectedPlatforms,
        internalTitle: internalTitle.trim() || undefined,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCaptions(result.captions);
      setContentId(result.contentId);
      setSavedAt(result.savedAt);
      setThumbnailUrls(result.thumbnailUrls);
    } finally {
      setGenerating(false);
    }
  }

  // 3단계(캡션) → 4단계로 넘어가기 전, 미저장 편집을 먼저 확정 저장한다.
  async function advanceFromStep3() {
    if (captionRef.current) {
      const ok = await captionRef.current.commit();
      if (!ok) return; // 저장 실패 시 CaptionResult가 에러를 표시하므로 멈춘다.
    }
    setStep(4);
  }

  function handleSwitchCaptionMode(next: CaptionMode) {
    if (next === captionMode) return;
    if (captions) {
      const ok = window.confirm(
        "이미 작성/생성된 캡션이 있어요. 모드를 바꾸면 기존 내용이 사라지고 처음부터 다시 시작합니다. 계속할까요?",
      );
      if (!ok) return;
      setCaptions(null);
      setContentId(null);
      setSavedAt(null);
      setThumbnailUrls([]);
    }
    setCaptionMode(next);
  }

  async function handleComplete() {
    setError(null);
    if (!contentId || selectedAccountIds.length === 0) return;
    // completingRef는 state보다 먼저 잠긴다 — setCompleting은 다음 렌더에야 버튼에
    // 반영되므로, 같은 tick에 두 번 눌리는 경우는 ref로 막는다.
    if (completingRef.current) return;
    completingRef.current = true;
    setCompleting(true);
    const scheduledFor =
      scheduleMode === "scheduled" && scheduledAt
        ? new Date(scheduledAt).toISOString()
        : null;
    // 지난 시각으로 예약하면 바로 올라가 버린다 — 완료 전에 막는다(서버도 같은 검사)
    if (scheduledFor && Date.parse(scheduledFor) < Date.now()) {
      completingRef.current = false;
      setCompleting(false);
      setError("이미 지난 시각이에요. 예약 시각을 다시 고르거나 '바로 올리기'를 골라 주세요.");
      return;
    }
    const seriesByAccount: Record<string, { seriesId: string; reply: boolean }> = {};
    for (const row of seriesRows) {
      const chosen = seriesChoice[row.account.id];
      if (chosen) {
        seriesByAccount[row.account.id] = {
          seriesId: chosen,
          reply: replyChoice[row.account.id] === true,
        };
      }
    }
    const result = await createPublishJobsAction({
      contentId,
      accountIds: selectedAccountIds,
      scheduledFor,
      seriesByAccount,
    });
    if (!result.ok) {
      completingRef.current = false;
      setCompleting(false);
      setError(result.error);
      return;
    }
    // 성공 시엔 잠금을 풀지 않는다. router.push는 즉시 화면이 바뀌지 않아서,
    // 여기서 completing을 false로 되돌리면 이동 대기 중에 '완료' 버튼이 되살아나고
    // 한 번 더 눌려 같은 배치가 두 번 등록됐다(계정당 릴스 2개 발행의 원인).
    // 이어서 하다가 콘텐츠가 새로 만들어졌으면(계정 · 미디어 변경) 예전 임시 저장은 보관함에서 뺀다.
    if (draft && draft.contentId !== contentId) {
      await clearDraftAction({ contentId: draft.contentId }).catch(() => null);
    }
    router.push(`/?content=${contentId}`);
    router.refresh();
  }

  // 임시 저장 — 누르면 보관함에 들어간다(0033). 캡션을 만든 뒤(콘텐츠가 생긴 뒤)부터 쓸 수 있다.
  async function handleSaveDraft() {
    if (!contentId || savingDraft || completingRef.current) return;
    setError(null);
    // 캡션 단계의 저장 안 한 수정을 먼저 저장한다.
    if (step === 3 && captionRef.current) {
      const ok = await captionRef.current.commit();
      if (!ok) return;
    }
    setSavingDraft(true);
    const state: WizardDraftState = {
      step: Math.max(3, step),
      accountIds: selectedAccountIds,
      captionMode,
      presetId,
      description,
      scheduleMode,
      scheduledAt,
      seriesChoice,
      replyChoice,
      analyzePaths,
      validation,
    };
    const result = await saveDraftAction({
      contentId,
      internalTitle,
      state: state as unknown as Record<string, unknown>,
      replacesContentId:
        draft && draft.contentId !== contentId ? draft.contentId : undefined,
    });
    setSavingDraft(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setDraftSavedAt(result.draftSavedAt);
  }

  // 끝낸 단계로만 되돌아간다. 업로드 · 캡션 생성 · 등록 중에는 막는다.
  const busy = uploading || generating || completing || savingDraft;
  const currentStep = STEPS[step - 1];

  // 3 · 4 · 5단계 아래 줄의 '임시 저장' — 캡션을 만든 뒤(콘텐츠가 생긴 뒤)부터 누를 수 있다.
  const draftButton = (
    <Button
      variant="ghost"
      onClick={handleSaveDraft}
      disabled={!contentId || busy}
      title={!contentId ? "캡션을 만든 뒤 임시 저장할 수 있어요" : undefined}
    >
      <Save />
      {savingDraft ? "저장 중…" : "임시 저장"}
    </Button>
  );

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[188px_minmax(0,1fr)] xl:grid-cols-[188px_minmax(0,1fr)_300px]">
      {draft && (
        <div className="flex gap-2.5 rounded-lg bg-brand-soft px-3.5 py-3 text-[13px] text-ink-2 lg:col-span-2 xl:col-span-3">
          <Info className="mt-0.5 size-4 shrink-0 text-primary" />
          <p>
            임시 저장한 콘텐츠를 이어서 하고 있어요. 고른 계정 · 캡션 · 시각이 그대로예요.
            {selectedAccountIds.length < draft.state.accountIds.length &&
              " 그 사이 연결이 끊긴 계정은 뺐어요."}
          </p>
        </div>
      )}
      <StepIndicator
        current={step}
        steps={STEPS}
        onJump={setStep}
        disabled={busy}
      />

      <section className="min-w-0 rounded-lg border bg-card">
        <header className="flex flex-wrap items-start justify-between gap-2 border-b px-4 py-3.5">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold">
              {step}. {currentStep.label}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {currentStep.description}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {draftSavedAt && (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Badge variant="ok">
                  <CircleCheck />
                  임시 저장됨
                </Badge>
                <span className="tabular-nums">
                  <RelativeTime iso={draftSavedAt} />
                </span>
                <Link href="/contents" className="font-medium text-primary hover:underline">
                  보관함
                </Link>
              </span>
            )}
            {step === 1 && selectedAccountIds.length > 0 && (
              <Badge className="tabular-nums">
                {selectedAccountIds.length}개 고름
              </Badge>
            )}
          </div>
        </header>

        {error && (
          <div
            role="alert"
            className="mx-4 mt-4 flex gap-2.5 rounded-lg bg-risk-soft px-3.5 py-3 text-[13px] text-ink-2"
          >
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-risk" />
            <p>{error}</p>
          </div>
        )}

        {step === 1 && (
          <Step1Accounts
            socialAccounts={socialAccounts}
            accountGroups={accountGroups}
            selectedAccountIds={selectedAccountIds}
            internalTitle={internalTitle}
            onChangeInternalTitle={setInternalTitle}
            onToggle={toggleAccount}
            onSetSelection={(ids) => {
              setSelectedAccountIds(ids);
              setCaptions(null);
              setContentId(null);
              setThumbnailUrls([]);
            }}
            onNext={() => setStep(2)}
            canAdvance={canAdvanceStep1}
          />
        )}

        {step === 2 && (
          <Step2Media
            mediaType={mediaType}
            files={files}
            videoFile={videoFile}
            uploading={uploading}
            validation={validation}
            selectedPlatforms={selectedPlatforms}
            includesTiktok={includesTiktok}
            coverSeconds={coverSeconds}
            onChangeCover={handleCoverChange}
            onSwitchType={switchMediaType}
            onChangeFiles={handleChangeFiles}
            onChangeVideo={handleChangeVideo}
            onPrev={() => setStep(1)}
            onNext={advanceFromStep2}
            canAdvance={canAdvanceStep2}
            usingResumedMedia={usingResumedMedia}
          />
        )}

        {step === 3 && (
          <Step3Caption
            captions={captions}
            contentId={contentId}
            savedAt={savedAt}
            thumbnailUrls={thumbnailUrls}
            description={description}
            presetId={presetId}
            presets={presets}
            selectedPreset={selectedPreset}
            generating={generating}
            captionMode={captionMode}
            onSwitchMode={handleSwitchCaptionMode}
            onChangeDescription={setDescription}
            onChangePreset={setPresetId}
            onGenerate={handleGenerate}
            onStartManual={handleStartManual}
            onRegenerate={handleRegenerate}
            onCaptionsSaved={setCaptions}
            onSavedAtChange={setSavedAt}
            captionRef={captionRef}
            onPrev={() => setStep(2)}
            onNext={advanceFromStep3}
            canAdvance={canAdvanceStep3}
            draftButton={draftButton}
          />
        )}

        {step === 4 && (
          <Step4Review
            selectedAccounts={selectedAccounts}
            selectedPlatforms={selectedPlatforms}
            captions={captions}
            validation={validation}
            mediaType={mediaType}
            mediaCount={
              mediaType === "IMAGE" ? files.length : videoFile ? 1 : 0
            }
            thumbnailUrl={thumbnailUrls[0] ?? null}
            onJump={setStep}
            onPrev={() => setStep(3)}
            onNext={() => setStep(5)}
            canAdvance={canAdvanceStep4}
            draftButton={draftButton}
          />
        )}

        {step === 5 && (
          <Step5Schedule
            scheduleMode={scheduleMode}
            scheduledAt={scheduledAt}
            selectedAccountCount={selectedAccountIds.length}
            hasTikTok={selectedPlatforms.includes("TIKTOK")}
            seriesRows={seriesRows}
            seriesChoice={seriesChoice}
            onChangeSeries={(accountId, seriesId) => {
              setSeriesChoice((prev) => ({ ...prev, [accountId]: seriesId }));
              // 시리즈를 바꾸면 답글 켜기는 다시 꺼진 상태에서 시작.
              setReplyChoice((prev) => ({ ...prev, [accountId]: false }));
            }}
            replyChoice={replyChoice}
            onChangeReply={(accountId, on) =>
              setReplyChoice((prev) => ({ ...prev, [accountId]: on }))
            }
            completing={completing}
            onChangeMode={setScheduleMode}
            onChangeScheduledAt={setScheduledAt}
            onPrev={() => setStep(4)}
            onComplete={handleComplete}
            draftButton={draftButton}
          />
        )}
      </section>

      <WizardSummary
        className="lg:col-span-2 xl:col-span-1"
        step={step}
        internalTitle={internalTitle}
        selectedAccounts={selectedAccounts}
        mediaType={mediaType}
        fileCount={files.length}
        videoName={videoFile?.name ?? null}
        captions={captions}
        captionMode={captionMode}
        scheduleMode={scheduleMode}
        scheduledAt={scheduledAt}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 패널 본문 · 아래 버튼 줄 (DESIGN.md 6장 카드 = 패널)
// ─────────────────────────────────────────────────────────────────────────────

function StepBody({ children }: { children: React.ReactNode }) {
  return <div className="space-y-5 p-4">{children}</div>;
}

function StepFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
      {children}
    </div>
  );
}

function FieldLabel({
  htmlFor,
  children,
  optional,
}: {
  htmlFor?: string;
  children: React.ReactNode;
  optional?: boolean;
}) {
  return (
    <Label htmlFor={htmlFor} className="text-[13px] font-semibold text-ink-2">
      {children}
      {optional && (
        <span className="text-xs font-normal text-faint">선택</span>
      )}
    </Label>
  );
}

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-input bg-card px-2.5 text-base sm:text-[13px]";

// ─────────────────────────────────────────────────────────────────────────────
// 오른쪽 요약 — 어느 단계에서든 고른 것을 확인한다
// ─────────────────────────────────────────────────────────────────────────────

// "2026-11-04T12:00" → "11월 4일 12:00". Date를 거치지 않아 시간대 · 하이드레이션 영향이 없다.
function formatLocalInput(v: string): string {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return v;
  return `${Number(m[2])}월 ${Number(m[3])}일 ${m[4]}:${m[5]}`;
}

function WizardSummary({
  className,
  step,
  internalTitle,
  selectedAccounts,
  mediaType,
  fileCount,
  videoName,
  captions,
  captionMode,
  scheduleMode,
  scheduledAt,
}: {
  className?: string;
  step: number;
  internalTitle: string;
  selectedAccounts: SocialAccountSummary[];
  mediaType: MediaType;
  fileCount: number;
  videoName: string | null;
  captions: Captions | null;
  captionMode: CaptionMode;
  scheduleMode: ScheduleMode;
  scheduledAt: string;
}) {
  const captionPlatforms = captions
    ? [captions.youtube, captions.instagram, captions.tiktok].filter(Boolean)
        .length
    : 0;
  const rows: Array<{ label: string; value: React.ReactNode }> = [
    {
      label: "이름",
      value: internalTitle.trim() || <span className="text-faint">없음</span>,
    },
    {
      label: "계정",
      value:
        selectedAccounts.length > 0 ? (
          <ul className="space-y-1">
            {selectedAccounts.map((a) => (
              <li key={a.id} className="flex min-w-0 items-center gap-1.5">
                <PlatformIcon platform={a.platform} size={16} />
                <span className="truncate">{a.display_name ?? "(이름 없음)"}</span>
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-faint">고르지 않았어요</span>
        ),
    },
    {
      label: "올릴 것",
      value:
        mediaType === "IMAGE" ? (
          fileCount > 0 ? (
            `사진 ${fileCount}장`
          ) : (
            <span className="text-faint">사진 · 아직 없어요</span>
          )
        ) : videoName ? (
          <>
            영상 1개
            <span className="block truncate text-xs text-muted-foreground">
              {videoName}
            </span>
          </>
        ) : (
          <span className="text-faint">영상 · 아직 없어요</span>
        ),
    },
    {
      label: "캡션",
      value: captions ? (
        `${captionMode === "ai" ? "AI가 썼어요" : "직접 써요"} · 플랫폼 ${captionPlatforms}개`
      ) : (
        <span className="text-faint">아직 안 썼어요</span>
      ),
    },
    {
      label: "올릴 때",
      value:
        scheduleMode === "now" ? (
          "바로 올리기"
        ) : scheduledAt ? (
          `${formatLocalInput(scheduledAt)} 예약`
        ) : (
          <span className="text-faint">시각을 골라 주세요</span>
        ),
    },
  ];
  return (
    <aside
      aria-label="올릴 내용"
      className={cn(
        "min-w-0 rounded-lg border bg-card xl:sticky xl:top-[76px]",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3.5">
        <h3 className="text-[15px] font-semibold">올릴 내용</h3>
        <span className="text-xs text-muted-foreground tabular-nums">
          {step}/{STEPS.length}단계
        </span>
      </div>
      <div className="p-4">
        <dl className="grid grid-cols-[84px_minmax(0,1fr)] overflow-hidden rounded-lg border text-[13px]">
          {rows.map((r, i) => (
            <div key={r.label} className="contents">
              <dt
                className={cn(
                  "bg-surface-2 px-3 py-2.5 text-muted-foreground",
                  i < rows.length - 1 && "border-b",
                )}
              >
                {r.label}
              </dt>
              <dd
                className={cn(
                  "min-w-0 px-3 py-2.5",
                  i < rows.length - 1 && "border-b",
                )}
              >
                {r.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <p className="border-t px-4 py-3 text-xs text-muted-foreground">
        완료하면 배포 관리에서 계정마다 진행을 볼 수 있어요.
      </p>
    </aside>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 — 계정 선택
// ─────────────────────────────────────────────────────────────────────────────

// 계정 그룹 색 — 사용자가 고른 팔레트 값이라 토큰으로 바꾸지 않는다(DESIGN.md 2장 예외).
const GROUP_DOT_COLOR: Record<string, string> = {
  zinc: "bg-zinc-400",
  red: "bg-red-500",
  amber: "bg-amber-500",
  green: "bg-green-500",
  blue: "bg-blue-500",
  pink: "bg-pink-500",
  purple: "bg-purple-500",
};

function Step1Accounts({
  socialAccounts,
  accountGroups,
  selectedAccountIds,
  internalTitle,
  onChangeInternalTitle,
  onToggle,
  onSetSelection,
  onNext,
  canAdvance,
}: {
  socialAccounts: {
    id: string;
    platform: Platform;
    display_name: string | null;
    is_active: boolean;
    group_id: string | null;
  }[];
  accountGroups: { id: string; name: string; color: string }[];
  selectedAccountIds: string[];
  internalTitle: string;
  onChangeInternalTitle: (v: string) => void;
  onToggle: (id: string, checked: boolean) => void;
  onSetSelection: (ids: string[]) => void;
  onNext: () => void;
  canAdvance: boolean;
}) {
  // 그룹별로 묶기 (활성 계정만 선택 가능, 비활성도 회색 표시).
  const accountsByGroup = useMemo(() => {
    const m = new Map<string | null, typeof socialAccounts>();
    for (const acc of socialAccounts) {
      const list = m.get(acc.group_id) ?? [];
      list.push(acc);
      m.set(acc.group_id, list);
    }
    return m;
  }, [socialAccounts]);

  if (socialAccounts.length === 0) {
    return (
      <>
        <StepBody>
          <div className="rounded-lg border border-dashed bg-surface-2 p-8 text-center">
            <p className="text-sm font-medium">아직 연결한 계정이 없어요.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              먼저 올릴 플랫폼 계정을 연결해 주세요.
            </p>
            <Link
              href="/accounts"
              className={cn(buttonVariants({ size: "sm" }), "mt-4")}
            >
              계정 연동으로 가기
            </Link>
          </div>
        </StepBody>
        <StepFooter>
          <span />
          <Button onClick={onNext} disabled>
            다음: {STEPS[1].label}
          </Button>
        </StepFooter>
      </>
    );
  }

  function toggleGroup(accounts: typeof socialAccounts) {
    const eligible = accounts.filter((a) => a.is_active);
    if (eligible.length === 0) return;
    const accIds = eligible.map((a) => a.id);
    const allSelected = accIds.every((id) => selectedAccountIds.includes(id));
    if (allSelected) {
      onSetSelection(selectedAccountIds.filter((id) => !accIds.includes(id)));
    } else {
      const next = new Set(selectedAccountIds);
      for (const id of accIds) next.add(id);
      onSetSelection(Array.from(next));
    }
  }

  // 표시 순서: 그룹들 먼저(생성순) → 미지정.
  const sections: Array<{
    key: string;
    title: string;
    color: string;
    list: typeof socialAccounts;
    isUnassigned: boolean;
  }> = [
    ...accountGroups
      .map((g) => ({
        key: g.id,
        title: g.name,
        color: g.color,
        list: accountsByGroup.get(g.id) ?? [],
        isUnassigned: false,
      }))
      .filter((s) => s.list.length > 0),
  ];
  const unassigned = accountsByGroup.get(null) ?? [];
  if (unassigned.length > 0) {
    sections.push({
      key: "_unassigned",
      title: "그룹 미지정",
      color: "zinc",
      list: unassigned,
      isUnassigned: true,
    });
  }

  return (
    <>
      <StepBody>
        <div className="max-w-xl space-y-1.5">
          <FieldLabel htmlFor="internal-title" optional>
            구분용 이름
          </FieldLabel>
          <input
            id="internal-title"
            type="text"
            value={internalTitle}
            onChange={(e) => onChangeInternalTitle(e.target.value)}
            maxLength={200}
            placeholder="예) 한강 카페 1편"
            className="h-9 w-full rounded-md border border-input bg-card px-3 text-base sm:text-[13px]"
          />
          <p className="text-xs text-muted-foreground">
            보관함 · 배포 관리에서 찾을 때 쓰는 이름이에요. 게시물에는 보이지 않아요.
          </p>
        </div>

        {/* 아주 넓은 화면에선 그룹을 두 줄로 나란히 (시안 8 — 계정 고르기 카드) */}
        <div className="grid items-start gap-3 2xl:grid-cols-2">
          {sections.map((section) => {
            const eligible = section.list.filter((a) => a.is_active);
            const selectedInGroup = eligible.filter((a) =>
              selectedAccountIds.includes(a.id),
            );
            const allSelected =
              eligible.length > 0 && selectedInGroup.length === eligible.length;
            const partial = selectedInGroup.length > 0 && !allSelected;
            const dot = GROUP_DOT_COLOR[section.color] ?? GROUP_DOT_COLOR.zinc;
            return (
              <div
                key={section.key}
                className={cn(
                  "overflow-hidden rounded-lg border bg-card",
                  section.isUnassigned && "border-dashed",
                )}
              >
                {/* 그룹 머리 — 누르면 이 그룹 전체 선택/해제 */}
                <button
                  type="button"
                  onClick={() => toggleGroup(section.list)}
                  disabled={eligible.length === 0}
                  className={cn(
                    "flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors",
                    eligible.length === 0
                      ? "cursor-not-allowed opacity-60"
                      : "hover:bg-surface-2",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = partial;
                    }}
                    readOnly
                    tabIndex={-1}
                    aria-hidden
                    disabled={eligible.length === 0}
                    className="pointer-events-none size-4 accent-primary"
                  />
                  <span className={cn("size-2.5 shrink-0 rounded-[3px]", dot)} />
                  <span className="flex-1 text-[13px] font-semibold">
                    {section.title}
                    <span className="ml-1.5 text-xs font-medium text-muted-foreground tabular-nums">
                      {selectedInGroup.length}/{eligible.length}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {allSelected ? "모두 빼기" : "모두 고르기"}
                  </span>
                </button>

                {/* 계정 카드 — 누르면 선택, 고른 카드는 파란 테두리 + ✓ */}
                <ul className="grid gap-2 border-t p-3 sm:grid-cols-2">
                  {section.list.map((acc) => {
                    const checked = selectedAccountIds.includes(acc.id);
                    const disabled = !acc.is_active;
                    return (
                      <li key={acc.id} className="min-w-0">
                        <label
                          className={cn(
                            "relative flex min-w-0 items-center gap-2.5 rounded-md border px-3 py-2.5 transition focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary",
                            checked
                              ? "border-primary bg-brand-soft pr-10 ring-1 ring-inset ring-primary"
                              : "border-input bg-card",
                            disabled
                              ? "cursor-not-allowed opacity-55"
                              : "cursor-pointer hover:bg-surface-2",
                            checked && !disabled && "hover:bg-brand-soft",
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={disabled}
                            onChange={(e) => onToggle(acc.id, e.target.checked)}
                            className="sr-only"
                          />
                          <PlatformIcon platform={acc.platform} size={20} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[13px] font-semibold leading-tight">
                              {acc.display_name ?? "(이름 없음)"}
                            </p>
                            <p
                              className={cn(
                                "mt-0.5 text-xs leading-tight",
                                disabled ? "text-risk" : "text-muted-foreground",
                              )}
                            >
                              {disabled
                                ? "연결이 끊겼어요 · 계정 연동에서 다시 연결"
                                : PLATFORM_LABEL[acc.platform]}
                            </p>
                          </div>
                          {checked && (
                            <span
                              aria-hidden
                              className="absolute right-3 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-full bg-primary text-primary-foreground"
                            >
                              <Check className="size-3" />
                            </span>
                          )}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      </StepBody>
      <StepFooter>
        <span className="text-xs text-muted-foreground">
          연결이 끊긴 계정은 고를 수 없어요.
        </span>
        <Button onClick={onNext} disabled={!canAdvance}>
          다음: {STEPS[1].label}
        </Button>
      </StepFooter>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 — 미디어 업로드 + 검증
// ─────────────────────────────────────────────────────────────────────────────

function Step2Media({
  mediaType,
  files,
  videoFile,
  uploading,
  validation,
  selectedPlatforms,
  includesTiktok,
  coverSeconds,
  onChangeCover,
  onSwitchType,
  onChangeFiles,
  onChangeVideo,
  onPrev,
  onNext,
  canAdvance,
  usingResumedMedia,
}: {
  mediaType: MediaType;
  files: File[];
  videoFile: File | null;
  uploading: boolean;
  validation: ValidationResult | null;
  selectedPlatforms: Platform[];
  includesTiktok: boolean;
  coverSeconds: number | null;
  onChangeCover: (seconds: number, blob: Blob | null) => void;
  onSwitchType: (t: MediaType) => void;
  onChangeFiles: (f: File[]) => void;
  onChangeVideo: (f: File | null) => void;
  onPrev: () => void;
  onNext: () => void;
  canAdvance: boolean;
  usingResumedMedia: boolean;
}) {
  return (
    <>
      <StepBody>
        {usingResumedMedia && (
          <div className="flex gap-2.5 rounded-lg bg-brand-soft px-3.5 py-3 text-[13px] text-ink-2">
            <Info className="mt-0.5 size-4 shrink-0 text-primary" />
            <p>
              임시 저장한 {mediaType === "IMAGE" ? "사진" : "영상"}이 이미 올라가 있어요. 그대로
              쓰려면 다음으로 넘어가세요. 새로 고르면 캡션을 다시 써야 해요.
            </p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Segmented<MediaType>
            ariaLabel="올릴 것"
            value={mediaType}
            onChange={onSwitchType}
            disabled={uploading}
            options={[
              { value: "IMAGE", label: "사진 1~10장", disabled: includesTiktok },
              { value: "VIDEO", label: "영상 1개" },
            ]}
          />
          {includesTiktok && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Info className="size-3.5 shrink-0" />
              틱톡 계정이 있어서 영상만 올릴 수 있어요 (틱톡은 사진 게시를 지원하지 않아요)
            </span>
          )}
        </div>
        {mediaType === "IMAGE" ? (
          <ImageDropzone onChange={onChangeFiles} initialFiles={files} />
        ) : (
          <VideoDropzone
            onChange={onChangeVideo}
            initialFile={videoFile}
            coverSeconds={coverSeconds}
            onCoverChange={onChangeCover}
          />
        )}
        {validation && (
          <ValidationPanel
            validation={validation}
            selectedPlatforms={selectedPlatforms}
          />
        )}
      </StepBody>
      <StepFooter>
        <Button variant="outline" onClick={onPrev} disabled={uploading}>
          이전
        </Button>
        <Button onClick={onNext} disabled={!canAdvance || uploading}>
          {uploading
            ? mediaType === "VIDEO"
              ? "영상 올리는 중…"
              : `사진 올리는 중… (${files.length}장)`
            : `다음: ${STEPS[2].label}`}
        </Button>
      </StepFooter>
    </>
  );
}

const VERDICT_BADGE: Record<
  PlatformVerdict["status"],
  { variant: "ok" | "warn" | "destructive"; label: string }
> = {
  ok: { variant: "ok", label: "올릴 수 있어요" },
  warning: { variant: "warn", label: "확인 필요" },
  blocked: { variant: "destructive", label: "올릴 수 없어요" },
};

function VerdictBadge({ status }: { status: PlatformVerdict["status"] }) {
  const b = VERDICT_BADGE[status];
  return (
    <Badge variant={b.variant}>
      {status === "ok" ? (
        <CircleCheck />
      ) : status === "warning" ? (
        <AlertTriangle />
      ) : (
        <OctagonAlert />
      )}
      {b.label}
    </Badge>
  );
}

function ValidationPanel({
  validation,
  selectedPlatforms,
}: {
  validation: ValidationResult;
  selectedPlatforms: Platform[];
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-[13px] font-semibold text-ink-2">
        계정마다 올릴 수 있는지
      </p>
      <ul className="overflow-hidden rounded-lg border">
        {selectedPlatforms.map((p) => {
          const v = validation.perPlatform.find((x) => x.platform === p);
          if (!v) return null;
          return <PlatformVerdictRow key={p} verdict={v} />;
        })}
      </ul>
    </div>
  );
}

function PlatformVerdictRow({ verdict }: { verdict: PlatformVerdict }) {
  return (
    <li
      className={cn(
        "flex flex-col gap-2 border-b px-3.5 py-2.5 last:border-b-0 sm:flex-row sm:items-start sm:gap-3",
        verdict.status === "blocked" && "bg-risk-soft",
      )}
    >
      <div className="flex shrink-0 items-center gap-2 sm:w-40 sm:pt-0.5">
        <PlatformIcon platform={verdict.platform} size={20} />
        <span className="text-[13px] font-semibold">
          {PLATFORM_LABEL[verdict.platform]}
        </span>
      </div>
      <VerdictBadge status={verdict.status} />
      {verdict.issues.length > 0 && (
        <ul className="min-w-0 flex-1 space-y-0.5 text-xs sm:pt-1">
          {verdict.issues.map((iss, i) => (
            <li
              key={i}
              className={iss.severity === "error" ? "text-risk" : "text-ink-2"}
            >
              {iss.message}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3 — 캡션 작성
// ─────────────────────────────────────────────────────────────────────────────

function Step3Caption({
  captions,
  contentId,
  savedAt,
  thumbnailUrls,
  description,
  presetId,
  presets,
  selectedPreset,
  generating,
  captionMode,
  onSwitchMode,
  onChangeDescription,
  onChangePreset,
  onGenerate,
  onStartManual,
  onRegenerate,
  onCaptionsSaved,
  onSavedAtChange,
  captionRef,
  onPrev,
  onNext,
  canAdvance,
  draftButton,
}: {
  captions: Captions | null;
  contentId: string | null;
  savedAt: string | null;
  thumbnailUrls: string[];
  description: string;
  presetId: string;
  presets: PresetSummary[];
  selectedPreset: PresetSummary | undefined;
  generating: boolean;
  captionMode: CaptionMode;
  onSwitchMode: (m: CaptionMode) => void;
  onChangeDescription: (v: string) => void;
  onChangePreset: (v: string) => void;
  onGenerate: () => void;
  onStartManual: () => void;
  onRegenerate: () => void;
  onCaptionsSaved: (captions: Captions) => void;
  onSavedAtChange: (savedAt: string) => void;
  captionRef: React.RefObject<CaptionResultHandle | null>;
  onPrev: () => void;
  onNext: () => void;
  canAdvance: boolean;
  draftButton: React.ReactNode;
}) {
  return (
    <>
      <StepBody>
        <div className="flex flex-wrap items-center gap-3">
          <Segmented<CaptionMode>
            ariaLabel="캡션 쓰는 방법"
            value={captionMode}
            onChange={onSwitchMode}
            disabled={generating}
            options={[
              {
                value: "ai",
                label: (
                  <>
                    <Sparkles /> AI로 쓰기
                  </>
                ),
              },
              {
                value: "manual",
                label: (
                  <>
                    <Pencil /> 직접 쓰기
                  </>
                ),
              },
            ]}
          />
          {captions && (
            <span className="text-xs text-muted-foreground">
              방법을 바꾸면 지금 쓴 캡션이 지워져요
            </span>
          )}
        </div>

        {!captions ? (
          captionMode === "ai" ? (
            <div className="space-y-4 rounded-lg border bg-surface-2 p-4">
              <div
                className={cn(
                  "grid gap-4",
                  presets.length > 0 && "md:grid-cols-2",
                )}
              >
                {presets.length > 0 && (
                  <div className="space-y-1.5">
                    <FieldLabel htmlFor="preset" optional>
                      AI 프리셋
                    </FieldLabel>
                    <select
                      id="preset"
                      value={presetId}
                      onChange={(e) => onChangePreset(e.target.value)}
                      disabled={generating}
                      className={SELECT_CLASS}
                    >
                      <option value="">사용 안 함</option>
                      {presets.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    {selectedPreset?.description && (
                      <p className="text-xs text-muted-foreground">
                        {selectedPreset.description}
                      </p>
                    )}
                  </div>
                )}
                <div className="space-y-1.5">
                  <FieldLabel htmlFor="description" optional>
                    어떤 내용인지
                  </FieldLabel>
                  <Textarea
                    id="description"
                    value={description}
                    onChange={(e) => onChangeDescription(e.target.value)}
                    placeholder="예) 홍대 브런치 카페 후기, 따뜻하고 일상적인 말투로"
                    rows={2}
                    disabled={generating}
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  사진 · 영상과 설명을 보고 플랫폼마다 따로 써요.
                </p>
                <Button onClick={onGenerate} disabled={generating}>
                  <Sparkles className="size-4" />
                  {generating ? "캡션 쓰는 중…" : "캡션 만들기"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-brand-soft px-3.5 py-3">
              <p className="flex gap-2.5 text-[13px] text-ink-2">
                <Info className="mt-0.5 size-4 shrink-0 text-primary" />
                빈 캡션으로 시작해 플랫폼마다 직접 써요. 중간에 멈추려면 아래
                &lsquo;임시 저장&rsquo;을 누르세요 — 보관함에서 이어서 할 수 있어요.
              </p>
              <Button onClick={onStartManual} disabled={generating}>
                <Pencil className="size-4" />
                {generating ? "준비 중…" : "직접 쓰기 시작"}
              </Button>
            </div>
          )
        ) : (
          contentId &&
          savedAt && (
            <div className="space-y-3">
              {captionMode === "ai" && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Badge>
                    <Sparkles />
                    AI가 썼어요
                  </Badge>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onRegenerate}
                    disabled={generating}
                  >
                    <RefreshCw className={cn(generating && "animate-spin")} />
                    {generating ? "다시 쓰는 중…" : "다른 스타일로 다시 쓰기"}
                  </Button>
                </div>
              )}
              <CaptionResult
                ref={captionRef}
                contentId={contentId}
                captions={captions}
                savedAt={savedAt}
                thumbnails={thumbnailUrls}
                initialEditing={captionMode === "manual"}
                onSaved={(c, at) => {
                  onCaptionsSaved(c);
                  onSavedAtChange(at);
                }}
              />
            </div>
          )
        )}
      </StepBody>
      <StepFooter>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={onPrev} disabled={generating}>
            이전
          </Button>
          {draftButton}
        </div>
        <Button onClick={onNext} disabled={!canAdvance}>
          다음: {STEPS[3].label}
        </Button>
      </StepFooter>
    </>
  );
}

interface PresetSummary {
  id: string;
  name: string;
  description: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4 — 미리 보기
// ─────────────────────────────────────────────────────────────────────────────

function Step4Review({
  selectedAccounts,
  selectedPlatforms,
  captions,
  validation,
  mediaType,
  mediaCount,
  thumbnailUrl,
  onJump,
  onPrev,
  onNext,
  canAdvance,
  draftButton,
}: {
  selectedAccounts: {
    id: string;
    platform: Platform;
    display_name: string | null;
  }[];
  selectedPlatforms: Platform[];
  captions: Captions | null;
  validation: ValidationResult | null;
  mediaType: MediaType;
  mediaCount: number;
  thumbnailUrl: string | null;
  onJump: (step: number) => void;
  onPrev: () => void;
  onNext: () => void;
  canAdvance: boolean;
  draftButton: React.ReactNode;
}) {
  const verdicts = validation?.perPlatform ?? [];
  const blocked = verdicts.filter((v) => v.status === "blocked").length;
  const warned = verdicts.filter((v) => v.status === "warning").length;
  const captionCount = captions
    ? [captions.youtube, captions.instagram, captions.tiktok].filter(Boolean)
        .length
    : 0;
  return (
    <>
      <StepBody>
        <div className="flex flex-wrap items-center gap-1.5">
          {blocked > 0 ? (
            <Badge variant="destructive">
              <OctagonAlert />
              올릴 수 없는 플랫폼 {blocked}개
            </Badge>
          ) : warned > 0 ? (
            <Badge variant="warn">
              <AlertTriangle />
              확인 필요 {warned}개
            </Badge>
          ) : (
            <Badge variant="ok">
              <CircleCheck />
              미디어 규격 맞아요
            </Badge>
          )}
          {captions ? (
            <Badge variant="ok">
              <CircleCheck />
              캡션 {captionCount}개 플랫폼 썼어요
            </Badge>
          ) : (
            <Badge variant="destructive">
              <OctagonAlert />
              캡션을 아직 안 썼어요
            </Badge>
          )}
          <span className="ml-auto flex gap-1">
            <Button variant="ghost" size="sm" onClick={() => onJump(1)}>
              계정 바꾸기
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onJump(2)}>
              {mediaType === "IMAGE" ? "사진" : "영상"} 바꾸기
            </Button>
          </span>
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-[repeat(auto-fill,200px)]">
          {selectedPlatforms.map((p) => (
            <PreviewCard
              key={p}
              platform={p}
              accounts={selectedAccounts.filter((a) => a.platform === p)}
              captions={captions}
              verdict={verdicts.find((v) => v.platform === p)}
              mediaType={mediaType}
              mediaCount={mediaCount}
              thumbnailUrl={thumbnailUrl}
              onEdit={() => onJump(3)}
            />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          실제 앱 화면과 줄바꿈 · 잘리는 위치가 조금 다를 수 있어요.
        </p>

        {!canAdvance && (
          <div className="flex gap-2.5 rounded-lg bg-warn-soft px-3.5 py-3 text-[13px] text-ink-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
            <p>
              올릴 수 없는 항목이 있어요. 위 버튼으로 해당 단계로 돌아가 고쳐
              주세요.
            </p>
          </div>
        )}
      </StepBody>
      <StepFooter>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={onPrev}>
            이전
          </Button>
          {draftButton}
        </div>
        <Button onClick={onNext} disabled={!canAdvance}>
          다음: {STEPS[4].label}
        </Button>
      </StepFooter>
    </>
  );
}

function PreviewCard({
  platform,
  accounts,
  captions,
  verdict,
  mediaType,
  mediaCount,
  thumbnailUrl,
  onEdit,
}: {
  platform: Platform;
  accounts: { id: string; display_name: string | null }[];
  captions: Captions | null;
  verdict: PlatformVerdict | undefined;
  mediaType: MediaType;
  mediaCount: number;
  thumbnailUrl: string | null;
  onEdit: () => void;
}) {
  const text =
    platform === "YOUTUBE"
      ? captions?.youtube?.title
      : platform === "INSTAGRAM"
        ? captions?.instagram?.caption
        : captions?.tiktok?.caption;
  const firstLine = (text ?? "").split("\n")[0];
  const who = accounts[0]?.display_name ?? "";
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div
        className={cn(
          "relative overflow-hidden rounded-lg border bg-surface-2",
          mediaType === "VIDEO" ? "aspect-[9/16]" : "aspect-[4/5]",
        )}
      >
        {thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumbnailUrl} alt="" className="size-full object-cover" />
        ) : (
          <div className="grid size-full place-items-center text-faint">
            <ImageIcon className="size-8" />
          </div>
        )}
        {mediaType === "IMAGE" && mediaCount > 1 && (
          <span className="absolute top-2 right-2 rounded-md bg-card px-1.5 text-xs font-semibold tabular-nums">
            1 / {mediaCount}
          </span>
        )}
        {/* 캡션 미리보기: 어두운 미리보기 위 흰 글자 (DESIGN.md 2장 예외) */}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-3 pt-10 text-xs text-white">
          <p className="truncate font-semibold">
            {who}
            {accounts.length > 1 && ` 외 ${accounts.length - 1}개`}
          </p>
          {firstLine && (
            <p
              className={cn(
                "mt-0.5 line-clamp-3",
                platform === "YOUTUBE" && "font-semibold",
              )}
            >
              {firstLine}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between gap-1">
        <span className="flex min-w-0 items-center gap-1.5 text-xs">
          <PlatformIcon platform={platform} size={16} />
          <b className="truncate">{PLATFORM_LABEL[platform]}</b>
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {accounts.length}개 계정
          </span>
        </span>
        <Button variant="ghost" size="sm" onClick={onEdit} className="shrink-0 px-2">
          <Pencil />
          고치기
        </Button>
      </div>
      {verdict && verdict.status !== "ok" && (
        <VerdictBadge status={verdict.status} />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 5 — 올릴 시각
// ─────────────────────────────────────────────────────────────────────────────

// 자주 쓰는 시각 — 편성 칸(08 · 12 · 18 · 21시)과 같은 시각. 늘 미래가 되도록 내일만 둔다.
const QUICK_TIMES = [8, 12, 18, 21] as const;

function tomorrowAt(hour: number): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hour)}:00`;
}

function Step5Schedule({
  scheduleMode,
  scheduledAt,
  selectedAccountCount,
  hasTikTok,
  seriesRows,
  seriesChoice,
  onChangeSeries,
  replyChoice,
  onChangeReply,
  completing,
  onChangeMode,
  onChangeScheduledAt,
  onPrev,
  onComplete,
  draftButton,
}: {
  scheduleMode: ScheduleMode;
  scheduledAt: string;
  selectedAccountCount: number;
  // 틱톡은 앱 심사 전이라 '나만 보기'로만 올라간다(lib/platforms/tiktok.ts privacy_level SELF_ONLY)
  hasTikTok: boolean;
  seriesRows: { account: SocialAccountSummary; options: SeriesOption[] }[];
  seriesChoice: Record<string, string>;
  onChangeSeries: (accountId: string, seriesId: string) => void;
  replyChoice: Record<string, boolean>;
  onChangeReply: (accountId: string, on: boolean) => void;
  completing: boolean;
  onChangeMode: (m: ScheduleMode) => void;
  onChangeScheduledAt: (v: string) => void;
  onPrev: () => void;
  onComplete: () => void;
  draftButton: React.ReactNode;
}) {
  // 누른 빠른 시각 — 날짜를 직접 바꾸면 해제한다. (값 비교에 현재 시각이 필요 없게 따로 기억)
  const [quickHour, setQuickHour] = useState<number | null>(null);
  // 고른 시각이 이미 지났는지 — 고를 때(이벤트) 계산해 둔다
  const [pastPicked, setPastPicked] = useState(false);
  // 예약을 골랐는데 시각이 비어 있으면 완료를 막는다 — 비어 있으면 바로 올라가 버린다.
  const missingTime = scheduleMode === "scheduled" && !scheduledAt;
  return (
    <>
      <StepBody>
        <Segmented<ScheduleMode>
          ariaLabel="올릴 때"
          value={scheduleMode}
          onChange={onChangeMode}
          disabled={completing}
          options={[
            { value: "now", label: "바로 올리기" },
            { value: "scheduled", label: "시각 정해서 올리기" },
          ]}
        />

        {scheduleMode === "scheduled" ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <p className="text-[13px] font-semibold text-ink-2">
                자주 쓰는 시각
              </p>
              <div className="flex flex-wrap gap-1.5">
                {QUICK_TIMES.map((h) => {
                  const on = quickHour === h && !!scheduledAt;
                  return (
                    <Button
                      key={h}
                      variant="outline"
                      size="sm"
                      aria-pressed={on}
                      disabled={completing}
                      onClick={() => {
                        setQuickHour(h);
                        setPastPicked(false);
                        onChangeScheduledAt(tomorrowAt(h));
                      }}
                      className={cn(
                        "tabular-nums",
                        on &&
                          "border-primary bg-brand-soft font-semibold text-primary hover:bg-brand-soft",
                      )}
                    >
                      내일 {String(h).padStart(2, "0")}:00
                    </Button>
                  );
                })}
              </div>
            </div>
            <div className="max-w-xs space-y-1.5">
              <FieldLabel htmlFor="scheduled-at">날짜 · 시각</FieldLabel>
              <input
                id="scheduled-at"
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => {
                  setQuickHour(null);
                  setPastPicked(!!e.target.value && Date.parse(e.target.value) < Date.now());
                  onChangeScheduledAt(e.target.value);
                }}
                disabled={completing}
                className="h-9 w-full rounded-md border border-input bg-card px-3 text-base sm:text-[13px]"
              />
              {missingTime && (
                <p className="text-xs text-risk">
                  날짜와 시각을 골라 주세요. 바로 올리려면 &lsquo;바로 올리기&rsquo;를 고르세요.
                </p>
              )}
              {!missingTime && pastPicked && (
                <p className="text-xs text-risk">이미 지난 시각이에요. 앞으로의 시각을 골라 주세요.</p>
              )}
            </div>
          </div>
        ) : (
          <div className="flex gap-2.5 rounded-lg bg-brand-soft px-3.5 py-3 text-[13px] text-ink-2">
            <Send className="mt-0.5 size-4 shrink-0 text-primary" />
            <p>완료를 누르면 곧 올리기 시작해요. 진행은 배포 관리에서 볼 수 있어요.</p>
          </div>
        )}

        {hasTikTok && (
          <div className="flex gap-2.5 rounded-lg border border-warn/40 bg-warn-soft px-3.5 py-3 text-[13px] text-ink-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
            <p>
              틱톡은 지금 <b>&lsquo;나만 보기&rsquo;</b>로 올라가요. 틱톡 앱 심사를 마치기 전이라 공개로 올릴 수 없어요. 올라간 뒤 틱톡 앱에서 공개로 바꿔 주세요.
            </p>
          </div>
        )}

        {seriesRows.length > 0 && (
          <div className="space-y-3 rounded-lg border p-4">
            <div>
              <p className="text-[13px] font-semibold text-ink-2">
                시리즈 다음 화로 올리기{" "}
                <span className="text-xs font-normal text-faint">선택</span>
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                시리즈의 다음 화라면 골라 주세요. 회차로 추가되고, 답글은 꺼진 상태로 시작해요.
              </p>
            </div>
            <ul className="space-y-3">
              {seriesRows.map(({ account, options }) => {
                const chosen = options.find(
                  (o) => o.id === seriesChoice[account.id],
                );
                return (
                  <li key={account.id} className="space-y-2">
                    <div className="grid items-center gap-2 sm:grid-cols-[180px_minmax(0,1fr)]">
                      <span className="flex min-w-0 items-center gap-2 text-[13px] font-semibold">
                        <PlatformIcon platform="INSTAGRAM" size={16} />
                        <span className="truncate">
                          @{account.display_name ?? "(이름 없음)"}
                        </span>
                      </span>
                      <select
                        id={`series-choice-${account.id}`}
                        aria-label={`@${account.display_name ?? ""} 시리즈`}
                        value={seriesChoice[account.id] ?? ""}
                        onChange={(e) =>
                          onChangeSeries(account.id, e.target.value)
                        }
                        className={SELECT_CLASS}
                      >
                        <option value="">시리즈 아님</option>
                        {options.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name} · {o.nextEpisodeNo}화{o.pendingCount > 0 ? ` (예약 ${o.pendingCount}개 다음)` : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                    {chosen && chosen.nextEpisodeNo > 1 && (
                      <label className="flex cursor-pointer items-start gap-2.5 rounded-md bg-surface-2 px-3 py-2 sm:ml-[188px]">
                        <input
                          type="checkbox"
                          id={`series-reply-${account.id}`}
                          checked={replyChoice[account.id] === true}
                          onChange={(e) =>
                            onChangeReply(account.id, e.target.checked)
                          }
                          className="mt-0.5 size-4 accent-primary"
                        />
                        <span className="min-w-0 text-[13px]">
                          올라가면 바로 {chosen.nextEpisodeNo - 1}화 댓글에 답글 달기
                          <span className="block text-xs text-muted-foreground">
                            꺼 두면 나중에 시리즈 댓글 자동화에서 켤 수 있어요.
                          </span>
                        </span>
                      </label>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </StepBody>
      <StepFooter>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={onPrev} disabled={completing}>
            이전
          </Button>
          {draftButton}
        </div>
        <Button onClick={onComplete} disabled={completing || missingTime || (scheduleMode === "scheduled" && pastPicked)}>
          {scheduleMode === "scheduled" ? <CalendarCheck /> : <Send />}
          {completing
            ? "등록 중…"
            : scheduleMode === "scheduled"
              ? `${selectedAccountCount}개 계정에 예약하기`
              : `${selectedAccountCount}개 계정에 바로 올리기`}
        </Button>
      </StepFooter>
    </>
  );
}
