"use client";

import { useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

// "지금 수집" — 워크플로를 깨우는 서버 액션을 받아 실행한다(분석 · 상품 화면 공용).
export function CollectNowButton({
  action,
  doneText,
}: {
  action: () => Promise<{ ok: true } | { ok: false; error: string }>;
  doneText: string;
}) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="outline"
        size="sm"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            setMessage(null);
            const result = await action();
            setMessage(
              result.ok ? { ok: true, text: doneText } : { ok: false, text: result.error },
            );
          })
        }
      >
        <RefreshCw className={isPending ? "size-4 animate-spin" : "size-4"} />
        지금 수집
      </Button>
      {message && (
        <p
          className={
            message.ok
              ? "text-xs text-muted-foreground"
              : "text-xs text-destructive"
          }
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
