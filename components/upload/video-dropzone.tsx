"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDropzone, type FileRejection } from "react-dropzone";
import { Film, ImageIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
const MAX_SIZE = 100 * 1024 * 1024;

const REJECT_MESSAGES: Record<string, string> = {
  "file-invalid-type": "MP4 또는 MOV 파일만 가능합니다.",
  "file-too-large": "영상은 100MB 이하여야 합니다.",
};

interface VideoDropzoneProps {
  onChange?: (file: File | null) => void;
  // 커버 프레임 — 미리보기 영상에서 직접 시점을 고른다. 없으면 커버 UI 숨김.
  // blob은 고른 프레임을 캔버스로 캡처한 JPEG(YouTube 썸네일 업로드용).
  coverSeconds?: number | null;
  onCoverChange?: (seconds: number, blob: Blob | null) => void;
}

export function VideoDropzone({
  onChange,
  coverSeconds = null,
  onCoverChange,
}: VideoDropzoneProps) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  // 고른 커버 프레임의 미리보기(data URL). 캡처 즉시 화면에 보여준다.
  const [coverPreview, setCoverPreview] = useState<string | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    onChange?.(file);
  }, [file]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const onDrop = useCallback(
    (accepted: File[], rejected: FileRejection[]) => {
      setError(null);
      if (rejected.length > 0) {
        const reason = rejected[0].errors[0];
        setError(REJECT_MESSAGES[reason.code] ?? reason.message);
        return;
      }
      if (accepted.length === 0) return;

      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(accepted[0]);
      });
      setFile(accepted[0]);
      setCoverPreview(null);
    },
    [],
  );

  const handleRemove = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
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
    const w = v.videoWidth;
    const h = v.videoHeight;
    if (!w || !h) return;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, w, h);
    const seconds = v.currentTime;
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    setCoverPreview(dataUrl);
    canvas.toBlob(
      (blob) => onCoverChange(seconds, blob),
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
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
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
          MP4 / MOV · 최대 100MB · 9:16 권장
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
