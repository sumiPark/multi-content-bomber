"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// 진행 중인 일(편집 · 후보 만들기)이 있는 화면을 일정 간격으로 새로 고친다 — 직접 새로 고치지 않아도 결과가 뜨게.
// active가 false면 아무것도 하지 않는다.
export function AutoRefresh({ active, seconds = 30 }: { active: boolean; seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(t);
  }, [active, seconds, router]);
  return null;
}
