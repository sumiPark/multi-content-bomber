"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ScanSearch } from "lucide-react";
import { requestProfileReviewAction } from "@/app/(dashboard)/account-review/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { Textarea } from "@/components/ui/textarea";
import type { ProfileManualInput, ProfileSnapshot } from "@/lib/account-review/types";

// 계정 점검 — 인스타가 알려 주지 않는 정보(하이라이트 · 고정 게시물 · 스토리 · 연락 버튼)를 넣고 채점을 요청한다.
// 이름 칸 · 소개 · 링크는 인스타에서 가져오고, 못 가져오면 여기에 직접 넣는다(넣은 값이 먼저).

type Tri = "yes" | "no" | "unknown";

const fromBool = (v: boolean | null | undefined): Tri => (v == null ? "unknown" : v ? "yes" : "no");
const toBool = (v: Tri): boolean | null => (v === "unknown" ? null : v === "yes");

function apiHint(snapshot: ProfileSnapshot | null, key: "name" | "bio" | "links"): string | null {
  if (!snapshot || snapshot.source[key] !== "api") return null;
  const v = key === "links" ? snapshot.links.join(", ") : snapshot[key];
  return v ? `인스타에서 가져왔어요: ${v.length > 40 ? `${v.slice(0, 40)}…` : v}` : "인스타에서 가져왔어요 (비어 있음)";
}

