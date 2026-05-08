"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDropzone, type FileRejection } from "react-dropzone";
import { Reorder } from "framer-motion";
import { GripVertical, ImageUp, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const ACCEPT = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
};
const MAX_FILES = 10;
const MAX_SIZE = 25 * 1024 * 1024;

const REJECT_MESSAGES: Record<string, string> = {
  "file-invalid-type": "지원하지 않는 형식입니다. JPG, PNG, WEBP만 가능합니다.",
  "file-too-large": "파일이 너무 큽니다. 최대 25MB까지 업로드할 수 있습니다.",
  "too-many-files": `최대 ${MAX_FILES}장까지 업로드할 수 있습니다.`,
};

interface SelectedImage {
  id: string;
  file: File;
  previewUrl: string;
}

interface ImageDropzoneProps {
  onChange?: (files: File[]) => void;
}

export function ImageDropzone({ onChange }: ImageDropzoneProps) {
  const [files, setFiles] = useState<SelectedImage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const filesRef = useRef(files);
  filesRef.current = files;

  // Notify parent on every change (drop / remove / clear / reorder).
  // Intentional dep-list: parent passes a stable setter, re-running on
  // its identity would cause noisy re-emits.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    onChange?.(files.map((f) => f.file));
  }, [files]);

  const onDrop = useCallback(
    (accepted: File[], rejected: FileRejection[]) => {
      setError(null);

      if (rejected.length > 0) {
        const reason = rejected[0].errors[0];
        setError(REJECT_MESSAGES[reason.code] ?? reason.message);
        return;
      }

      const remaining = MAX_FILES - filesRef.current.length;
      if (accepted.length > remaining) {
        setError(`최대 ${MAX_FILES}장까지 업로드할 수 있습니다.`);
        accepted = accepted.slice(0, remaining);
      }

      const additions: SelectedImage[] = accepted.map((file) => ({
        id: crypto.randomUUID(),
        file,
        previewUrl: URL.createObjectURL(file),
      }));

      setFiles((prev) => [...prev, ...additions]);
    },
    [],
  );

  const removeFile = (id: string) => {
    const target = filesRef.current.find((f) => f.id === id);
    if (target) URL.revokeObjectURL(target.previewUrl);
    setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const clearAll = () => {
    filesRef.current.forEach((f) => URL.revokeObjectURL(f.previewUrl));
    setFiles([]);
  };

  useEffect(() => {
    return () => {
      filesRef.current.forEach((f) => URL.revokeObjectURL(f.previewUrl));
    };
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: ACCEPT,
    maxSize: MAX_SIZE,
    multiple: true,
    disabled: files.length >= MAX_FILES,
  });

  return (
    <div className="space-y-4">
      <div
        {...getRootProps()}
        className={cn(
          "flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-12 text-center transition",
          files.length >= MAX_FILES
            ? "cursor-not-allowed border-muted-foreground/15 bg-muted/30"
            : "cursor-pointer",
          isDragActive
            ? "border-primary bg-primary/5"
            : "border-muted-foreground/25 hover:border-muted-foreground/50",
        )}
      >
        <input {...getInputProps()} />
        <ImageUp className="size-10 text-muted-foreground" />
        <p className="mt-3 text-sm font-medium">
          {files.length >= MAX_FILES
            ? `${MAX_FILES}장 모두 채웠습니다`
            : isDragActive
              ? "여기에 놓으세요"
              : "이미지를 드래그하거나 클릭하여 업로드"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          JPG / PNG / WEBP · 최대 {MAX_FILES}장 · 파일당 25MB 이하
        </p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive" aria-live="polite">
          {error}
        </p>
      )}

      {files.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">
              선택된 이미지 ({files.length}/{MAX_FILES}) ·{" "}
              <span className="text-muted-foreground">
                드래그로 순서 변경
              </span>
            </p>
            <Button variant="ghost" size="sm" onClick={clearAll}>
              모두 지우기
            </Button>
          </div>
          <Reorder.Group
            as="ul"
            axis="y"
            values={files}
            onReorder={setFiles}
            className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5"
          >
            {files.map((item, index) => (
              <Reorder.Item
                key={item.id}
                value={item}
                as="li"
                whileDrag={{ scale: 1.05, zIndex: 10 }}
                className="group relative aspect-square cursor-grab overflow-hidden rounded-md border bg-muted active:cursor-grabbing"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={item.previewUrl}
                  alt={item.file.name}
                  className="size-full object-cover pointer-events-none"
                />
                <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-xs font-medium text-white">
                  {index + 1}
                </span>
                <GripVertical className="absolute bottom-1 left-1 size-4 text-white opacity-0 drop-shadow transition group-hover:opacity-80" />
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFile(item.id);
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  aria-label={`${item.file.name} 제거`}
                  className="absolute right-1 top-1 rounded bg-black/60 p-1 text-white opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <XIcon className="size-3" />
                </button>
              </Reorder.Item>
            ))}
          </Reorder.Group>
        </div>
      )}
    </div>
  );
}
