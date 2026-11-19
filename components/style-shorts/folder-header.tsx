"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { deleteFolderAction, updateFolderAction } from "@/app/(dashboard)/style-shorts/actions";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";

// 폴더 이름 · 메모 고치기, 폴더 지우기(레퍼런스 파일까지).
export function FolderHeader({ folderId, name, memo }: { folderId: string; name: string; memo: string | null }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name, memo: memo ?? "" });
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      const res = await updateFolderAction({ folderId, name: draft.name, memo: draft.memo });
      if (!res.ok) return setError(res.error);
      setEditing(false);
      setError(null);
      toast("저장했어요");
      router.refresh();
    });

  const remove = () =>
    start(async () => {
      const res = await deleteFolderAction({ id: folderId });
      if (!res.ok) {
        setConfirm(false);
        return toast(res.error, "risk");
      }
      toast("폴더를 지웠어요");
      router.push("/style-shorts");
    });

  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      {editing ? (
        <form
          className="w-full max-w-xl space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={40} aria-label="폴더 이름" />
          <Input value={draft.memo} onChange={(e) => setDraft({ ...draft, memo: e.target.value })} maxLength={300} placeholder="예시: 제품 손 클로즈업 위주, 밝은 음악" className="placeholder:text-faint" aria-label="메모" />
          {error && <p className="text-xs text-risk">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={pending || !draft.name.trim()}>
              저장
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)} disabled={pending}>
              취소
            </Button>
          </div>
        </form>
      ) : (
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-[-0.01em]">{name}</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{memo || "레퍼런스를 넣으면 AI가 분석해 오른쪽 스타일 카드를 만들어요. 카드 글은 직접 고칠 수 있어요."}</p>
        </div>
      )}
      {!editing && (
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="size-4" aria-hidden />
            이름 고치기
          </Button>
          <Button variant="destructive" size="sm" onClick={() => setConfirm(true)}>
            <Trash2 className="size-4" aria-hidden />
            폴더 지우기
          </Button>
        </div>
      )}
      <ConfirmDialog open={confirm} title="폴더를 지울까요?" confirmLabel="지우기" danger pending={pending} onConfirm={remove} onClose={() => setConfirm(false)}>
        레퍼런스 기록과 올린 레퍼런스 영상 파일, 스타일 카드가 모두 지워져요. 되돌릴 수 없어요.
      </ConfirmDialog>
    </header>
  );
}
