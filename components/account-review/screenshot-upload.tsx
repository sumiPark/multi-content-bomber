"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ImageUp, PencilLine } from "lucide-react";
import { readProfileScreenshotAction, saveProfileFactsAction } from "@/app/(dashboard)/analytics/profile-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { Textarea } from "@/components/ui/textarea";
import type { ProfileManualInput } from "@/lib/account-review/types";

// 프로필 캡처 한 장 → AI가 하이라이트 · 고정 게시물 · 연락 버튼 · 카테고리를 읽음 → 사람이 확인 · 고침 →
// 저장하면 그 계정만 다시 채점. 캡처 없이 "직접 고치기"로 지금 값을 바로 고칠 수도 있다.

type Tri = "yes" | "no" | "unknown";
const fromBool = (v: boolean | null | undefined): Tri => (v == null ? "unknown" : v ? "yes" : "no");
const toBool = (v: Tri): boolean | null => (v === "unknown" ? null : v === "yes");

const MAX_WIDTH = 1080;
const MAX_BYTES = 900_000;

/** 휴대폰 캡처(1~5MB)를 가로 1080px JPEG로 줄인다 — 서버 액션 본문 한도(1MB) 안으로. */
async function shrink(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  let width = Math.min(MAX_WIDTH, bitmap.width);
  for (const quality of [0.82, 0.7, 0.6]) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = Math.round((bitmap.height * width) / bitmap.width);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (blob && blob.size <= MAX_BYTES) return blob;
    width = Math.round(width * 0.85);
  }
  throw new Error("이미지를 줄이지 못했어요. 다른 캡처로 해 주세요.");
}

