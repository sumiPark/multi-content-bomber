"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateAvatar, updatePageSettings } from "@/app/(dashboard)/moa/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { normalizeSlug, slugProblem } from "@/lib/moa/slug";
import type { MoaPageView } from "@/lib/moa/types";
import { ImageField } from "./image-field";

// 설정 — 주소 · 프로필 · 품절 상품 표시 · 최근 소개한 상품 개수.
// 주소를 바꾸면 옛 주소로 들어온 방문자도 새 페이지로 연결된다(moa_slug_redirects).

export function SettingsForm({ page, organizationId, canManage }: { page: MoaPageView; organizationId: string; canManage: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [slug, setSlug] = useState(page.slug);
  const [title, setTitle] = useState(page.title);
  const [bio, setBio] = useState(page.bio);
  const [hideSoldOut, setHideSoldOut] = useState(page.hideSoldOut);
  const [autoLimit, setAutoLimit] = useState(String(page.autoLimit));
  const [error, setError] = useState<string | null>(null);

  const normalized = normalizeSlug(slug);
  const slugError = normalized !== page.slug ? slugProblem(normalized) : null;

  const save = () => {
    setError(null);
    start(async () => {
      const res = await updatePageSettings({
        pageId: page.id,
        slug,
        title,
        bio,
        hideSoldOut,
        autoLimit: Number(autoLimit) || 20,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast(res.slug !== page.slug ? `저장했어요. 새 주소는 moa.cuma.co.kr/${res.slug}이고, 옛 주소도 연결돼요.` : "저장했어요.");
      router.refresh();
    });
  };

  const setAvatar = (url: string | null) =>
    start(async () => {
      const res = await updateAvatar({ pageId: page.id, url });
      if (!res.ok) return toast(res.error, "risk");
      toast(url ? "프로필 사진을 바꿨어요." : "프로필 사진을 지웠어요.");
      router.refresh();
    });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>프로필</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ImageField label="프로필 사진" value={page.avatarUrl} onChange={setAvatar} organizationId={organizationId} round />
          <div className="space-y-1.5">
            <Label htmlFor="moa-title">이름</Label>
            <Input id="moa-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="moa-bio">소개</Label>
            <Textarea id="moa-bio" value={bio} onChange={(e) => setBio(e.target.value)} rows={3} maxLength={300} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>주소</CardTitle>
          <CardDescription>프로필에 넣는 주소예요. 바꾸면 옛 주소로 들어온 방문자도 새 페이지로 연결돼요.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-1.5">
          <div className="flex max-w-md items-center gap-1">
            <span className="text-sm text-muted-foreground">moa.cuma.co.kr/</span>
            <Input value={slug} onChange={(e) => setSlug(e.target.value)} aria-label="주소" />
          </div>
          {normalized !== slug && !slugError && <p className="text-xs text-muted-foreground">저장하면 “{normalized}”로 바뀌어요.</p>}
          {slugError && <p className="text-xs text-risk">{slugError}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>상품 표시</CardTitle>
          <CardDescription>판매 상태는 3분마다 몰에서 확인해요. 다시 판매되면 품절 때문에 바뀐 카드만 자동으로 돌아와요.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <p className="text-sm font-medium">품절 · 판매 종료 상품</p>
            <Segmented
              ariaLabel="품절 상품 표시"
              value={hideSoldOut ? "hide" : "gray"}
              onChange={(v) => setHideSoldOut(v === "hide")}
              options={[
                { value: "gray", label: "회색 + “품절” 표시" },
                { value: "hide", label: "품절 상품 숨기기" },
              ]}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="moa-limit">최근 소개한 상품 최대 개수 (고정 제외)</Label>
            <Input id="moa-limit" type="number" min={1} max={100} value={autoLimit} onChange={(e) => setAutoLimit(e.target.value)} className="w-28" />
          </div>
        </CardContent>
      </Card>

      {canManage && (
        <div className="flex items-center justify-end gap-3">
          {error && <p className="text-xs text-risk">{error}</p>}
          <Button onClick={save} disabled={pending || !!slugError}>
            {pending ? "저장 중…" : "저장"}
          </Button>
        </div>
      )}
    </div>
  );
}
