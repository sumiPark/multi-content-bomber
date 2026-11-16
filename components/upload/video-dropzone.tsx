"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDropzone, type FileRejection } from "react-dropzone";
import { Film, ImageIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { previewUrlOf, releasePreviewUrl } from "@/lib/upload/preview-url";

function formatTime(s: number): string {
  const mm = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  const cs = Math.floor((s % 1) * 10);
  return `${mm}:${ss.toString().padStart(2, "0")}.${cs}`;
}

const ACCEPT = {
  "video/mp4": [".mp4"],
  "video/quicktime": [".mov"],
};
// 800MB. 인스타 릴스 공식 한도가 1GB라 그 아래로 잡았다.
// Supabase 버킷 한도(마이그레이션 0014)와 프로젝트 전역 한도(대시보드)가
// 모두 이 값 이상이어야 실제로 통과한다 — 셋 중 가장 낮은 값이 이긴다.
const MAX_SIZE = 800 * 1024 * 1024;
// 표지 이미지 — 유튜브 thumbnails.set 한도(2MB) 안으로 만든다.
const COVER_MAX_EDGE = 1920;
const COVER_MAX_BYTES = 2 * 1024 * 1024;

const REJECT_MESSAGES: Record<string, string> = {
  "file-invalid-type": "MP4 또는 MOV 파일만 가능합니다.",
  "file-too-large": "영상은 800MB 이하여야 합니다.",
};

interface VideoDropzoneProps {
  onChange?: (file: File | null) => void;
  // 이미 고른 영상 — 단계를 오가며 다시 그려져도 사라지지 않게(2026-11-04). 처음 그릴 때만 읽는다.
  initialFile?: File | null;
  // 커버 프레임 — 미리보기 영상에서 직접 시점을 고른다. 없으면 커버 UI 숨김.
  // blob은 고른 프레임을 캔버스로 캡처한 JPEG(YouTube 썸네일 업로드용).
  coverSeconds?: number | null;
  onCoverChange?: (seconds: number, blob: Blob | null) => void;
  // 따로 만든 표지 이미지 — 있으면 세 플랫폼 모두 고른 장면 대신 이 이미지를 표지로 쓴다.
  // 고를 때 JPEG(긴 변 1920px · 2MB 이하)로 바꿔 넘긴다. 없으면 이 칸을 숨긴다.
  coverImage?: Blob | null;
  onCoverImageChange?: (blob: Blob | null) => void;
}

const COVER_IMAGE_ACCEPT = "image/jpeg,image/png,image/webp";

// 고른 표지 이미지를 JPEG로 바꾼다 — 유튜브 2MB · 인스타 JPEG 조건을 한 번에 맞춘다.
async function toCoverJpeg(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, COVER_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("이미지를 처리하지 못했어요.");
    // PNG 투명 영역이 검게 나오지 않게 흰 바탕을 깐다
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const encode = (q: number) =>
      new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", q));
    for (const q of [0.9, 0.8, 0.7, 0.6]) {
      const blob = await encode(q);
      if (blob && blob.size <= COVER_MAX_BYTES) return blob;
    }
    throw new Error("표지 이미지가 너무 커요. 2MB 이하로 줄여 주세요.");
  } finally {
    bitmap.close();
  }
}

