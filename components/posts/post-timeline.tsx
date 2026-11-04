"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { FORMAT_LABEL, kstDay, type PostFormat } from "@/lib/post-analysis/stats";

// 언제 터졌나 — 게시물 하나가 점 하나. 세로축은 로그(한 칸 10배). 색은 한 가지만 쓰고 크기로 3배 · 10배를 가른다.
// 점이 수백 개라 점마다 링크를 달지 않고, 포인터에서 가장 가까운 점을 찾는다. 키보드로는 아래 목록을 쓴다.

export interface TimelineRow {
  id: string;
  format: PostFormat;
  title: string;
  url: string | null;
  postedAt: string | null;
  views: number | null;
  x: number | null;
}

const H = 260;
const PAD = { l: 44, r: 10, t: 10, b: 24 };
const HIT_PX = 22;
const DAY_MS = 86_400_000;
const KST_MS = 9 * 3600_000;

function short(n: number): string {
  if (n < 10_000) return n.toLocaleString("ko-KR");
  return `${n / 10_000}만`;
}

// 가로 눈금 — 길면 해마다, 1년 안팎이면 3개월마다, 짧으면 달마다
function dateTicks(start: number, now: number): { t: number; label: string }[] {
  const span = now - start;
  const stride = span > 900 * DAY_MS ? 12 : span > 200 * DAY_MS ? 3 : 1;
  const d = new Date(start + KST_MS);
  let month = d.getUTCFullYear() * 12 + d.getUTCMonth() + 1;
  while (month % stride) month++;
  const out: { t: number; label: string }[] = [];
  for (; ; month += stride) {
    const y = Math.floor(month / 12);
    const m = month % 12;
    const t = Date.UTC(y, m, 1) - KST_MS;
    if (t > now) break;
    out.push({ t, label: stride === 12 ? String(y) : m === 0 ? `${y}년 1월` : `${m + 1}월` });
  }
  return out;
}

export function PostTimeline({ rows, base, from, now }: { rows: TimelineRow[]; base: number | null; from: number; now: number }) {
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [W, setW] = useState(720);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!box.current) return;
    const observer = new ResizeObserver(([entry]) => setW(Math.max(280, Math.round(entry.contentRect.width))));
    observer.observe(box.current);
    return () => observer.disconnect();
  }, []);

  const chart = useMemo(() => {
    const list = rows.filter((r) => r.views && r.postedAt);
    if (list.length < 2) return null;
    const logs = list.map((r) => Math.log10(r.views as number));
    const logMax = Math.ceil(Math.max(...logs));
    const logMin = Math.floor(Math.min(...logs));
    const start = from || Math.min(...list.map((r) => Date.parse(r.postedAt as string)));
    // 소수 끝자리가 서버(Node)와 브라우저에서 달라 hydration이 어긋나므로 반올림한다
    const px = (n: number) => Math.round(n * 10) / 10;
    const tx = (t: number) => px(PAD.l + ((t - start) / Math.max(1, now - start)) * (W - PAD.l - PAD.r));
    const ty = (v: number) => px(H - PAD.b - ((Math.log10(Math.max(1, v)) - logMin) / Math.max(1, logMax - logMin)) * (H - PAD.t - PAD.b));
    const points = list
      .map((r) => ({ r, cx: tx(Date.parse(r.postedAt as string)), cy: ty(r.views as number), size: (r.x ?? 0) >= 10 ? 2 : (r.x ?? 0) >= 3 ? 1 : 0 }))
      .sort((a, b) => a.size - b.size); // 큰 점이 위로
    return {
      points,
      ty,
      yTicks: Array.from({ length: logMax - logMin + 1 }, (_, i) => 10 ** (logMin + i)),
      xTicks: dateTicks(start, now).map((d) => ({ ...d, x: tx(d.t) })),
    };
  }, [rows, from, now, W]);

  const nearest = (e: ReactPointerEvent<SVGSVGElement> | React.MouseEvent<SVGSVGElement>) => {
    if (!chart) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    const scale = W / Math.max(1, rect.width);
    const mx = (e.clientX - rect.left) * scale;
    const my = (e.clientY - rect.top) * scale;
    let best = null;
    let bestD = HIT_PX * HIT_PX;
    for (const p of chart.points) {
      const d = (p.cx - mx) ** 2 + (p.cy - my) ** 2;
      if (d <= bestD) {
        best = p;
        bestD = d;
      }
    }
    return best;
  };

  const hovered = chart?.points.find((p) => p.r.id === hoverId) ?? null;

  return (
    <div ref={box} className="relative">
      {!chart ? (
        <p className="py-8 text-center text-[13px] text-muted-foreground">이 기간에는 게시물이 적어 그래프를 그리지 않았어요.</p>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className={hovered ? "block w-full cursor-pointer" : "block w-full"}
            role="img"
            aria-label={`게시물 ${chart.points.length}개의 조회수 흐름. 아래 목록과 표에서 같은 값을 볼 수 있어요.`}
            onPointerMove={(e) => setHoverId(nearest(e)?.r.id ?? null)}
            onPointerLeave={() => setHoverId(null)}
            onClick={(e) => {
              const url = nearest(e)?.r.url;
              if (url) window.open(url, "_blank", "noopener,noreferrer");
            }}
          >
            {chart.yTicks.map((v) => (
              <g key={v}>
                <line x1={PAD.l} x2={W - PAD.r} y1={chart.ty(v)} y2={chart.ty(v)} className="stroke-border" strokeWidth={1} />
                <text x={PAD.l - 6} y={chart.ty(v) + 4} textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">
                  {short(v)}
                </text>
              </g>
            ))}
            {chart.xTicks.map((t) => (
              <text key={t.t} x={t.x} y={H - 7} textAnchor="middle" className="fill-muted-foreground text-[11px] tabular-nums">
                {t.label}
              </text>
            ))}
            {base != null && <line x1={PAD.l} x2={W - PAD.r} y1={chart.ty(base)} y2={chart.ty(base)} className="stroke-muted-foreground" strokeWidth={1} strokeDasharray="4 3" />}
            {chart.points.map((p) => (
              <circle key={p.r.id} cx={p.cx} cy={p.cy} r={[2.5, 4, 5.5][p.size]} className={p.size ? "fill-primary stroke-card" : "fill-faint"} strokeWidth={p.size ? 2 : 0} />
            ))}
            {hovered && <circle cx={hovered.cx} cy={hovered.cy} r={8} fill="none" className="stroke-foreground" strokeWidth={1.5} />}
          </svg>
          {hovered && (
            <div className="pointer-events-none absolute top-1 right-1 max-w-[280px] rounded-md border bg-card px-3 py-2 text-xs shadow-[0_8px_24px_rgb(16_24_40/.12),0_2px_6px_rgb(16_24_40/.08)]">
              <p className="line-clamp-2 font-medium">{hovered.r.title}</p>
              <p className="mt-0.5 text-muted-foreground tabular-nums">
                {FORMAT_LABEL[hovered.r.format]} · 조회 {(hovered.r.views as number).toLocaleString("ko-KR")}
                {hovered.r.x != null && ` · 평소의 ${hovered.r.x.toFixed(1)}배`} · {kstDay(hovered.r.postedAt as string)}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
