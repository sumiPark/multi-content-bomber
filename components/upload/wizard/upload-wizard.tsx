"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Check,
  CircleAlert,
  Pencil,
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { PlatformIcon } from "@/components/ui/platform-icon";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  createBlankContentAction,
  createPublishJobsAction,
  generateCaptionsAction,
  regenerateCaptionsAction,
  type CreateBlankContentResult,
  type GenerateCaptionsResult,
  type RegenerateCaptionsResult,
} from "@/app/(dashboard)/actions";
import type { Captions } from "@/lib/ai/caption-generator";
import type { Platform } from "@/lib/platforms";
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
  { key: 1, label: "계정" },
  { key: 2, label: "미디어" },
  { key: 3, label: "캡션" },
  { key: 4, label: "검토" },
  { key: 5, label: "예약" },
];

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

interface UploadWizardProps {
  organizationId: string;
  userId: string;
  socialAccounts: SocialAccountSummary[];
  accountGroups: AccountGroupSummary[];
  presets: PresetSummary[];
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
}: UploadWizardProps) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [mediaType, setMediaType] = useState<MediaType>("IMAGE");
  const [files, setFiles] = useState<File[]>([]);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [mediaPaths, setMediaPaths] = useState<string[]>([]);
  const [analyzePaths, setAnalyzePaths] = useState<string[]>([]);
  const [mediaMetadata, setMediaMetadata] = useState<Record<string, unknown>>(
    {},
  );
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [uploading, setUploading] = useState(false);
  const [internalTitle, setInternalTitle] = useState("");
  const [presetId, setPresetId] = useState<string>("");
  const [description, setDescription] = useState("");
  const [generating, setGenerating] = useState(false);
  const [captions, setCaptions] = useState<Captions | null>(null);
  const [contentId, setContentId] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [thumbnailUrls, setThumbnailUrls] = useState<string[]>([]);
  const [captionMode, setCaptionMode] = useState<CaptionMode>("ai");
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>("now");
  const [scheduledAt, setScheduledAt] = useState("");
  const [completing, setCompleting] = useState(false);
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

  // TikTok이 포함되면 영상 모드 강제 (TikTok Content Posting API는 영상만 지원)
  useEffect(() => {
    if (includesTiktok && mediaType === "IMAGE") {
      setMediaType("VIDEO");
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
          setValidation(null);
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
          setValidation(null);
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
  }, [files, videoFile, mediaType, selectedPlatforms]);

  const canAdvanceStep1 = selectedAccountIds.length > 0;

  const canAdvanceStep2 = useMemo(() => {
    if (mediaType === "IMAGE" && files.length === 0) return false;
    if (mediaType === "VIDEO" && !videoFile) return false;
    return validation?.ok ?? false;
  }, [mediaType, files, videoFile, validation]);

  const canAdvanceStep3 = !!captions;

  const canAdvanceStep4 =
    !!captions &&
    selectedAccountIds.length > 0 &&
    (validation?.ok ?? false);

  function switchMediaType(next: MediaType) {
    if (mediaType === next) return;
    setMediaType(next);
    setFiles([]);
    setVideoFile(null);
    setMediaPaths([]);
    setAnalyzePaths([]);
    setMediaMetadata({});
    setError(null);
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

  async function advanceFromStep2() {
    setError(null);
    if (!canAdvanceStep2) return;
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
        setMediaMetadata({
          thumbnail_path: thumbUpload.path,
          duration_seconds: frame.durationSeconds,
          width: frame.width,
          height: frame.height,
          original_size_bytes: videoFile.size,
          original_mime: videoFile.type,
        });
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
    setCompleting(true);
    const scheduledFor =
      scheduleMode === "scheduled" && scheduledAt
        ? new Date(scheduledAt).toISOString()
        : null;
    const result = await createPublishJobsAction({
      contentId,
      accountIds: selectedAccountIds,
      scheduledFor,
    });
    setCompleting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.push(`/?content=${contentId}`);
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <CardTitle>콘텐츠 생성</CardTitle>
            <CardDescription>
              5단계로 계정 선택, 미디어 업로드, 캡션 작성, 검토, 예약을 진행합니다.
            </CardDescription>
          </div>
        </div>
        <div className="mt-3 space-y-1">
          <Label htmlFor="internal-title" className="text-xs">
            내부 타이틀 (선택)
          </Label>
          <input
            id="internal-title"
            type="text"
            value={internalTitle}
            onChange={(e) => setInternalTitle(e.target.value)}
            maxLength={200}
            placeholder="예) 한강 카페 1편 — 보관함/포스팅 관리에서 식별용 라벨"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
        <div className="pt-4">
          <StepIndicator current={step} steps={STEPS} />
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {error && (
          <div className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            <CircleAlert className="size-4 shrink-0" />
            <p>{error}</p>
          </div>
        )}

        {step === 1 && (
          <Step1Accounts
            socialAccounts={socialAccounts}
            accountGroups={accountGroups}
            selectedAccountIds={selectedAccountIds}
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
            onSwitchType={switchMediaType}
            onChangeFiles={setFiles}
            onChangeVideo={setVideoFile}
            onPrev={() => setStep(1)}
            onNext={advanceFromStep2}
            canAdvance={canAdvanceStep2}
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
          />
        )}

        {step === 4 && (
          <Step4Review
            selectedAccounts={selectedAccounts}
            captions={captions}
            validation={validation}
            mediaType={mediaType}
            mediaCount={
              mediaType === "IMAGE" ? files.length : videoFile ? 1 : 0
            }
            onJump={setStep}
            onPrev={() => setStep(3)}
            onNext={() => setStep(5)}
            canAdvance={canAdvanceStep4}
          />
        )}

        {step === 5 && (
          <Step5Schedule
            scheduleMode={scheduleMode}
            scheduledAt={scheduledAt}
            selectedAccountCount={selectedAccountIds.length}
            completing={completing}
            onChangeMode={setScheduleMode}
            onChangeScheduledAt={setScheduledAt}
            onPrev={() => setStep(4)}
            onComplete={handleComplete}
          />
        )}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 — 계정 선택
// ─────────────────────────────────────────────────────────────────────────────

const GROUP_DOT_COLOR: Record<string, string> = {
  zinc: "bg-zinc-400",
  red: "bg-red-500",
  amber: "bg-amber-500",
  green: "bg-green-500",
  blue: "bg-blue-500",
  pink: "bg-pink-500",
  purple: "bg-purple-500",
};

const GROUP_BAR_COLOR: Record<string, string> = GROUP_DOT_COLOR;

function Step1Accounts({
  socialAccounts,
  accountGroups,
  selectedAccountIds,
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
      <div className="space-y-4">
        <div className="rounded-md border bg-muted/30 p-8 text-center">
          <p className="text-sm">아직 연동된 계정이 없어요.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            먼저 게시할 플랫폼 계정을 연결해주세요.
          </p>
          <Link
            href="/accounts"
            className={cn(buttonVariants({ size: "sm" }), "mt-4")}
          >
            계정 관리로 이동
          </Link>
        </div>
      </div>
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
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        그룹 헤더의 체크박스로 한 번에 선택하거나, 개별 계정을 직접 체크할 수 있어요.
      </p>

      <div className="space-y-3">
        {sections.map((section) => {
          const eligible = section.list.filter((a) => a.is_active);
          const selectedInGroup = eligible.filter((a) =>
            selectedAccountIds.includes(a.id),
          );
          const allSelected =
            eligible.length > 0 && selectedInGroup.length === eligible.length;
          const partial =
            selectedInGroup.length > 0 && !allSelected;
          const bar = GROUP_BAR_COLOR[section.color] ?? GROUP_BAR_COLOR.zinc;
          return (
            <div
              key={section.key}
              className={cn(
                "relative overflow-hidden rounded-md border",
                section.isUnassigned && "border-dashed",
              )}
            >
              <div className={cn("absolute inset-y-0 left-0 w-1", bar)} />
              {/* Section header — 클릭으로 전체 토글 */}
              <button
                type="button"
                onClick={() => toggleGroup(section.list)}
                disabled={eligible.length === 0}
                className={cn(
                  "flex w-full items-center gap-3 px-4 py-2.5 text-left transition",
                  eligible.length === 0
                    ? "cursor-not-allowed opacity-60"
                    : "hover:bg-accent/30",
                )}
              >
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = partial;
                  }}
                  readOnly
                  disabled={eligible.length === 0}
                  className="size-4 pointer-events-none"
                />
                <p className="flex-1 text-sm font-semibold">
                  {section.title}
                  <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                    {selectedInGroup.length}/{eligible.length}
                  </span>
                </p>
              </button>

              {/* Account rows */}
              <ul className="space-y-1 border-t bg-muted/10 px-3 py-2">
                {section.list.map((acc) => {
                  const checked = selectedAccountIds.includes(acc.id);
                  const disabled = !acc.is_active;
                  return (
                    <li key={acc.id}>
                      <label
                        className={cn(
                          "flex items-center gap-2.5 rounded px-2 py-1.5 text-sm transition",
                          disabled
                            ? "cursor-not-allowed opacity-50"
                            : "cursor-pointer hover:bg-accent/40",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={disabled}
                          onChange={(e) =>
                            onToggle(acc.id, e.target.checked)
                          }
                          className="size-4"
                        />
                        <PlatformIcon platform={acc.platform} size={20} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium leading-tight">
                            {acc.display_name ?? "(이름 없음)"}
                          </p>
                          <p className="text-[10px] leading-tight text-muted-foreground">
                            {acc.platform}
                          </p>
                        </div>
                        {disabled && (
                          <Badge
                            variant="destructive"
                            className="text-[10px]"
                          >
                            비활성
                          </Badge>
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

      <div className="flex justify-end">
        <Button onClick={onNext} disabled={!canAdvance}>
          다음 단계 ({selectedAccountIds.length}개 선택)
        </Button>
      </div>
    </div>
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
  onSwitchType,
  onChangeFiles,
  onChangeVideo,
  onPrev,
  onNext,
  canAdvance,
}: {
  mediaType: MediaType;
  files: File[];
  videoFile: File | null;
  uploading: boolean;
  validation: ValidationResult | null;
  selectedPlatforms: Platform[];
  includesTiktok: boolean;
  onSwitchType: (t: MediaType) => void;
  onChangeFiles: (f: File[]) => void;
  onChangeVideo: (f: File | null) => void;
  onPrev: () => void;
  onNext: () => void;
  canAdvance: boolean;
}) {
  return (
    <div className="space-y-4">
      {includesTiktok && (
        <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700">
          <CircleAlert className="size-4 shrink-0" />
          <p>
            TikTok 계정이 포함되어 있어 <strong>영상만 업로드 가능</strong>해요.
            (Content Posting API는 이미지 게시를 지원하지 않습니다.)
          </p>
        </div>
      )}
      <div className="flex gap-2">
        <Button
          variant={mediaType === "IMAGE" ? "default" : "outline"}
          onClick={() => onSwitchType("IMAGE")}
          disabled={uploading || includesTiktok}
          className="flex-1"
        >
          이미지 (1~10장)
        </Button>
        <Button
          variant={mediaType === "VIDEO" ? "default" : "outline"}
          onClick={() => onSwitchType("VIDEO")}
          disabled={uploading}
          className="flex-1"
        >
          영상 (1개)
        </Button>
      </div>
      {mediaType === "IMAGE" ? (
        <ImageDropzone onChange={onChangeFiles} />
      ) : (
        <VideoDropzone onChange={onChangeVideo} />
      )}
      {validation && (
        <ValidationPanel
          validation={validation}
          selectedPlatforms={selectedPlatforms}
        />
      )}
      <div className="flex justify-between">
        <Button variant="outline" onClick={onPrev} disabled={uploading}>
          이전
        </Button>
        <Button onClick={onNext} disabled={!canAdvance || uploading}>
          {uploading
            ? mediaType === "VIDEO"
              ? "업로드 + 프레임 추출 중..."
              : `업로드 중... (${files.length}장)`
            : mediaType === "VIDEO"
              ? "다음 단계"
              : `다음 단계 (${files.length}장)`}
        </Button>
      </div>
    </div>
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
    <div className="space-y-2 rounded-md border bg-muted/20 p-3">
      <p className="text-xs font-medium text-muted-foreground">
        플랫폼별 적합성
      </p>
      <ul className="space-y-2">
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
  const icon =
    verdict.status === "ok" ? (
      <Check className="size-4 text-green-600" />
    ) : verdict.status === "warning" ? (
      <AlertTriangle className="size-4 text-amber-600" />
    ) : (
      <CircleAlert className="size-4 text-destructive" />
    );
  return (
    <li className="space-y-1">
      <div className="flex items-center gap-2 text-sm">
        {icon}
        <span className="font-medium">{verdict.platform}</span>
        <Badge
          variant={
            verdict.status === "blocked" ? "destructive" : "outline"
          }
          className="text-[10px]"
        >
          {verdict.status === "ok"
            ? "적합"
            : verdict.status === "warning"
              ? "경고"
              : "게시 불가"}
        </Badge>
      </div>
      {verdict.issues.length > 0 && (
        <ul className="ml-6 space-y-0.5 text-xs text-muted-foreground">
          {verdict.issues.map((iss, i) => (
            <li key={i}>
              {iss.severity === "error" ? "❌" : "⚠️"} {iss.message}
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
}) {
  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Button
          variant={captionMode === "ai" ? "default" : "outline"}
          onClick={() => onSwitchMode("ai")}
          disabled={generating}
          className="flex-1"
        >
          <Sparkles className="size-4" /> AI 자동 생성
        </Button>
        <Button
          variant={captionMode === "manual" ? "default" : "outline"}
          onClick={() => onSwitchMode("manual")}
          disabled={generating}
          className="flex-1"
        >
          <Pencil className="size-4" /> 직접 작성
        </Button>
      </div>

      {!captions ? (
        captionMode === "ai" ? (
          <>
            {presets.length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="preset">캡션 프리셋 (선택)</Label>
                <select
                  id="preset"
                  value={presetId}
                  onChange={(e) => onChangePreset(e.target.value)}
                  disabled={generating}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                >
                  <option value="">— 사용 안 함 —</option>
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
            <div className="space-y-2">
              <Label htmlFor="description">기본 설명 (선택)</Label>
              <Textarea
                id="description"
                value={description}
                onChange={(e) => onChangeDescription(e.target.value)}
                placeholder="예) 홍대 브런치 카페 후기, 톤은 따뜻하고 일상적으로"
                rows={3}
                disabled={generating}
              />
              <p className="text-xs text-muted-foreground">
                설명을 입력하면 AI가 더 정확한 톤의 캡션을 생성합니다.
              </p>
            </div>
            <Button onClick={onGenerate} disabled={generating}>
              <Sparkles className="size-4" />
              {generating ? "AI 분석 중..." : "AI 캡션 생성"}
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              빈 캡션으로 시작해서 플랫폼별 탭에서 직접 작성합니다. 시작하면
              임시 콘텐츠가 보관함에 저장돼요.
            </p>
            <Button onClick={onStartManual} disabled={generating}>
              <Pencil className="size-4" />
              {generating ? "준비 중..." : "직접 작성 시작"}
            </Button>
          </>
        )
      ) : (
        contentId &&
        savedAt && (
          <>
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
            {captionMode === "ai" && (
              <Button
                variant="outline"
                size="sm"
                onClick={onRegenerate}
                disabled={generating}
              >
                <Sparkles className="size-4" />
                {generating ? "다른 스타일로 생성 중..." : "다시 생성 (다른 스타일)"}
              </Button>
            )}
          </>
        )
      )}
      <div className="flex justify-between">
        <Button variant="outline" onClick={onPrev} disabled={generating}>
          이전
        </Button>
        <Button onClick={onNext} disabled={!canAdvance}>
          다음 단계
        </Button>
      </div>
    </div>
  );
}

interface PresetSummary {
  id: string;
  name: string;
  description: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4 — 최종 검토
// ─────────────────────────────────────────────────────────────────────────────

function Step4Review({
  selectedAccounts,
  captions,
  validation,
  mediaType,
  mediaCount,
  onJump,
  onPrev,
  onNext,
  canAdvance,
}: {
  selectedAccounts: {
    id: string;
    platform: Platform;
    display_name: string | null;
  }[];
  captions: Captions | null;
  validation: ValidationResult | null;
  mediaType: MediaType;
  mediaCount: number;
  onJump: (step: number) => void;
  onPrev: () => void;
  onNext: () => void;
  canAdvance: boolean;
}) {
  return (
    <div className="space-y-4">
      <ReviewSection
        title="미디어"
        onEdit={() => onJump(2)}
        summary={
          mediaType === "IMAGE"
            ? `이미지 ${mediaCount}장`
            : `영상 1개`
        }
      />
      <ReviewSection
        title="계정"
        onEdit={() => onJump(1)}
        summary={`${selectedAccounts.length}개 계정 선택`}
      >
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
          {selectedAccounts.map((acc) => {
            const verdict = validation?.perPlatform.find(
              (v) => v.platform === acc.platform,
            );
            return (
              <li key={acc.id} className="flex items-center gap-2">
                <PlatformIcon platform={acc.platform} size={14} />
                <span>{acc.display_name ?? "(이름 없음)"}</span>
                <span>·</span>
                <span>{acc.platform}</span>
                {verdict && (
                  <Badge
                    variant={
                      verdict.status === "blocked"
                        ? "destructive"
                        : verdict.status === "warning"
                          ? "outline"
                          : "secondary"
                    }
                    className="ml-1 text-[10px]"
                  >
                    {verdict.status === "ok"
                      ? "✅"
                      : verdict.status === "warning"
                        ? "⚠️"
                        : "❌"}
                  </Badge>
                )}
              </li>
            );
          })}
        </ul>
      </ReviewSection>
      <ReviewSection
        title="캡션"
        onEdit={() => onJump(3)}
        summary={
          captions
            ? `${[
                captions.youtube && "YouTube",
                captions.instagram && "Instagram",
                captions.tiktok && "TikTok",
              ]
                .filter(Boolean)
                .join(", ")} 캡션 작성됨`
            : "캡션 미작성"
        }
      >
        {captions && <CaptionPreview captions={captions} />}
      </ReviewSection>
      {!canAdvance && (
        <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700">
          <AlertTriangle className="size-4 shrink-0" />
          <p>
            게시 불가 항목이 있어요. 위의 "수정" 링크로 돌아가 문제를
            해결해주세요.
          </p>
        </div>
      )}
      <div className="flex justify-between">
        <Button variant="outline" onClick={onPrev}>
          이전
        </Button>
        <Button onClick={onNext} disabled={!canAdvance}>
          다음 단계
        </Button>
      </div>
    </div>
  );
}

function ReviewSection({
  title,
  summary,
  onEdit,
  children,
}: {
  title: string;
  summary: string;
  onEdit: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-muted-foreground">{title}</p>
          <p className="text-sm">{summary}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onEdit} className="-mt-1">
          <Pencil className="size-3.5" /> 수정
        </Button>
      </div>
      {children}
    </div>
  );
}

function CaptionPreview({ captions }: { captions: Captions }) {
  return (
    <ul className="mt-2 space-y-2 text-xs">
      {captions.youtube && (
        <li className="rounded bg-muted/40 p-2">
          <p className="font-medium">YouTube</p>
          <p className="line-clamp-1 text-muted-foreground">
            {captions.youtube.title}
          </p>
          <p className="text-[10px] text-muted-foreground">
            해시태그 {captions.youtube.hashtags.length}개
          </p>
        </li>
      )}
      {captions.instagram && (
        <li className="rounded bg-muted/40 p-2">
          <p className="font-medium">Instagram</p>
          <p className="line-clamp-2 text-muted-foreground">
            {captions.instagram.caption}
          </p>
          <p className="text-[10px] text-muted-foreground">
            해시태그 {captions.instagram.hashtags.length}개
          </p>
        </li>
      )}
      {captions.tiktok && (
        <li className="rounded bg-muted/40 p-2">
          <p className="font-medium">TikTok</p>
          <p className="line-clamp-2 text-muted-foreground">
            {captions.tiktok.caption}
          </p>
          <p className="text-[10px] text-muted-foreground">
            해시태그 {captions.tiktok.hashtags.length}개 (본문 인라인)
          </p>
        </li>
      )}
    </ul>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 5 — 예약 및 업로드
// ─────────────────────────────────────────────────────────────────────────────

function Step5Schedule({
  scheduleMode,
  scheduledAt,
  selectedAccountCount,
  completing,
  onChangeMode,
  onChangeScheduledAt,
  onPrev,
  onComplete,
}: {
  scheduleMode: ScheduleMode;
  scheduledAt: string;
  selectedAccountCount: number;
  completing: boolean;
  onChangeMode: (m: ScheduleMode) => void;
  onChangeScheduledAt: (v: string) => void;
  onPrev: () => void;
  onComplete: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>업로드 시점</Label>
        <div className="flex gap-2">
          <Button
            variant={scheduleMode === "now" ? "default" : "outline"}
            onClick={() => onChangeMode("now")}
            className="flex-1"
          >
            즉시 업로드
          </Button>
          <Button
            variant={scheduleMode === "scheduled" ? "default" : "outline"}
            onClick={() => onChangeMode("scheduled")}
            className="flex-1"
          >
            예약 업로드
          </Button>
        </div>
        {scheduleMode === "scheduled" && (
          <input
            type="datetime-local"
            value={scheduledAt}
            onChange={(e) => onChangeScheduledAt(e.target.value)}
            className={cn(
              "mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm",
            )}
          />
        )}
      </div>

      <div className="rounded-md border bg-muted/30 p-4 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span>선택된 계정</span>
          <Badge variant="outline">{selectedAccountCount}개</Badge>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          각 계정별 publish_job이 PENDING 상태로 등록됩니다. 워커가 활성화되면
          자동 게시 (Phase 4b).
        </p>
      </div>

      <div className="flex justify-between">
        <Button variant="outline" onClick={onPrev} disabled={completing}>
          이전
        </Button>
        <Button onClick={onComplete} disabled={completing}>
          {completing ? "등록 중..." : "완료"}
        </Button>
      </div>
    </div>
  );
}
