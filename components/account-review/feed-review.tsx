import { AlertTriangle, CheckCircle2, MinusCircle } from "lucide-react";
import type { FeedCheckId, FeedReview, FeedVerdict } from "@/lib/account-review/types";
import { cn } from "@/lib/utils";

// 프로필 점수 카드 안의 피드 진열 분석 — AI가 본 합성 이미지와 4개 관점 판정, 앞으로 할 일. 서버 컴포넌트.

const CHECK_LABEL: Record<FeedCheckId, string> = {
  unity: "통일감",
  legibility: "글자 가독성",
  identity: "한눈에 보이는 정체성",
  rhythm: "구성 리듬",
};

// 색만으로 전달하지 않게 아이콘 · 글자도 함께 (DESIGN.md 1-4)
const VERDICT: Record<FeedVerdict, { label: string; text: string; Icon: typeof CheckCircle2 }> = {
  good: { label: "좋음", text: "text-ok", Icon: CheckCircle2 },
  mixed: { label: "보통", text: "text-warn", Icon: MinusCircle },
  poor: { label: "고칠 것", text: "text-risk", Icon: AlertTriangle },
};

export function FeedReviewSection({
  review,
  imageUrl,
  pinnedCount,
}: {
  review: FeedReview;
  imageUrl: string | null;
  pinnedCount: number | null;
}) {
  return (
    <section aria-label="피드 진열 분석" className="space-y-3 border-t pt-5">
      <div>
        <h3 className="text-sm font-semibold">피드 진열 분석</h3>
        <p className="text-xs text-muted-foreground">
          최근 게시물 표지 {review.cells}장을 실제 피드처럼 이어 붙여 봤어요. 앱에서 잘리는 모습과 조금 다를 수 있어요.
          {pinnedCount ? ` 고정 게시물 ${pinnedCount}개는 이 순서에 반영되지 않았어요.` : ""}
        </p>
      </div>
      <div className="grid gap-5 md:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[260px_minmax(0,1fr)]">
        <div className="overflow-hidden rounded-md border bg-surface-3">
          {imageUrl ? (
            // 저장소 서명 주소 — next/image 도메인 설정 없이 그대로 쓴다.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={imageUrl} alt={`최근 게시물 표지 ${review.cells}장을 3열로 이어 붙인 피드`} loading="lazy" className="block w-full" />
          ) : (
            <p className="p-4 text-xs text-muted-foreground">피드 이미지를 불러오지 못했어요.</p>
          )}
        </div>
        <div className="min-w-0 space-y-4">
          {review.summary && <p className="max-w-3xl text-sm text-ink-2">{review.summary}</p>}
          <ul className="grid gap-x-6 gap-y-3 xl:grid-cols-2">
            {review.checks.map((c) => {
              const v = VERDICT[c.verdict];
              return (
                <li key={c.id} className="min-w-0">
                  <p className="flex items-center gap-1.5 text-[13px] font-medium">
                    {CHECK_LABEL[c.id]}
                    <span className={cn("inline-flex items-center gap-1 text-xs font-semibold", v.text)}>
                      <v.Icon className="size-3.5" aria-hidden />
                      {v.label}
                    </span>
                  </p>
                  <p className="mt-0.5 text-[13px] text-ink-2">{c.finding}</p>
                </li>
              );
            })}
          </ul>
          {review.suggestions.length > 0 && (
            <div className="rounded-md bg-surface-2 px-3 py-2.5">
              <p className="text-xs font-semibold text-muted-foreground">앞으로 이렇게 해 보세요</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[13px] text-ink-2">
                {review.suggestions.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
