"use client";

import { useSyncExternalStore } from "react";
import { CheckCircle2, OctagonAlert } from "lucide-react";
import { cn } from "@/lib/utils";

// 토스트 — DESIGN.md 6장: 오른쪽 아래, 4초, 결과를 과거형으로("확인했어요").
// 어디서든 toast("…")로 부른다. 표시는 앱 셸의 <Toaster />가 한다.
// 카드가 조작 뒤 사라져도(건너뛰기 · 지우기) 안내가 남는다.

type Item = { id: number; text: string; tone: "ok" | "risk" };

const DURATION_MS = 4000;
const EMPTY: Item[] = [];
let items: Item[] = EMPTY;
let nextId = 1;
const subscribers = new Set<() => void>();

function emit(next: Item[]) {
  items = next;
  subscribers.forEach((fn) => fn());
}

export function toast(text: string, tone: "ok" | "risk" = "ok"): void {
  const id = nextId++;
  emit([...items, { id, text, tone }]);
  setTimeout(() => emit(items.filter((i) => i.id !== id)), tone === "risk" ? DURATION_MS * 2 : DURATION_MS);
}

function subscribe(fn: () => void) {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

export function Toaster() {
  const list = useSyncExternalStore(
    subscribe,
    () => items,
    () => EMPTY,
  );
  return (
    <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(400px,calc(100%-32px))] flex-col gap-2">
      {list.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cn(
            "pointer-events-auto flex items-start gap-2 rounded-lg border bg-card px-3.5 py-2.5 text-[13px] shadow-[0_8px_24px_rgb(16_24_40/.12),0_2px_6px_rgb(16_24_40/.08)]",
            t.tone === "risk" && "border-risk/40",
          )}
        >
          {t.tone === "ok" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" /> : <OctagonAlert className="mt-0.5 size-4 shrink-0 text-risk" />}
          <span className="min-w-0">{t.text}</span>
        </div>
      ))}
    </div>
  );
}
