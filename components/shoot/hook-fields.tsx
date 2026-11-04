"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Save } from "lucide-react";
import { saveHumanTextAction } from "@/app/(dashboard)/shoot/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";

// 영상 첫 화면 후킹과 표지 글자. 넣으면 글자 그대로 쓰고, 비우면 편집 에이전트가 만든다.

export function HookFields({ planId, hook, thumbnail, aiHook, aiThumbnail }: { planId: string; hook: string; thumbnail: string; aiHook: string | null; aiThumbnail: string | null }) {
  const router = useRouter();
  const [hookText, setHookText] = useState(hook);
  const [thumbText, setThumbText] = useState(thumbnail);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const changed = hookText.trim() !== hook.trim() || thumbText.trim() !== thumbnail.trim();

  const save = () =>
    startTransition(async () => {
      setError(null);
      const r = await saveHumanTextAction({ planId, hook: hookText.trim(), thumbnail: thumbText.trim() });
      if (r.ok) {
        toast("저장했어요. 편집할 때 이 글자를 그대로 써요.");
        router.refresh();
      } else setError(r.error);
    });

  return (
    <div className="space-y-2 rounded-md border px-3 py-2.5">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1 text-xs font-semibold">
          첫 화면 후킹
          <Input value={hookText} maxLength={40} placeholder={aiHook ? `비우면 AI가 만들어요 · 예: ${aiHook}` : "비우면 AI가 만들어요"} onChange={(e) => setHookText(e.target.value)} />
        </label>
        <label className="space-y-1 text-xs font-semibold">
          표지 글자
          <Input value={thumbText} maxLength={24} placeholder={aiThumbnail ? `비우면 AI가 만들어요 · 예: ${aiThumbnail}` : "비우면 AI가 만들어요"} onChange={(e) => setThumbText(e.target.value)} />
        </label>
      </div>
      {changed && (
        <Button size="sm" variant="outline" disabled={isPending} onClick={save}>
          <Save className="size-4" /> 저장
        </Button>
      )}
      {error && <p className="text-xs text-risk">{error}</p>}
    </div>
  );
}
