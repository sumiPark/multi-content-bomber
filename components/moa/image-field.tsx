"use client";

import { useRef, useState } from "react";
import { ImagePlus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { uploadMoaImage } from "./upload";

// 이미지 한 장 고르기 — 올리면 공개 주소를 onChange로 넘긴다.

export function ImageField({
  value,
  onChange,
  organizationId,
  label,
  hint,
  round,
}: {
  value: string | null;
  onChange: (url: string | null) => void;
  organizationId: string;
  label: string;
  hint?: string;
  round?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      onChange(await uploadMoaImage(file, organizationId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">{label}</p>
      <div className="flex items-center gap-3">
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={value} alt="" className={`size-16 border object-cover ${round ? "rounded-full" : "rounded-md"}`} />
        ) : (
          <div className={`grid size-16 place-items-center border bg-surface-2 text-faint ${round ? "rounded-full" : "rounded-md"}`}>
            <ImagePlus className="size-5" />
          </div>
        )}
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? "올리는 중…" : value ? "바꾸기" : "이미지 올리기"}
          </Button>
          {value && (
            <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
              <Trash2 /> 지우기
            </Button>
          )}
        </div>
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p className="text-xs text-risk">{error}</p>}
    </div>
  );
}
