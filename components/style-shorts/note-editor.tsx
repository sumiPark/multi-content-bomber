"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type KeyboardEvent, type MouseEvent } from "react";
import { Loader2, Pause, Pencil, Play, Send, X } from "lucide-react";
import { deleteNoteAction, saveNoteAction, sendRevisionAction } from "@/app/(dashboard)/style-shorts/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { NOTE_MAX, NOTES_PER_VERSION } from "@/lib/style-shorts/revise";
import { cn } from "@/lib/utils";

// 완성본 주석 수정 화면 — 영상을 멈추고 고칠 곳을 누르면 번호 동그라미가 생기고, 고칠 내용을 적어 Enter로 저장한다.
// 주석은 저장할 때마다 DB에 남고(나갔다 와도 이어 단다), "수정 요청 보내기"로 묶어 다음 버전을 만든다.

export interface NoteView {
  id: string;
  no: number;
  at: number | null;
  x: number | null;
  y: number | null;
  body: string;
}

interface Draft {
  at: number;
  x: number;
  y: number;
  text: string;
}

// 동그라미를 보여 주는 시각 범위(주석 시각 앞뒤)
const SHOW_WITHIN = 0.6;

export function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

/** 한글 입력 중 Enter(조합 확정)는 저장으로 보지 않는다. */
function isSubmit(e: KeyboardEvent<HTMLInputElement>): boolean {
  return e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229;
}

function NoteBadge({ no, className }: { no: number; className?: string }) {
  return (
    <span className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground tabular-nums", className)}>
      {no}
    </span>
  );
}

