"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { ArrowDown, ArrowUp, Clapperboard, Film, Trash2, Upload } from "lucide-react";
import { createJobAction } from "@/app/(dashboard)/style-shorts/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { mb, uploadVideo, videoType } from "@/lib/storage/resumable-upload";
import { CONCEPT_MAX, MAX_CLIP_BYTES, MAX_CLIPS, SCRIPT_MAX, type JobClip } from "@/lib/style-shorts/jobs";
import { createClient } from "@/lib/supabase/client";

// 새 쇼츠 만들기 — 스타일 폴더 · 소리 모드 · 촬영본 · 대본 · 컨셉. 촬영본은 고르는 즉시 올리고, 만들기를 누르면 편집이 시작된다.

export interface FolderOption {
  id: string;
  name: string;
  summary: string | null;
  ready: boolean;
}

type Voice = "AI" | "LIVE";
type Item = JobClip & { key: string; pct: number | null; error: string | null };

export function MakeShortForm({ folders, uploadRoot }: { folders: FolderOption[]; uploadRoot: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  // 이번 만들기의 업로드 폴더 — 서버가 경로를 이 값으로 확인한다
  const [draftId] = useState(() => crypto.randomUUID());
  const ready = folders.filter((f) => f.ready);
  const [folderId, setFolderId] = useState(ready[0]?.id ?? "");
  const [voice, setVoice] = useState<Voice>("AI");
  const [title, setTitle] = useState("");
  const [script, setScript] = useState("");
  const [concept, setConcept] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const uploading = items.some((i) => i.pct != null && i.pct < 100 && !i.error);
  const done = items.filter((i) => i.path && !i.error);
  const folder = useMemo(() => folders.find((f) => f.id === folderId), [folders, folderId]);

  useEffect(() => {
    if (!uploading) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploading]);

  const patch = (key: string, p: Partial<Item>) => setItems((list) => list.map((i) => (i.key === key ? { ...i, ...p } : i)));

  const onFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    const room = MAX_CLIPS - items.length;
    const problems: string[] = [];
    if (list.length > room) problems.push(`촬영본은 ${MAX_CLIPS}개까지라 앞의 ${Math.max(room, 0)}개만 올려요.`);
    const files = [...list].slice(0, Math.max(room, 0)).filter((f) => {
      if (!videoType(f)) return problems.push(`${f.name}: MP4 · MOV 영상만 올릴 수 있어요.`) && false;
      if (f.size > MAX_CLIP_BYTES) return problems.push(`${f.name}: 파일이 너무 커요 (${mb(f.size)}). 하나에 1GB까지예요.`) && false;
      return true;
    });
    setError(problems.length ? problems.join("\n") : null);
    if (inputRef.current) inputRef.current.value = "";
    const added = files.map((f) => ({ file: f, item: { key: crypto.randomUUID(), path: "", name: f.name, size: f.size, pct: 0, error: null } as Item }));
    setItems((cur) => [...cur, ...added.map((a) => a.item)]);
    // 하나씩 차례로 올린다 — 휴대폰에서 여러 개를 동시에 올리면 자주 끊긴다
    for (const { file, item } of added) {
      try {
        const path = await uploadVideo(file, `${uploadRoot}/${draftId}`, (sent, total) => patch(item.key, { pct: total ? Math.round((sent / total) * 100) : 0 }));
        patch(item.key, { path, pct: 100 });
      } catch (err) {
        patch(item.key, { error: err instanceof Error ? err.message : "올리지 못했어요", pct: null });
      }
    }
  };

  const move = (i: number, d: -1 | 1) =>
    setItems((list) => {
      const next = [...list];
      const j = i + d;
      if (j < 0 || j >= next.length) return list;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const remove = (item: Item) => {
    setItems((list) => list.filter((i) => i.key !== item.key));
    if (item.path) void createClient().storage.from("media").remove([item.path]);
  };

  const submit = () =>
    start(async () => {
      const res = await createJobAction({
        folderId,
        draftId,
        title: title || undefined,
        voiceMode: voice,
        script: script || undefined,
        concept: concept || undefined,
        clips: done.map((i) => ({ path: i.path, name: i.name, size: i.size })),
      });
      if (!res.ok) return setError(res.error);
      toast(res.warning ?? "편집을 시작했어요", res.warning ? "risk" : "ok");
      router.push(`/style-shorts/jobs/${res.id}`);
    });

  if (!ready.length) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
          <Clapperboard className="size-9 text-muted-foreground" aria-hidden />
          <h3 className="text-base font-semibold">스타일 카드가 완성된 폴더가 없어요</h3>
          <p className="max-w-md text-sm text-muted-foreground">아래 스타일 폴더에 레퍼런스를 넣고 카드가 완성되면 쇼츠를 만들 수 있어요.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>새 쇼츠 만들기</CardTitle>
        <CardDescription>찍은 영상을 올리면 고른 스타일 카드대로 컷 · 자막 · 그래픽 · 효과음 · 음악을 넣어 편집해요. 몇 분 걸려요.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-5 lg:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="space-y-4">
            <label className="block space-y-1">
              <span className="text-xs font-semibold text-muted-foreground">스타일 폴더</span>
              <select value={folderId} onChange={(e) => setFolderId(e.target.value)} className="h-9 w-full rounded-md border border-input bg-card px-3 text-sm">
                {folders.map((f) => (
                  <option key={f.id} value={f.id} disabled={!f.ready}>
                    {f.name}
                    {f.ready ? "" : " (카드 준비 중)"}
                  </option>
                ))}
              </select>
              {folder?.summary && <span className="block text-xs text-muted-foreground">{folder.summary}</span>}
            </label>
            <div className="space-y-1">
              <span className="block text-xs font-semibold text-muted-foreground">소리</span>
              <Segmented<Voice>
                ariaLabel="소리"
                value={voice}
                onChange={setVoice}
                options={[
                  { value: "AI", label: "AI 음성" },
                  { value: "LIVE", label: "영상 내 음성" },
                ]}
              />
              <span className="block text-xs text-muted-foreground">
                {voice === "AI"
                  ? "AI 음성이 대본을 읽어요. 대본이 없으면 컨셉과 화면을 보고 AI가 써요. 원본 소리는 쓰지 않아요."
                  : "찍을 때 말한 소리를 그대로 살리고, NG · 무음 · 되풀이한 구간은 잘라요. 자막은 받아쓰기로 넣어요."}
              </span>
            </div>
            <label className="block space-y-1">
              <span className="text-xs font-semibold text-muted-foreground">제목 (선택)</span>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} placeholder="예시: 아침 루틴 1편" className="placeholder:text-faint" />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-semibold text-muted-foreground">대본 (선택)</span>
              <Textarea
                value={script}
                onChange={(e) => setScript(e.target.value)}
                maxLength={SCRIPT_MAX}
                rows={5}
                placeholder={voice === "AI" ? "넣으면 내용 그대로 AI 음성이 읽어요." : "찍을 때 말하려던 내용. 받아쓰기 맞춤법과 컷 순서를 정할 때 참고해요."}
                className="placeholder:text-faint"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-semibold text-muted-foreground">컨셉 (선택)</span>
              <Textarea
                value={concept}
                onChange={(e) => setConcept(e.target.value)}
                maxLength={CONCEPT_MAX}
                rows={3}
                placeholder="예시: 바쁜 아침에 5분 만에 끝내는 느낌, 차분한 말투"
                className="placeholder:text-faint"
              />
              <span className="block text-xs text-muted-foreground">형식(컷 · 자막 · 소리)은 스타일 카드를, 내용 · 말투는 컨셉을 따라요.</span>
            </label>
          </div>

          <div className="space-y-3">
            <span className="block text-xs font-semibold text-muted-foreground">촬영본 (편집 순서대로)</span>
            <input ref={inputRef} type="file" accept="video/mp4,video/quicktime,.mp4,.mov" multiple className="hidden" onChange={(e) => void onFiles(e.target.files)} />
            <Button type="button" variant="outline" className="w-full" disabled={items.length >= MAX_CLIPS} onClick={() => inputRef.current?.click()}>
              <Upload className="size-4" aria-hidden />
              촬영본 올리기 (MP4 · MOV)
            </Button>
            {items.length > 0 && (
              <ul className="divide-y rounded-lg border">
                {items.map((it, i) => (
                  <li key={it.key} className="flex items-center gap-2 px-3 py-2">
                    <Film className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        <span className="tabular-nums">{i + 1}.</span> {it.name}
                      </span>
                      <span className={`block text-xs tabular-nums ${it.error ? "text-risk" : "text-muted-foreground"}`}>
                        {it.error ?? (it.pct != null && it.pct < 100 ? `올리는 중 ${it.pct}%` : `${mb(it.size)} · 올림`)}
                      </span>
                    </span>
                    <Button type="button" variant="ghost" size="sm" aria-label="앞으로" disabled={i === 0} onClick={() => move(i, -1)}>
                      <ArrowUp className="size-4" />
                    </Button>
                    <Button type="button" variant="ghost" size="sm" aria-label="뒤로" disabled={i === items.length - 1} onClick={() => move(i, 1)}>
                      <ArrowDown className="size-4" />
                    </Button>
                    <Button type="button" variant="ghost" size="sm" aria-label="빼기" onClick={() => remove(it)}>
                      <Trash2 className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground tabular-nums">
              {done.length}/{MAX_CLIPS}개 · 원본은 30일 뒤 지워지고 완성본은 계속 보관해요
            </p>
            {error && <p className="whitespace-pre-line text-xs text-risk">{error}</p>}
            <Button type="submit" size="lg" className="w-full" disabled={pending || uploading || !done.length || !folderId}>
              <Clapperboard className="size-4" aria-hidden />
              {uploading ? "촬영본을 올리는 중이에요" : "만들기"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
