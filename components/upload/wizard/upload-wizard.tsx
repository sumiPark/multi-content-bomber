"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { CaptionResult } from "@/components/ai/caption-result";
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
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  createPublishJobsAction,
  generateCaptionsAction,
  type GenerateCaptionsResult,
} from "@/app/(dashboard)/actions";
import type { Captions } from "@/lib/ai/caption-generator";
import { uploadMedia, uploadOne } from "@/lib/storage/upload";
import { extractFirstFrame } from "@/lib/video/extract-frame";
import { StepIndicator } from "./step-indicator";

const STEPS = [
  { key: 1, label: "미디어" },
  { key: 2, label: "계정" },
  { key: 3, label: "캡션" },
  { key: 4, label: "예약" },
];

interface SocialAccountSummary {
  id: string;
  platform: "YOUTUBE" | "INSTAGRAM" | "TIKTOK";
  display_name: string | null;
  is_active: boolean;
  token_expires_at: string | null;
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
  presets: PresetSummary[];
}

type MediaType = "IMAGE" | "VIDEO";
type ScheduleMode = "now" | "scheduled";

export function UploadWizard({
  organizationId,
  userId,
  socialAccounts = [],
  presets = [],
}: UploadWizardProps) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [mediaType, setMediaType] = useState<MediaType>("IMAGE");
  const [files, setFiles] = useState<File[]>([]);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [mediaPaths, setMediaPaths] = useState<string[]>([]);
  const [analyzePaths, setAnalyzePaths] = useState<string[]>([]);
  const [mediaMetadata, setMediaMetadata] = useState<Record<string, unknown>>(
    {},
  );
  const [uploading, setUploading] = useState(false);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [presetId, setPresetId] = useState<string>("");
  const [description, setDescription] = useState("");
  const [generating, setGenerating] = useState(false);
  const [captions, setCaptions] = useState<Captions | null>(null);
  const [contentId, setContentId] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>("now");
  const [scheduledAt, setScheduledAt] = useState("");
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedPreset = useMemo(
    () => presets.find((p) => p.id === presetId),
    [presets, presetId],
  );

  const canAdvanceStep1 =
    mediaType === "IMAGE" ? files.length > 0 : !!videoFile;

  function switchMediaType(next: MediaType) {
    if (mediaType === next) return;
    setMediaType(next);
    setFiles([]);
    setVideoFile(null);
    setError(null);
  }

  async function advanceFromStep1() {
    setError(null);
    if (!canAdvanceStep1) return;
    setUploading(true);
    try {
      if (mediaType === "IMAGE") {
        const uploaded = await uploadMedia({
          files,
          organizationId,
          userId,
        });
        const paths = uploaded.map((u) => u.path);
        setMediaPaths(paths);
        setAnalyzePaths(paths);
        setMediaMetadata({});
      } else if (videoFile) {
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
      setStep(2);
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
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCaptions(result.captions);
      setContentId(result.contentId);
      setSavedAt(result.savedAt);
    } finally {
      setGenerating(false);
    }
  }

  async function handleComplete() {
    setError(null);
    if (contentId && selectedAccountIds.length > 0) {
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
    }

    if (contentId) {
      router.push(`/?content=${contentId}`);
    } else {
      router.push("/contents");
    }
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>새 콘텐츠 만들기</CardTitle>
        <CardDescription>
          4단계로 미디어를 업로드하고 게시 준비를 합니다.
        </CardDescription>
        <div className="pt-4">
          <StepIndicator current={step} steps={STEPS} />
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {error && <p className="text-sm text-destructive">{error}</p>}

        {step === 1 && (
          <div className="space-y-4">
            <div className="flex gap-2">
              <Button
                variant={mediaType === "IMAGE" ? "default" : "outline"}
                onClick={() => switchMediaType("IMAGE")}
                disabled={uploading}
                className="flex-1"
              >
                이미지 (1~10장)
              </Button>
              <Button
                variant={mediaType === "VIDEO" ? "default" : "outline"}
                onClick={() => switchMediaType("VIDEO")}
                disabled={uploading}
                className="flex-1"
              >
                영상 (1개)
              </Button>
            </div>
            {mediaType === "IMAGE" ? (
              <ImageDropzone onChange={setFiles} />
            ) : (
              <VideoDropzone onChange={setVideoFile} />
            )}
            <div className="flex justify-end">
              <Button
                onClick={advanceFromStep1}
                disabled={!canAdvanceStep1 || uploading}
              >
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
        )}

        {step === 2 && (
          <div className="space-y-4">
            {socialAccounts.length === 0 ? (
              <div className="rounded-md border bg-muted/30 p-8 text-center">
                <p className="text-sm">아직 연동된 계정이 없어요.</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  계정 없이도 캡션 생성과 저장은 가능합니다.
                </p>
                <Link
                  href="/accounts"
                  className={buttonVariants({ variant: "link", size: "sm" })}
                >
                  계정 관리로 이동
                </Link>
              </div>
            ) : (
              <ul className="space-y-2">
                {socialAccounts.map((acc) => {
                  const checked = selectedAccountIds.includes(acc.id);
                  return (
                    <li key={acc.id}>
                      <label className="flex cursor-pointer items-center gap-3 rounded-md border p-3 transition hover:bg-accent/40">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            setSelectedAccountIds((prev) =>
                              e.target.checked
                                ? [...prev, acc.id]
                                : prev.filter((id) => id !== acc.id),
                            );
                          }}
                          className="size-4"
                        />
                        <div className="flex-1">
                          <p className="text-sm font-medium">
                            {acc.display_name ?? "(이름 없음)"}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {acc.platform}
                          </p>
                        </div>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep(1)}>
                이전
              </Button>
              <Button onClick={() => setStep(3)}>
                {socialAccounts.length === 0
                  ? "건너뛰기"
                  : `다음 단계 (${selectedAccountIds.length}개 선택)`}
              </Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            {!captions ? (
              <>
                {presets.length > 0 && (
                  <div className="space-y-2">
                    <Label htmlFor="preset">캡션 프리셋 (선택)</Label>
                    <select
                      id="preset"
                      value={presetId}
                      onChange={(e) => setPresetId(e.target.value)}
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
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="예) 홍대 브런치 카페 후기, 톤은 따뜻하고 일상적으로"
                    rows={3}
                    disabled={generating}
                  />
                  <p className="text-xs text-muted-foreground">
                    설명을 입력하면 AI가 더 정확한 톤의 캡션을 생성합니다.
                  </p>
                </div>
                <Button onClick={handleGenerate} disabled={generating}>
                  <Sparkles className="size-4" />
                  {generating ? "AI 분석 중..." : "AI 캡션 생성"}
                </Button>
              </>
            ) : (
              contentId &&
              savedAt && (
                <CaptionResult
                  contentId={contentId}
                  captions={captions}
                  savedAt={savedAt}
                  thumbnails={[]}
                />
              )
            )}
            <div className="flex justify-between">
              <Button
                variant="outline"
                onClick={() => setStep(2)}
                disabled={generating}
              >
                이전
              </Button>
              <Button onClick={() => setStep(4)} disabled={!captions}>
                다음 단계
              </Button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>업로드 시점</Label>
              <div className="flex gap-2">
                <Button
                  variant={scheduleMode === "now" ? "default" : "outline"}
                  onClick={() => setScheduleMode("now")}
                  className="flex-1"
                >
                  즉시 업로드
                </Button>
                <Button
                  variant={
                    scheduleMode === "scheduled" ? "default" : "outline"
                  }
                  onClick={() => setScheduleMode("scheduled")}
                  className="flex-1"
                >
                  예약 업로드
                </Button>
              </div>
              {scheduleMode === "scheduled" && (
                <input
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                  className={cn(
                    "mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm",
                  )}
                />
              )}
            </div>

            <div className="rounded-md border bg-muted/30 p-4 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span>선택된 계정</span>
                <Badge variant="outline">
                  {selectedAccountIds.length}개
                </Badge>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {selectedAccountIds.length === 0
                  ? "계정 미선택 — 콘텐츠만 보관함에 저장됩니다."
                  : "각 계정별 publish_job이 PENDING 상태로 등록됩니다. 워커가 활성화되면 자동 게시 (Phase 4)."}
              </p>
            </div>

            <div className="flex justify-between">
              <Button
                variant="outline"
                onClick={() => setStep(3)}
                disabled={completing}
              >
                이전
              </Button>
              <Button onClick={handleComplete} disabled={completing}>
                {completing ? "등록 중..." : "완료"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
