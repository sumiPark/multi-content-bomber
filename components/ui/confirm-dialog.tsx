"use client";

import { useEffect, useRef } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

// 되돌릴 수 없는 조작(칸 · 계정 빼기) 전에 띄우는 확인 창. 예약 건이 있으면 경고를 먼저 보여 준다.

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger,
  pending,
  confirmDisabled,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  pending?: boolean;
  // 아직 고르지 않았을 때처럼 확인 버튼만 막을 때
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className="m-auto w-[min(440px,calc(100%-32px))] rounded-xl border bg-card p-0 text-foreground shadow-[0_8px_24px_rgb(16_24_40/.12),0_2px_6px_rgb(16_24_40/.08)] backdrop:bg-black/40"
    >
      <div className="space-y-3 p-5">
        <h2 className="flex items-center gap-2 text-base font-bold">
          {danger && <TriangleAlert className="size-5 shrink-0 text-risk" />}
          {title}
        </h2>
        <div className="space-y-2 text-[13px] leading-relaxed text-ink-2">{children}</div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            그만두기
          </Button>
          <Button variant={danger ? "destructive" : "default"} onClick={onConfirm} disabled={pending || confirmDisabled}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