export function NoteEditor({
  versionId,
  version,
  videoUrl,
  coverUrl,
  initialNotes,
  onClose,
}: {
  versionId: string;
  version: number;
  videoUrl: string;
  coverUrl: string | null;
  initialNotes: NoteView[];
  onClose: () => void;
}) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [notes, setNotes] = useState<NoteView[]>(initialNotes);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [overall, setOverall] = useState("");
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sending, startSend] = useTransition();

  const nextNo = (notes.at(-1)?.no ?? 0) + 1;
  const full = notes.length >= NOTES_PER_VERSION;

  // Esc — 입력칸에 커서가 없어도 적고 있는 새 주석 · 고치던 주석을 취소한다
  useEffect(() => {
    if (!draft && !editing) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      setDraft(null);
      setEditing(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, editing]);

  const seek = (t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    v.currentTime = Math.max(0, Math.min(t, v.duration || t));
    setTime(v.currentTime);
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    setDraft(null);
    if (v.paused) void v.play();
    else v.pause();
  };

  // 영상을 누르면 멈추고 그 자리에 동그라미
  const placeCircle = (e: MouseEvent<HTMLDivElement>) => {
    const v = videoRef.current;
    if (!v || full) {
      if (full) toast(`주석은 한 번에 ${NOTES_PER_VERSION}개까지 달 수 있어요.`, "risk");
      return;
    }
    v.pause();
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    setEditing(null);
    setDraft({ at: v.currentTime, x, y, text: draft?.text ?? "" });
  };

  const save = async (input: { id?: string; at: number | null; x: number | null; y: number | null; body: string }): Promise<boolean> => {
    const body = input.body.trim();
    if (!body) return false;
    setSaving(true);
    const res = await saveNoteAction({ versionId, ...input, body });
    setSaving(false);
    if (!res.ok) {
      toast(res.error, "risk");
      return false;
    }
    setNotes((list) => {
      const rest = list.filter((n) => n.id !== res.id);
      return [...rest, { id: res.id, no: res.no, at: input.at, x: input.x, y: input.y, body }].sort((a, b) => a.no - b.no);
    });
    return true;
  };

  const saveDraft = async () => {
    if (!draft) return;
    if (await save({ at: draft.at, x: draft.x, y: draft.y, body: draft.text })) setDraft(null);
  };

  const saveEdit = async () => {
    if (!editing) return;
    const note = notes.find((n) => n.id === editing.id);
    if (!note) return setEditing(null);
    if (await save({ id: note.id, at: note.at, x: note.x, y: note.y, body: editing.text })) setEditing(null);
  };

  const saveOverall = async () => {
    if (full) return toast(`주석은 한 번에 ${NOTES_PER_VERSION}개까지 달 수 있어요.`, "risk");
    if (await save({ at: null, x: null, y: null, body: overall })) setOverall("");
  };

  const remove = async (id: string) => {
    setSaving(true);
    const res = await deleteNoteAction({ id });
    setSaving(false);
    if (!res.ok) return toast(res.error, "risk");
    // 서버와 같게 뒤 번호를 당긴다
    setNotes((list) => {
      const gone = list.find((n) => n.id === id);
      return list.filter((n) => n.id !== id).map((n) => (gone && n.no > gone.no ? { ...n, no: n.no - 1 } : n));
    });
    if (editing?.id === id) setEditing(null);
  };

  const send = () =>
    startSend(async () => {
      const res = await sendRevisionAction({ versionId });
      if (!res.ok) return toast(res.error, "risk");
      toast(res.warning ?? "수정 요청을 보냈어요. 고친 영상은 새 버전으로 추가돼요.", res.warning ? "risk" : "ok");
      onClose();
      router.refresh();
    });

  const visible = notes.filter((n) => n.at != null && n.x != null && n.y != null && Math.abs(n.at - time) <= SHOW_WITHIN);
  const total = duration || 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 md:flex-row">
        {/* 영상 + 동그라미 */}
        <div className="w-full max-w-[360px] shrink-0 space-y-2">
          <div className="relative aspect-[9/16] w-full overflow-hidden rounded-lg bg-black">
            <video
              ref={videoRef}
              src={videoUrl}
              poster={coverUrl ?? undefined}
              playsInline
              preload="auto"
              className="absolute inset-0 size-full object-contain"
              onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
              onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
            />
            <div className="absolute inset-0 cursor-crosshair" onClick={placeCircle} role="presentation" />
            {visible.map((n) => (
              <Circle key={n.id} no={n.no} x={n.x!} y={n.y!} onClick={() => seek(n.at!)} />
            ))}
            {draft && <Circle no={nextNo} x={draft.x} y={draft.y} active />}
          </div>

          {/* 재생 막대 — 주석 번호가 찍힌다 */}
          <div className="flex items-center gap-2">
            <Button type="button" size="icon" variant="outline" onClick={togglePlay} aria-label={playing ? "멈추기" : "재생"}>
              {playing ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
            </Button>
            <div className="relative h-8 flex-1">
              <input
                type="range"
                min={0}
                max={total}
                step={0.05}
                value={Math.min(time, total)}
                onChange={(e) => seek(Number(e.target.value))}
                aria-label="재생 위치"
                className="absolute inset-x-0 top-1 w-full accent-primary"
              />
              {duration > 0 &&
                notes
                  .filter((n) => n.at != null)
                  .map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => seek(n.at!)}
                      className="absolute top-5 -translate-x-1/2"
                      style={{ left: `${(n.at! / total) * 100}%` }}
                      aria-label={`${n.no}번 주석으로 이동`}
                    >
                      <NoteBadge no={n.no} className="size-5" />
                    </button>
                  ))}
            </div>
          </div>
          <p className="text-xs text-muted-foreground tabular-nums">
            {formatTime(time)} / {formatTime(duration)} · 영상을 누르면 멈추고 그 자리에 주석을 달아요
          </p>
        </div>

        {/* 주석 목록 */}
        <div className="min-w-0 flex-1 space-y-3">
          <p className="text-sm font-semibold">
            주석 {notes.length}개 <span className="font-normal text-muted-foreground">· v{version}에서 고칠 곳</span>
          </p>
          {notes.length === 0 && !draft && <p className="text-sm text-muted-foreground">아직 주석이 없어요. 영상을 멈추고 고칠 곳을 눌러 주세요.</p>}
          <ul className="space-y-2">
            {notes.map((n) => (
              <li key={n.id} className="flex items-start gap-2 rounded-md border bg-card p-2">
                <NoteBadge no={n.no} className="mt-0.5" />
                <div className="min-w-0 flex-1 space-y-1">
                  <button type="button" className="text-xs text-muted-foreground tabular-nums hover:text-foreground" onClick={() => n.at != null && seek(n.at)} disabled={n.at == null}>
                    {n.at == null ? "영상 전체" : formatTime(n.at)}
                  </button>
                  {editing?.id === n.id ? (
                    <Input
                      autoFocus
                      value={editing.text}
                      maxLength={NOTE_MAX}
                      disabled={saving}
                      onChange={(e) => setEditing({ id: n.id, text: e.target.value })}
                      onKeyDown={(e) => {
                        if (isSubmit(e)) {
                          e.preventDefault();
                          void saveEdit();
                        } else if (e.key === "Escape") setEditing(null);
                      }}
                    />
                  ) : (
                    <p className="whitespace-pre-line text-sm text-ink-2">{n.body}</p>
                  )}
                </div>
                <Button type="button" size="icon" variant="ghost" disabled={saving} onClick={() => setEditing({ id: n.id, text: n.body })} aria-label={`${n.no}번 주석 고치기`}>
                  <Pencil className="size-4" aria-hidden />
                </Button>
                <Button type="button" size="icon" variant="ghost" disabled={saving} onClick={() => void remove(n.id)} aria-label={`${n.no}번 주석 지우기`}>
                  <X className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
            {/* 영상에서 누른 자리의 새 주석 — 여기에 적는다 */}
            {draft && (
              <li className="flex items-start gap-2 rounded-md border border-primary bg-brand-soft p-2">
                <NoteBadge no={nextNo} className="mt-0.5" />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-xs text-muted-foreground tabular-nums">{formatTime(draft.at)}</p>
                  <Input
                    // 영상에서 자리를 다시 누르면 입력칸으로 돌아온다
                    key={`${draft.at}-${draft.x}-${draft.y}`}
                    autoFocus
                    value={draft.text}
                    maxLength={NOTE_MAX}
                    placeholder="고칠 내용을 적고 Enter"
                    disabled={saving}
                    onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                    onKeyDown={(e) => {
                      if (isSubmit(e)) {
                        e.preventDefault();
                        void saveDraft();
                      }
                    }}
                  />
                  <p className="text-xs text-muted-foreground">Enter로 저장 · Esc로 취소</p>
                </div>
                <Button type="button" size="icon" variant="ghost" disabled={saving} onClick={() => setDraft(null)} aria-label="이 주석 취소">
                  <X className="size-4" aria-hidden />
                </Button>
              </li>
            )}
          </ul>

          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">영상 전체 의견 (특정 장면이 아닌 것, 예: 음악을 더 밝게)</p>
            <Input
              value={overall}
              maxLength={NOTE_MAX}
              placeholder="적고 Enter"
              disabled={saving || full}
              onChange={(e) => setOverall(e.target.value)}
              onKeyDown={(e) => {
                if (isSubmit(e)) {
                  e.preventDefault();
                  void saveOverall();
                }
              }}
            />
          </div>
          <p className="text-xs text-muted-foreground">따옴표로 적은 글자는 고치지 않고 그대로 넣어요. 예: 자막을 &quot;딱 3분이면 끝&quot;으로</p>

          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={sending}>
              닫기
            </Button>
            <Button type="button" onClick={send} disabled={sending || saving || notes.length === 0 || !!draft}>
              {sending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
              수정 요청 보내기{notes.length > 0 && ` (${notes.length})`}
            </Button>
          </div>
          {draft && <p className="text-right text-xs text-muted-foreground">적고 있는 주석을 Enter로 저장하거나 Esc로 취소한 뒤 보낼 수 있어요.</p>}
        </div>
      </div>
    </div>
  );
}

function Circle({ no, x, y, active, onClick }: { no: number; x: number; y: number; active?: boolean; onClick?: () => void }) {
  return (
    <div className="pointer-events-none absolute z-[5]" style={{ left: `${x * 100}%`, top: `${y * 100}%` }}>
      <div className={cn("size-14 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-primary ring-2 ring-card", active && "animate-pulse")} />
      <button
        type="button"
        tabIndex={onClick ? 0 : -1}
        onClick={(e) => {
          e.stopPropagation();
          onClick?.();
        }}
        className={cn("absolute -top-11 left-3", onClick ? "pointer-events-auto" : "pointer-events-none")}
        aria-label={`${no}번 주석`}
      >
        <NoteBadge no={no} className="ring-2 ring-card" />
      </button>
    </div>
  );
}
