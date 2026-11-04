import Link from "next/link";
import { ChevronRight } from "lucide-react";

// 촬영 설정 목록 — 계정마다 역할 · 쓸 상품 · 무엇을 저장해 뒀는지만 보여 주고, 누르면 상세에서 고친다.

export interface ShootSettingsRow {
  accountId: string;
  name: string;
  role: string | null;
  scopeLabels: string[];
  // 저장해 둔 컨셉 항목 ("후킹 문구 2개", "말투" …). 비면 아직 안 정한 계정
  saved: string[];
  ideaCount: number;
}

export function ShootSettingsList({ rows }: { rows: ShootSettingsRow[] }) {
  return (
    <ul className="divide-y overflow-hidden rounded-lg border bg-card">
      {rows.map((r) => (
        <li key={r.accountId}>
          <Link href={`/shoot/settings/${r.accountId}`} className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-surface-2">
            <span className="min-w-0 flex-1 space-y-1.5">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-semibold">@{r.name}</span>
                <span className="text-xs text-muted-foreground">
                  {r.role ?? "역할 미정"} · 기획 {r.ideaCount}개
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-1.5">
                {r.scopeLabels.map((l) => (
                  <span key={l} className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-2">
                    {l}
                  </span>
                ))}
              </span>
              <span className="block truncate text-xs text-muted-foreground">{r.saved.length > 0 ? `저장한 컨셉: ${r.saved.join(" · ")}` : "컨셉을 아직 안 정했어요. AI가 기본으로 기획해요."}</span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  );
}
