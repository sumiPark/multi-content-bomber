"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { ExternalLink, Film, Link2, RotateCcw, Trash2, Upload } from "lucide-react";
import { addInstagramReferenceAction, addUploadReferencesAction, removeReferenceAction, retryReferenceAction, type StyleResult } from "@/app/(dashboard)/style-shorts/actions";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { MAX_REFERENCE_BYTES, MAX_REFERENCES, parseInstagramUrl, REFERENCE_STATUS } from "@/lib/style-shorts/card";
import { mb, uploadVideo, videoType } from "@/lib/storage/resumable-upload";

// 레퍼런스 넣기(영상 파일 · 인스타 릴스 링크)와 분석 상태 목록.

export interface ReferenceRow {
  id: string;
  kind: "UPLOAD" | "INSTAGRAM";
  name: string;
  permalink: string | null;
  previewUrl: string | null;
  status: string;
  from: "VIDEO" | "COVER" | null;
  error: string | null;
  brief: {
    durationSec: number;
    avgShotSec: number | null;
    sfxPer10s: number | null;
    captionStyle: "sentence" | "keyword" | "none";
    notes: string;
    soundNote: string | null;
  } | null;
}

const CAPTION_LABEL = { sentence: "문장 자막", keyword: "낱말 자막", none: "자막 없음" } as const;