export function VideoDropzone({
  onChange,
  initialFile = null,
  coverSeconds = null,
  onCoverChange,
  coverImage = null,
  onCoverImageChange,
}: VideoDropzoneProps) {
  const coverImageInputRef = useRef<HTMLInputElement>(null);
  const [coverImageError, setCoverImageError] = useState<string | null>(null);
  const [coverImageBusy, setCoverImageBusy] = useState(false);
  // 표지 이미지 미리보기 주소 — 다시 그려져도 깨지지 않게 이미지마다 하나(lib/upload/preview-url)
  const coverImageUrl = coverImage ? previewUrlOf(coverImage) : null;

  const removeCoverImage = () => {
    if (coverImage) releasePreviewUrl(coverImage);
    setCoverImageError(null);
    onCoverImageChange?.(null);
  };

  const pickCoverImage = async (picked: File | undefined) => {
    if (!picked || !onCoverImageChange) return;
    setCoverImageError(null);
    setCoverImageBusy(true);
    try {
      const jpeg = await toCoverJpeg(picked);
      if (coverImage) releasePreviewUrl(coverImage);
      onCoverImageChange(jpeg);
    } catch (err) {
      setCoverImageError(err instanceof Error ? err.message : "표지 이미지를 읽지 못했어요.");
    } finally {
      setCoverImageBusy(false);
      if (coverImageInputRef.current) coverImageInputRef.current.value = "";
    }
  };

  const [file, setFile] = useState<File | null>(initialFile);
  // 미리보기 주소는 파일마다 하나(lib/upload/preview-url) — 다시 그려져도 깨지지 않게
  const previewUrl = file ? previewUrlOf(file) : null;
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  // 고른 커버 프레임의 미리보기(data URL). 캡처 즉시 화면에 보여준다.
  const [coverPreview, setCoverPreview] = useState<string | null>(null);

  useEffect(() => {
    onChange?.(file);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);


  const onDrop = useCallback(
    (accepted: File[], rejected: FileRejection[]) => {
      setError(null);
      if (rejected.length > 0) {
        const reason = rejected[0].errors[0];
        setError(REJECT_MESSAGES[reason.code] ?? reason.message);
        return;
      }
      if (accepted.length === 0) return;

      setFile((prev) => {
        if (prev && prev !== accepted[0]) releasePreviewUrl(prev);
        return accepted[0];
      });
      setCoverPreview(null);
    },
    [],
  );

  const handleRemove = () => {
    if (file) releasePreviewUrl(file);
    setFile(null);
    setError(null);
    setCurrentTime(0);
    setCoverPreview(null);
  };

  // 현재 미리보기 프레임을 캔버스로 캡처 → JPEG blob + data URL.
  // 보이는 그 프레임을 그대로 쓰므로 숨은 video 재시킹이 필요 없다(멈춤 버그 방지).
  const captureCover = () => {
    const v = videoRef.current;
    if (!v || !onCoverChange) return;
    if (!v.videoWidth || !v.videoHeight) return;
    // 유튜브 썸네일은 2MB까지라 긴 변을 1920px로 줄인다(4K 원본 프레임은 2MB를 넘을 수 있다).
    // TikTok · Instagram은 이미지가 아니라 시점(ms)만 쓰므로 영향이 없다.
    const scale = Math.min(1, COVER_MAX_EDGE / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.round(v.videoWidth * scale);
    const h = Math.round(v.videoHeight * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, w, h);
    // 커버 시점은 영상 길이 안으로 클램프한다. 재생이 끝나면 currentTime이
    // duration과 같아지는데, TikTok(video_cover_timestamp_ms)·Instagram(thumb_offset)은
    // 길이를 벗어난 값을 거부하거나 무시해 커버 지정이 통째로 날아간다.
    const dur = v.duration;
    const seconds =
      Number.isFinite(dur) && dur > 0
        ? Math.min(Math.max(0, v.currentTime), Math.max(0, dur - 0.05))
        : Math.max(0, v.currentTime);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    setCoverPreview(dataUrl);
    canvas.toBlob(
      (blob) => {
        // 그래도 2MB를 넘으면 화질을 낮춰 한 번 더 만든다.
        if (blob && blob.size > COVER_MAX_BYTES) {
          canvas.toBlob((smaller) => onCoverChange(seconds, smaller), "image/jpeg", 0.7);
          return;
        }
        onCoverChange(seconds, blob);
      },
      "image/jpeg",
      0.85,
    );
  };

  // 로드되면 첫 프레임(보통 검은 화면) 대신 살짝 뒤로 시킹해 실제 장면을 보여준다.
  const handleLoadedMetadata = () => {
    const v = videoRef.current;
    if (!v) return;
    const dur = v.duration;
    if (v.currentTime === 0 && Number.isFinite(dur) && dur > 0) {
      try {
        v.currentTime = Math.min(0.1, dur / 2);
      } catch {
        // 일부 포맷은 즉시 시킹이 막힘 — 무시(사용자가 직접 스크럽).
      }
    }
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: ACCEPT,
    maxSize: MAX_SIZE,
    multiple: false,
    disabled: !!file,
  });

  if (file && previewUrl) {
    return (
      <div className="space-y-3">
        <div className="overflow-hidden rounded-lg border bg-black">
          <video
            ref={videoRef}
            src={previewUrl}
            controls
            playsInline
            preload="metadata"
            onLoadedMetadata={handleLoadedMetadata}
            onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
            onSeeked={(e) => setCurrentTime(e.currentTarget.currentTime)}
            className="aspect-video w-full"
          />
        </div>
        {onCoverChange && (
          <div className="flex items-center gap-3 rounded-md border bg-muted/30 p-3">
            {coverPreview && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={coverPreview}
                alt="선택한 커버 프레임 미리보기"
                className="h-16 w-16 shrink-0 rounded-md object-cover"
              />
            )}
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <ImageIcon className="size-4" />
                커버 프레임
                {coverSeconds !== null ? (
                  <span className="text-xs font-normal text-muted-foreground">
                    · 지정됨 {formatTime(coverSeconds)}
                  </span>
                ) : (
                  <span className="text-xs font-normal text-muted-foreground">
                    · 미지정 (기본 프레임)
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                원하는 장면에서 멈춘 뒤 버튼을 누르세요. YouTube·Instagram·TikTok
                커버로 함께 적용됩니다.
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="shrink-0"
              onClick={captureCover}
            >
              현재 장면({formatTime(currentTime)})을 커버로
            </Button>
          </div>
        )}
        {onCoverImageChange && (
          <div className="space-y-2 rounded-md border bg-muted/30 p-3">
            <div className="flex items-center gap-3">
              {coverImageUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={coverImageUrl}
                  alt="따로 올린 표지 이미지 미리보기"
                  className="h-16 w-16 shrink-0 rounded-md object-cover"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <ImageIcon className="size-4" />
                  표지 이미지
                  <span className="text-xs font-normal text-muted-foreground">
                    {coverImage ? "· 첨부됨" : "· 선택 사항"}
                  </span>
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  따로 만든 표지가 있으면 올려 주세요. YouTube · Instagram · TikTok 모두 고른 장면 대신 이
                  이미지를 표지로 써요. 9:16 세로 이미지를 권장해요.
                </p>
              </div>
              <input
                ref={coverImageInputRef}
                type="file"
                accept={COVER_IMAGE_ACCEPT}
                className="hidden"
                onChange={(e) => void pickCoverImage(e.target.files?.[0])}
              />
              <div className="flex shrink-0 gap-1">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={coverImageBusy}
                  onClick={() => coverImageInputRef.current?.click()}
                >
                  {coverImageBusy ? "처리 중…" : coverImage ? "다른 이미지" : "이미지 올리기"}
                </Button>
                {coverImage && (
                  <Button type="button" variant="ghost" size="sm" onClick={removeCoverImage}>
                    <XIcon className="size-4" /> 빼기
                  </Button>
                )}
              </div>
            </div>
            {coverImageError && (
              <p role="alert" className="text-xs text-destructive">
                {coverImageError}
              </p>
            )}
          </div>
        )}
        <div className="flex items-center justify-between gap-2 rounded-md border p-3 text-sm">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{file.name}</p>
            <p className="text-xs text-muted-foreground">
              {(file.size / 1024 / 1024).toFixed(1)} MB · {file.type}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={handleRemove}>
            <XIcon className="size-4" /> 다른 영상
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div
        {...getRootProps()}
        className={cn(
          "flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-12 text-center transition cursor-pointer",
          isDragActive
            ? "border-primary bg-primary/5"
            : "border-muted-foreground/25 hover:border-muted-foreground/50",
        )}
      >
        <input {...getInputProps()} />
        <Film className="size-10 text-muted-foreground" />
        <p className="mt-3 text-sm font-medium">
          {isDragActive ? "여기에 놓으세요" : "영상을 드래그하거나 클릭하여 업로드"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          MP4 / MOV · 최대 800MB · 9:16 권장
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
