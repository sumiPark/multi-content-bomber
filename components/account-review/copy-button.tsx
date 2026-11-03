"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

// 다시 쓴 문구 복사 — 인스타 앱에 직접 붙여 넣게.
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={copied ? "복사했어요" : "문구 복사"}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          // 클립보드 권한이 없으면 아무것도 하지 않는다 — 글자는 화면에서 직접 고를 수 있다
        }
      }}
    >
      {copied ? <Check className="size-4 text-ok" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      {copied ? "복사했어요" : "복사"}
    </Button>
  );
}
