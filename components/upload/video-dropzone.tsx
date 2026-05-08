"use client";

import { useCallback, useEffect, useState } from "react";
import { useDropzone, type FileRejection } from "react-dropzone";
import { Film, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
}

export function VideoDropzone({ onChange }: VideoDropzoneProps) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    },
    [],
  );

  const handleRemove = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setFile(null);
    setError(null);
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
            src={previewUrl}
            controls
            className="aspect-video w-full"
          />
        </div>
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
