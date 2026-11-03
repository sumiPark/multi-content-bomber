"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** 서버 컴포넌트 화면을 일정 간격으로 다시 그린다 — 워커가 도는 동안만 넣는다. */
export function AutoRefresh({ intervalMs }: { intervalMs: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(t);
  }, [router, intervalMs]);
  return null;
}
