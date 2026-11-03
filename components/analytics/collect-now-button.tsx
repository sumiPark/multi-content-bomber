"use client";

import { useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { collectMetricsNowAction } from "@/app/(dashboard)/analytics/actions";
import { Button } from "@/components/ui/button";

export function CollectNowButton() {
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
            const result = await collectMetricsNowAction();
            setMessage(
              result.ok
                ? { ok: true, text: "수집을 시작했어요. 2~3분 뒤 새로고침하세요." }
                : { ok: false, text: result.error },
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