export function ScreenshotUpload({ accountId, current }: { accountId: string; current: ProfileManualInput }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [isPending, startTransition] = useTransition();
  const [phase, setPhase] = useState<"idle" | "reading" | "confirm">("idle");
  const [notes, setNotes] = useState<string[]>([]);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const [highlights, setHighlights] = useState("");
  const [noHighlights, setNoHighlights] = useState(false);
  const [pinned, setPinned] = useState("unknown");
  const [contact, setContact] = useState<Tri>("unknown");
  const [category, setCategory] = useState("");
  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [links, setLinks] = useState("");

  const fill = (m: ProfileManualInput) => {
    setHighlights((m.highlights ?? []).join("\n"));
    setNoHighlights(Array.isArray(m.highlights) && m.highlights.length === 0);
    setPinned(m.pinnedCount == null ? "unknown" : String(m.pinnedCount));
    setContact(fromBool(m.contact));
    setCategory(m.category ?? "");
    setName(m.name ?? "");
    setBio(m.bio ?? "");
    setLinks((m.links ?? []).join("\n"));
  };

  const onFile = (file: File | undefined) => {
    if (!file) return;
    setMessage(null);
    setPhase("reading");
    startTransition(async () => {
      try {
        const fd = new FormData();
        fd.set("accountId", accountId);
        fd.set("image", await shrink(file), "profile.jpg");
        const r = await readProfileScreenshotAction(fd);
        if (!r.ok) {
          setPhase("idle");
          setMessage({ ok: false, text: r.error });
          return;
        }
        // 캡처에서 못 읽은 칸은 지금 값을 그대로 둔다
        fill({
          highlights: r.manual.highlights ?? current.highlights ?? null,
          pinnedCount: r.manual.pinnedCount ?? current.pinnedCount ?? null,
          contact: r.manual.contact ?? current.contact ?? null,
          category: r.manual.category ?? current.category ?? null,
          name: r.manual.name ?? current.name ?? null,
          bio: r.manual.bio ?? current.bio ?? null,
          links: r.manual.links ?? current.links ?? null,
        });
        setNotes(r.notes);
        setPhase("confirm");
      } catch (err) {
        setPhase("idle");
        setMessage({ ok: false, text: err instanceof Error ? err.message : "캡처를 올리지 못했어요." });
      } finally {
        if (fileRef.current) fileRef.current.value = "";
      }
    });
  };

  const save = () =>
    startTransition(async () => {
      const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
      const r = await saveProfileFactsAction({
        accountId,
        manual: {
          highlights: noHighlights ? [] : lines(highlights).length ? lines(highlights) : null,
          pinnedCount: pinned === "unknown" ? null : Number(pinned),
          contact: toBool(contact),
          category: category.trim() || null,
          name: name.trim() || null,
          bio: bio.trim() ? bio : null,
          links: lines(links).length ? lines(links) : null,
        },
      });
      if (r.ok) {
        setPhase("idle");
        setNotes([]);
        setMessage({ ok: true, text: "저장했어요. 1~2분 뒤 새로고침하면 새 점수가 보여요." });
        router.refresh();
      } else {
        setMessage({ ok: false, text: r.error });
      }
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="sr-only"
          aria-label="프로필 캡처 고르기"
          onChange={(e) => onFile(e.target.files?.[0])}
        />
        <Button variant="outline" size="sm" disabled={isPending} onClick={() => fileRef.current?.click()}>
          <ImageUp className="size-4" aria-hidden />
          {phase === "reading" ? "캡처 읽는 중…" : "프로필 캡처 올리기"}
        </Button>
        {phase !== "confirm" && (
          <Button
            variant="ghost"
            size="sm"
            disabled={isPending}
            onClick={() => {
              fill(current);
              setNotes([]);
              setMessage(null);
              setPhase("confirm");
            }}
          >
            <PencilLine className="size-4" aria-hidden />
            직접 고치기
          </Button>
        )}
        {message && <p className={message.ok ? "text-xs text-ok" : "text-xs text-risk"}>{message.text}</p>}
      </div>

      {phase === "confirm" && (
        <div className="space-y-4 rounded-lg border bg-card p-4">
          <div>
            <p className="text-sm font-semibold">읽은 값을 확인하세요</p>
            <p className="text-xs text-muted-foreground">틀린 건 고친 뒤 저장하세요. 모르는 칸은 비워 두면 점수에서 빼요.</p>
          </div>
          {notes.length > 0 && (
            <ul className="space-y-1 rounded-md bg-warn-soft px-3 py-2">
              {notes.map((n, i) => (
                <li key={i} className="flex items-start gap-1.5 text-xs text-ink-2">
                  <AlertTriangle className="mt-px size-3.5 shrink-0 text-warn" aria-hidden />
                  {n}
                </li>
              ))}
            </ul>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`hl-${accountId}`}>하이라이트 이름 (한 줄에 하나)</Label>
              <Textarea id={`hl-${accountId}`} rows={4} value={highlights} disabled={noHighlights} onChange={(e) => setHighlights(e.target.value)} />
              <label className="flex items-center gap-2 text-[13px] text-ink-2">
                <input type="checkbox" checked={noHighlights} onChange={(e) => setNoHighlights(e.target.checked)} className="size-4 accent-primary" />
                하이라이트가 없어요
              </label>
            </div>
            <div className="space-y-4">
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
                <p className="text-sm font-medium">연락 버튼 (이메일 · 전화 · 연락처)</p>
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
                <Label htmlFor={`cat-${accountId}`}>카테고리</Label>
                <Input id={`cat-${accountId}`} value={category} onChange={(e) => setCategory(e.target.value)} placeholder="예: 쇼핑 및 리테일" />
              </div>
            </div>
          </div>

          <details className="rounded-md border px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">이름 칸 · 소개 · 링크</summary>
            <p className="mt-1 text-xs text-muted-foreground">인스타가 알려 주면 그 값을 먼저 써요. 인스타가 안 줄 때만 이 값으로 채점해요.</p>
            <div className="mt-3 grid gap-3 pb-1 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`nm-${accountId}`}>이름 칸</Label>
                <Input id={`nm-${accountId}`} value={name} onChange={(e) => setName(e.target.value)} />
                <Label htmlFor={`ln-${accountId}`} className="pt-2">
                  링크 (한 줄에 하나)
                </Label>
                <Textarea id={`ln-${accountId}`} rows={2} value={links} onChange={(e) => setLinks(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`bio-${accountId}`}>소개</Label>
                <Textarea id={`bio-${accountId}`} rows={5} value={bio} onChange={(e) => setBio(e.target.value)} />
              </div>
            </div>
          </details>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={isPending} onClick={save}>
              저장하고 다시 채점
            </Button>
            <Button size="sm" variant="ghost" disabled={isPending} onClick={() => setPhase("idle")}>
              취소
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