export function ReviewForm({
  accountId,
  initial,
  snapshot,
  busy,
}: {
  accountId: string;
  initial: ProfileManualInput;
  snapshot: ProfileSnapshot | null;
  busy: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const [highlights, setHighlights] = useState((initial.highlights ?? []).join("\n"));
  const [noHighlights, setNoHighlights] = useState(Array.isArray(initial.highlights) && initial.highlights.length === 0);
  const [pinned, setPinned] = useState<string>(initial.pinnedCount == null ? "unknown" : String(initial.pinnedCount));
  const [story, setStory] = useState<string>(initial.storyDaysPerWeek == null ? "" : String(initial.storyDaysPerWeek));
  const [contact, setContact] = useState<Tri>(fromBool(initial.contact));
  const [category, setCategory] = useState(initial.category ?? "");
  const [name, setName] = useState(initial.name ?? "");
  const [bio, setBio] = useState(initial.bio ?? "");
  const [links, setLinks] = useState((initial.links ?? []).join("\n"));

  // 인스타가 이름 칸 · 소개 · 링크를 안 줬거나, 전에 직접 넣었으면 처음부터 펼쳐 둔다
  const textMissing = !!snapshot && (["name", "bio", "links"] as const).some((k) => snapshot.source[k] !== "api");
  const textOpen = textMissing || !!(initial.name || initial.bio || initial.links?.length);

  const submit = () =>
    startTransition(async () => {
      setMessage(null);
      const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
      const result = await requestProfileReviewAction({
        accountId,
        manual: {
          highlights: noHighlights ? [] : lines(highlights).length ? lines(highlights) : null,
          pinnedCount: pinned === "unknown" ? null : Number(pinned),
          storyDaysPerWeek: story === "" ? null : Number(story),
          contact: toBool(contact),
          category: category.trim() || null,
          name: name.trim() || null,
          bio: bio.trim() ? bio : null,
          links: lines(links).length ? lines(links) : null,
        },
      });
      if (result.ok) {
        setMessage({ ok: true, text: "채점을 시작했어요. 1~2분 뒤 새로고침하세요." });
        router.refresh();
      } else {
        setMessage({ ok: false, text: result.error });
      }
    });

  return (
    <Card className="h-fit xl:sticky xl:top-[84px]">
      <CardHeader>
        <CardTitle>직접 넣는 정보</CardTitle>
        <CardDescription>인스타가 알려 주지 않는 것들이에요. 모르면 비워 두세요. 그 항목은 0점으로 세요.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor="rv-highlights">하이라이트 이름</Label>
          <Textarea
            id="rv-highlights"
            rows={4}
            value={highlights}
            disabled={noHighlights}
            onChange={(e) => setHighlights(e.target.value)}
            placeholder={"한 줄에 하나씩\n주문방법\n후기"}
          />
          <label className="flex items-center gap-2 text-[13px] text-ink-2">
            <input type="checkbox" checked={noHighlights} onChange={(e) => setNoHighlights(e.target.checked)} className="size-4 accent-primary" />
            하이라이트가 없어요
          </label>
        </div>

        <div className="space-y-1.5">
          <p className="text-sm font-medium">고정 게시물</p>
          <Segmented
            ariaLabel="고정 게시물 개수"
            value={pinned}
            onChange={setPinned}
            options={[
              { value: "0", label: "없음" },
              { value: "1", label: "1개" },
              { value: "2", label: "2개" },
              { value: "3", label: "3개" },
              { value: "unknown", label: "모름" },
            ]}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="rv-story">최근 7일 중 스토리 올린 날</Label>
          <select
            id="rv-story"
            value={story}
            onChange={(e) => setStory(e.target.value)}
            className="h-9 w-full rounded-md border border-input bg-card px-3 text-base focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none sm:text-[13px]"
          >
            <option value="">모름</option>
            {Array.from({ length: 8 }, (_, d) => (
              <option key={d} value={String(d)}>
                {d === 0 ? "안 올렸어요" : `${d}일`}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <p className="text-sm font-medium">연락 버튼 (메일 · 전화 · 카톡 채널)</p>
          <Segmented
            ariaLabel="연락 버튼"
            value={contact}
            onChange={setContact}
            options={[
              { value: "yes", label: "있어요" },
              { value: "no", label: "없어요" },
              { value: "unknown", label: "모름" },
            ]}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="rv-category">카테고리</Label>
          <Input id="rv-category" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="예: 쇼핑 및 리테일" />
        </div>

        <details open={textOpen} className="group rounded-md border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">이름 칸 · 소개 · 링크 직접 넣기</summary>
          <p className="mt-1 text-xs text-muted-foreground">
            보통은 인스타에서 가져와요. 못 가져왔거나 방금 고쳐서 바로 다시 채점하고 싶을 때만 넣으세요. 넣은 값이 먼저예요.
          </p>
          <div className="mt-3 space-y-3 pb-1">
            <div className="space-y-1.5">
              <Label htmlFor="rv-name">이름 칸 (굵은 글씨 줄)</Label>
              <Input id="rv-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 오늘과일 | 제철 과일 산지직송" />
              {apiHint(snapshot, "name") && <p className="text-xs text-muted-foreground">{apiHint(snapshot, "name")}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rv-bio">소개</Label>
              <Textarea id="rv-bio" rows={4} value={bio} onChange={(e) => setBio(e.target.value)} placeholder="줄바꿈까지 그대로 붙여 넣으세요" />
              {apiHint(snapshot, "bio") && <p className="text-xs text-muted-foreground">{apiHint(snapshot, "bio")}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rv-links">링크 (한 줄에 하나)</Label>
              <Textarea id="rv-links" rows={2} value={links} onChange={(e) => setLinks(e.target.value)} placeholder="https://" />
              {apiHint(snapshot, "links") && <p className="text-xs text-muted-foreground">{apiHint(snapshot, "links")}</p>}
            </div>
          </div>
        </details>

        <div className="space-y-1.5">
          <Button className="w-full" disabled={busy || isPending} onClick={submit}>
            <ScanSearch className="size-4" aria-hidden />
            {busy ? "채점 중이에요" : isPending ? "요청하는 중…" : "채점하기"}
          </Button>
          <p className="text-xs text-muted-foreground">채점은 1~2분 걸리고, AI 비용은 한 번에 100원 안쪽이에요.</p>
          {message && <p className={message.ok ? "text-xs text-ok" : "text-xs text-risk"}>{message.text}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
