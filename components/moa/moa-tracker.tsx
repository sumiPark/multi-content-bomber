"use client";

import { useEffect } from "react";

// 모아링크 공개 페이지의 방문 · 노출 · 클릭 기록 (쿠키 없음).
//   방문: 페이지를 열면 VIEW 한 번
//   노출: 블록이 화면에 절반 이상 보이면 방문당 한 번(IMPRESSION)
//   클릭: 링크 주소가 서버(/r/블록)를 거쳐 가며 서버가 기록한다. 여기서는 방문 표시(s)와 캠페인(c)만 붙인다.
// 방문 표시는 sessionStorage 난수라 탭을 닫으면 사라진다.

const ENDPOINT = "/api/moa/e";

function sessionId(pageId: string): string {
  const key = `moa:s:${pageId}`;
  try {
    const old = sessionStorage.getItem(key);
    if (old) return old;
    const fresh = crypto.randomUUID().replace(/-/g, "");
    sessionStorage.setItem(key, fresh);
    return fresh;
  } catch {
    return crypto.randomUUID().replace(/-/g, "");
  }
}

function send(body: object) {
  const json = JSON.stringify(body);
  try {
    if (navigator.sendBeacon?.(ENDPOINT, new Blob([json], { type: "application/json" }))) return;
  } catch {
    // sendBeacon이 막힌 브라우저는 아래 fetch로
  }
  void fetch(ENDPOINT, { method: "POST", body: json, headers: { "Content-Type": "application/json" }, keepalive: true }).catch(() => {});
}

export function MoaTracker({ pageId }: { pageId: string }) {
  useEffect(() => {
    const s = sessionId(pageId);
    const campaign = new URLSearchParams(location.search).get("c") ?? "";
    const ref = document.referrer || "";
    send({ pageId, s, c: campaign, ref, events: [{ kind: "VIEW" }] });

    // 노출 — 모아서 1.5초마다 보낸다
    const seen = new Set<string>();
    let queue: string[] = [];
    const flush = () => {
      if (queue.length === 0) return;
      send({ pageId, s, c: campaign, ref, events: queue.map((blockId) => ({ kind: "IMPRESSION", blockId })) });
      queue = [];
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          const id = (en.target as HTMLElement).dataset.moaBlock;
          if (!en.isIntersecting || !id || seen.has(id)) continue;
          seen.add(id);
          queue.push(id);
          io.unobserve(en.target);
        }
      },
      { threshold: 0.5 },
    );
    document.querySelectorAll<HTMLElement>("[data-moa-block]").forEach((el) => io.observe(el));
    const timer = setInterval(flush, 1500);
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onHide);

    // 클릭 — 서버 기록 주소에 방문 표시 · 캠페인을 붙인다
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>("a[data-moa-click]");
      if (!a) return;
      flush();
      const u = new URL(a.href, location.href);
      u.searchParams.set("s", s);
      if (campaign) u.searchParams.set("c", campaign);
      a.href = u.toString();
    };
    document.addEventListener("click", onClick, true);

    return () => {
      flush();
      io.disconnect();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onHide);
      document.removeEventListener("click", onClick, true);
    };
  }, [pageId]);

  return null;
}
