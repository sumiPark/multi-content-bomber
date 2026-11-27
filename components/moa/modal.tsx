"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

// 모아링크 편집용 입력 창 (DESIGN.md 1장 — 입력은 모달). 네이티브 <dialog>라 Esc · 바깥 포커스 처리를 브라우저가 한다.

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
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
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="m-auto w-[min(560px,calc(100vw-24px))] rounded-xl border bg-card p-0 text-foreground shadow-[0_8px_24px_rgb(16_24_40/.12),0_2px_6px_rgb(16_24_40/.08)] backdrop:bg-black/40"
    >
      {open && (
        <div className="flex max-h-[min(760px,calc(100dvh-48px))] flex-col">
          <div className="flex items-center justify-between border-b px-5 py-3.5">
            <h2 className="text-base font-semibold">{title}</h2>
            <Button variant="ghost" size="icon-sm" aria-label="닫기" onClick={onClose}>
              <XIcon />
            </Button>
          </div>
          <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">{children}</div>
          <div className="flex justify-end gap-2 border-t px-5 py-3">{footer}</div>
        </div>
      )}
    </dialog>
  );
}
