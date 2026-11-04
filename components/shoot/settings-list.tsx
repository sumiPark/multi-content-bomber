import Link from "next/link";
import { ChevronRight } from "lucide-react";

// 설정 목록 — 촬영 설정 · 자동 콘텐츠 설정이 같이 쓴다. 계정마다 영상 방향 · 쓸 상품 · 무엇을 저장해 뒀는지만 보여 주고, 누르면 상세에서 고친다.

export interface SettingsRow {
  accountId: string;
  name: string;
  role: string | null;
  // 방식별 한마디 — "기획 5개", "하루 2칸 · 08:00 · 21:00"
  meta: string;
  scopeLabels: string[];
  // 저장해 둔 항목 ("후킹 문구 2개", "말투" …). 비면 아직 안 정한 계정
  saved: string[];
}

export function SettingsList({ rows, basePath, emptyNote }: { rows: SettingsRow[]; basePath: string; emptyNote: string }) {
  return (
    <ul className="divide-y overflow-hidden rounded-lg border bg-card">
      {rows.map((r) => (
        <li key={r.accountId}>
          <Link href={`${basePath}/${r.accountId}`} className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-surface-2">
            <span className="min-w-0 flex-1 space-y-1.5">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-semibold">@{r.name}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {r.role ?? "방향 미정"} · {r.meta}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-1.5">
                {r.scopeLabels.map((l) => (
                  <span key={l} className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-2">
                    {l}
                  </span>
                ))}
              </span>
              <span className="block truncate text-xs text-muted-foreground">{r.saved.length > 0 ? `저장한 내용: ${r.saved.join(" · ")}` : emptyNote}</span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  );
}
