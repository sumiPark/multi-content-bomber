"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { FolderPlus } from "lucide-react";
import { createFolderAction } from "@/app/(dashboard)/style-shorts/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// 스타일 폴더 만들기 — 이름만 받고 만든 뒤 폴더 화면으로 간다.
export function FolderCreate() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)}>
        <FolderPlus className="size-4" aria-hidden />
        새 폴더
      </Button>
    );
  }

  const submit = () =>
    start(async () => {
      const res = await createFolderAction({ name });
      if (!res.ok) return setError(res.error);
      router.push(`/style-shorts/folders/${res.id}`);
    });

  return (
    <form
      className="flex w-full max-w-md flex-col gap-1 sm:w-auto"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex gap-2">
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="예시: 손 클로즈업 · 빠른 컷" className="placeholder:text-faint" aria-label="폴더 이름" />
        <Button type="submit" disabled={pending || !name.trim()}>
          만들기
        </Button>
        <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
          취소
        </Button>
      </div>
      {error && <p className="text-xs text-risk">{error}</p>}
    </form>
  );
}