export function ReferencePanel({ folderId, uploadFolder, refs }: { folderId: string; uploadFolder: string; refs: ReferenceRow[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<{ index: number; total: number; pct: number } | null>(null);
  const [link, setLink] = useState({ url: "", username: "" });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const room = MAX_REFERENCES - refs.length;
  const needsUsername = !!link.url && !!parseInstagramUrl(link.url) && !parseInstagramUrl(link.url)?.username;

  // 올리는 중에 화면을 떠나면 업로드가 멈춘다 — 떠나기 전에 묻는다
  useEffect(() => {
    if (!progress) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [progress]);

  const report = (res: StyleResult, done: string) => {
    if (!res.ok) {
      setError(res.error);
      return false;
    }
    setError(null);
    toast(res.warning ?? done, res.warning ? "risk" : "ok");
    router.refresh();
    return true;
  };

  const onFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    const files = [...list];
    const problems: string[] = [];
    if (files.length > room) problems.push(`레퍼런스는 폴더마다 ${MAX_REFERENCES}개까지라 앞의 ${Math.max(room, 0)}개만 올려요.`);
    const queue = files.slice(0, Math.max(room, 0)).filter((f) => {
      if (!videoType(f)) return problems.push(`${f.name}: MP4 · MOV 영상만 올릴 수 있어요.`) && false;
      if (f.size > MAX_REFERENCE_BYTES) return problems.push(`${f.name}: 파일이 너무 커요 (${mb(f.size)}). 하나에 ${mb(MAX_REFERENCE_BYTES)}까지예요.`) && false;
      return true;
    });
    const uploaded: { path: string; name: string }[] = [];
    for (const [i, file] of queue.entries()) {
      setProgress({ index: i + 1, total: queue.length, pct: 0 });
      try {
        const path = await uploadVideo(file, uploadFolder, (sent, total) => setProgress({ index: i + 1, total: queue.length, pct: total ? Math.round((sent / total) * 100) : 0 }));
        uploaded.push({ path, name: file.name });
      } catch (err) {
        problems.push(`${file.name}: ${err instanceof Error ? err.message : "올리지 못했어요"}`);
      }
    }
    setProgress(null);
    if (inputRef.current) inputRef.current.value = "";
    if (uploaded.length) {
      const res = await addUploadReferencesAction({ folderId, files: uploaded });
      if (!report(res, `레퍼런스 ${uploaded.length}개를 넣었어요. 분석을 시작해요`)) return;
    }
    setError(problems.length ? problems.join("\n") : null);
  };

  const addLink = () =>
    start(async () => {
      const res = await addInstagramReferenceAction({ folderId, url: link.url, username: link.username || undefined });
      if (report(res, "릴스 링크를 넣었어요. 분석을 시작해요")) setLink({ url: "", username: "" });
    });

  const act = (fn: () => Promise<StyleResult>, done: string) =>
    start(async () => {
      report(await fn(), done);
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>레퍼런스</CardTitle>
        <CardDescription>
          따라 하고 싶은 릴스를 넣어 주세요. 영상 파일이 가장 정확해요. 인스타 링크는 저작권 음원이 든 릴스면 영상을 받지 못해 표지 · 캡션만 분석해요. 스타일만 참고하고 레퍼런스의 화면 · 소리는 쓰지 않아요.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-3">
          <input ref={inputRef} type="file" accept="video/mp4,video/quicktime,.mp4,.mov" multiple className="hidden" onChange={(e) => void onFiles(e.target.files)} />
          <Button variant="outline" className="w-full" disabled={room <= 0 || !!progress} onClick={() => inputRef.current?.click()}>
            <Upload className="size-4" aria-hidden />
            {progress ? `올리는 중 ${progress.index}/${progress.total} · ${progress.pct}%` : "영상 파일 올리기 (MP4 · MOV)"}
          </Button>
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              addLink();
            }}
          >
            <div className="flex gap-2">
              <Input
                value={link.url}
                onChange={(e) => setLink({ ...link, url: e.target.value })}
                placeholder="예시: https://www.instagram.com/reel/…"
                className="placeholder:text-faint"
                aria-label="인스타 릴스 주소"
                disabled={room <= 0}
              />
              <Button type="submit" variant="outline" disabled={pending || room <= 0 || !link.url.trim() || (needsUsername && !link.username.trim())}>
                <Link2 className="size-4" aria-hidden />
                넣기
              </Button>
            </div>
            {needsUsername && (
              <Input
                value={link.username}
                onChange={(e) => setLink({ ...link, username: e.target.value })}
                placeholder="릴스를 올린 계정 아이디 (예시: @brand_official)"
                className="placeholder:text-faint"
                aria-label="계정 아이디"
              />
            )}
          </form>
          <p className="text-xs text-muted-foreground tabular-nums">
            {refs.length}/{MAX_REFERENCES}개 · 2~5개를 넣으면 공통 스타일이 잘 잡혀요
          </p>
          {error && <p className="whitespace-pre-line text-xs text-risk">{error}</p>}
        </div>

        {refs.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {refs.map((r, i) => {
              const s = REFERENCE_STATUS[r.status] ?? { label: r.status, variant: "secondary" as const };
              return (
                <li key={r.id} className="flex gap-3 p-3">
                  {r.previewUrl ? (
                    <video src={r.previewUrl} muted playsInline preload="metadata" controls className="h-28 w-16 shrink-0 rounded bg-black object-cover" />
                  ) : (
                    <span className="flex h-28 w-16 shrink-0 items-center justify-center rounded bg-muted">
                      <Film className="size-5 text-muted-foreground" aria-hidden />
                    </span>
                  )}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-sm font-semibold tabular-nums">{i + 1}.</span>
                      <span className="truncate text-sm font-semibold">{r.name}</span>
                      <Badge variant={s.variant}>{s.label}</Badge>
                      {r.from === "COVER" && <Badge variant="warn">표지 · 캡션만</Badge>}
                    </div>
                    {r.brief && r.from === "VIDEO" && (
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {r.brief.durationSec}초 · 평균 컷 {r.brief.avgShotSec}초 · 효과음 10초당 {r.brief.sfxPer10s ?? "-"}개 · {CAPTION_LABEL[r.brief.captionStyle]}
                      </p>
                    )}
                    {r.brief?.notes && <p className="text-sm text-ink-2">{r.brief.notes}</p>}
                    {r.brief?.soundNote && <p className="text-xs text-warn">{r.brief.soundNote}</p>}
                    {r.error && <p className="text-xs text-risk">{r.error}</p>}
                    <div className="flex flex-wrap gap-1 pt-1">
                      {r.permalink && (
                        <a href={r.permalink} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "ghost", size: "sm" })}>
                          <ExternalLink className="size-4" aria-hidden />
                          릴스 열기
                        </a>
                      )}
                      {r.status === "FAILED" && (
                        <Button variant="ghost" size="sm" disabled={pending} onClick={() => act(() => retryReferenceAction({ id: r.id }), "다시 분석해요")}>
                          <RotateCcw className="size-4" aria-hidden />
                          다시 분석
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" disabled={pending || r.status === "ANALYZING"} onClick={() => act(() => removeReferenceAction({ id: r.id }), "레퍼런스를 제외했어요")}>
                        <Trash2 className="size-4" aria-hidden />
                        빼기
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
