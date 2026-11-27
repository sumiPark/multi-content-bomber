"use client";

import { Badge } from "@/components/ui/badge";
import { DAY_MS, DoesChips, MonthDay, StatusBadge, Switch, Thumb, TriggerCell, captionTitle } from "./shared";
import type { AutomationView, ProductView } from "./types";

// 진행 중 · 끝남 표. 줄을 누르면 오른쪽 서랍이 열린다.
export function AutomationTable({
  rows,
  products,
  canManage,
  busyId,
  onOpen,
  onToggle,
}: {
  rows: AutomationView[];
  products: Record<string, ProductView>;
  canManage: boolean;
  busyId: string | null;
  onOpen: (a: AutomationView) => void;
  onToggle: (a: AutomationView, on: boolean) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1040px] border-collapse text-sm">
        <thead>
          <tr className="h-11 border-b bg-surface-2 text-left text-xs font-semibold whitespace-nowrap text-muted-foreground">
            <th className="px-3.5">게시물</th>
            <th className="px-3.5">상태</th>
            <th className="px-3.5">하는 일</th>
            <th className="px-3.5">반응할 댓글</th>
            <th className="px-3.5">DM 보냄 / 대상</th>
            <th className="px-3.5">확인 필요</th>
            <th className="px-3.5">끝나는 날</th>
            <th className="w-[72px] px-3.5">켜기</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => {
            const product = a.productId ? products[a.productId] : undefined;
            const c = a.config;
            const st = a.stats;
            const done = c.dm.on ? st.dmSent : st.replySent;
            return (
              <tr
                key={a.id}
                onClick={() => onOpen(a)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onOpen(a);
                }}
                tabIndex={0}
                className="cursor-pointer border-b tabular-nums outline-none last:border-b-0 hover:bg-surface-2 focus-visible:bg-surface-2"
              >
                <td className="h-[52px] px-3.5 py-2">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Thumb src={product?.image} />
                    <div className="min-w-0">
                      <div className="max-w-[260px] truncate font-medium">{captionTitle(a.caption)}</div>
                      <div className="text-xs text-muted-foreground">
                        {a.postedAt ? (
                          <>
                            <MonthDay iso={a.postedAt} /> 게시
                          </>
                        ) : (
                          "발행 전"
                        )}
                        {product && <> · {product.name}</>}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-3.5 py-2">
                  <StatusBadge a={a} />
                </td>
                <td className="px-3.5 py-2">
                  <DoesChips c={c} />
                </td>
                <td className="px-3.5 py-2">
                  <TriggerCell c={c} />
                </td>
                <td className="px-3.5 py-2 whitespace-nowrap">
                  {c.dm.on || c.reply.on ? (
                    <>
                      {!c.dm.on && <span className="text-xs text-muted-foreground">답글 </span>}
                      <b>{done}</b>
                      <span className="text-muted-foreground"> / {st.target}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </td>
                <td className="px-3.5 py-2">
                  {st.unknown > 0 ? <Badge variant="warn">{st.unknown}</Badge> : <span className="text-muted-foreground">0</span>}
                </td>
                <td className="px-3.5 py-2 whitespace-nowrap">
                  {a.endsAt ? (
                    <span className={a.status === "ENDED" ? "text-muted-foreground" : undefined}>
                      <MonthDay iso={a.endsAt} />
                    </span>
                  ) : a.status === "WAITING" ? (
                    <span className="text-xs text-muted-foreground">발행 후 {c.period.days}일</span>
                  ) : a.startsAt ? (
                    <MonthDay iso={new Date(new Date(a.startsAt).getTime() + c.period.days * DAY_MS)} />
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </td>
                <td className="px-3.5 py-2" onClick={(e) => e.stopPropagation()}>
                  {a.status === "ENDED" ? (
                    <span className="text-xs text-muted-foreground">끝남</span>
                  ) : (
                    <Switch
                      checked={a.status === "ACTIVE"}
                      disabled={!canManage || a.status === "WAITING" || busyId === a.id}
                      onChange={(on) => onToggle(a, on)}
                      label={a.status === "WAITING" ? "발행되면 시작해요" : "자동화 켜기"}
                    />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
