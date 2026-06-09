"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Check, Pencil, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RelativeTime } from "@/components/ui/relative-time";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  updateCaptionsAction,
  type UpdateCaptionsResult,
} from "@/app/(dashboard)/actions";
import type { Captions } from "@/lib/ai/caption-generator";
import {
  InstagramPreview,
  TiktokPreview,
  YoutubeShortsPreview,
} from "./caption-previews";

interface CaptionResultProps {
  contentId: string;
  captions: Captions;
  savedAt: string;
  thumbnails: string[];
  initialEditing?: boolean;
  /** 저장 성공 시 부모에게 최신 캡션/저장시각을 알린다 (업로드 마법사 상태 동기화용). */
  onSaved?: (captions: Captions, savedAt: string) => void;
}

export interface CaptionResultHandle {
  /**
   * 미저장 편집이 있으면 저장하고 성공 여부를 반환한다. 변경분이 없으면 true.
   * 마법사가 "다음 단계"로 넘어가기 전에 직접 작성 초안을 확정 저장하는 용도.
   */
  commit: () => Promise<boolean>;
}

type YoutubeDraft = {
  title: string;
  description: string;
  hashtagsText: string;
  category: string;
};
type InstagramDraft = {
  caption: string;
  hashtagsText: string;
};
type TiktokDraft = {
  caption: string;
};

function extractHashtags(text: string): string[] {
  const matches = text.match(/#[^\s#]+/g);
  return matches ?? [];
}

function mergeTiktokCaption(caption: string, hashtags: string[]): string {
  if (hashtags.length === 0) return caption;
  const allInCaption = hashtags.every((h) => caption.includes(h));
  if (allInCaption) return caption;
  const trimmed = caption.trim();
  return trimmed + (trimmed ? "\n\n" : "") + hashtags.join(" ");
}

type DraftCaptions = {
  youtube?: YoutubeDraft;
  instagram?: InstagramDraft;
  tiktok?: TiktokDraft;
};

function toDraft(c: Captions): DraftCaptions {
  return {
    youtube: c.youtube
      ? {
          title: c.youtube.title,
          description: c.youtube.description,
          hashtagsText: c.youtube.hashtags.join(" "),
          category: c.youtube.category ?? "",
        }
      : undefined,
    instagram: c.instagram
      ? {
          caption: c.instagram.caption,
          hashtagsText: c.instagram.hashtags.join(" "),
        }
      : undefined,
    tiktok: c.tiktok
      ? {
          caption: mergeTiktokCaption(c.tiktok.caption, c.tiktok.hashtags),
        }
      : undefined,
  };
}

function fromDraft(d: DraftCaptions): Captions {
  const splitHashtags = (s: string) =>
    s.trim().split(/\s+/).filter(Boolean);
  return {
    youtube: d.youtube
      ? {
          title: d.youtube.title.trim(),
          description: d.youtube.description.trim(),
          hashtags: splitHashtags(d.youtube.hashtagsText),
          category: d.youtube.category.trim(),
        }
      : undefined,
    instagram: d.instagram
      ? {
          caption: d.instagram.caption.trim(),
          hashtags: splitHashtags(d.instagram.hashtagsText),
        }
      : undefined,
    tiktok: d.tiktok
      ? {
          caption: d.tiktok.caption.trim(),
          hashtags: extractHashtags(d.tiktok.caption),
        }
      : undefined,
  };
}

export const CaptionResult = forwardRef<
  CaptionResultHandle,
  CaptionResultProps
>(function CaptionResult(
  {
    contentId,
    captions,
    savedAt,
    thumbnails,
    initialEditing = false,
    onSaved,
  },
  ref,
) {
  const [isEditing, setIsEditing] = useState(initialEditing);
  const [draft, setDraft] = useState<DraftCaptions>(() => toDraft(captions));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSaved, setLastSaved] = useState(savedAt);

  // 마지막으로 저장된(또는 외부에서 받은) 초안 스냅샷 — dirty 판정 기준.
  const [baseline, setBaseline] = useState(() =>
    JSON.stringify(toDraft(captions)),
  );

  // 외부에서 captions가 교체되면(재생성 등) 편집 초안을 새 값으로 다시 동기화한다.
  // 마운트 시점 prop은 useState 초기화로 이미 반영됐으므로, 이후 변경분만 따라간다.
  const lastCaptionsRef = useRef(captions);
  useEffect(() => {
    if (captions !== lastCaptionsRef.current) {
      lastCaptionsRef.current = captions;
      const synced = toDraft(captions);
      setBaseline(JSON.stringify(synced));
      setDraft(synced);
    }
  }, [captions]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== baseline,
    [draft, baseline],
  );

  const activeTabs = useMemo(() => {
    const tabs: Array<"youtube" | "instagram" | "tiktok"> = [];
    if (draft.youtube) tabs.push("youtube");
    if (draft.instagram) tabs.push("instagram");
    if (draft.tiktok) tabs.push("tiktok");
    return tabs;
  }, [draft]);

  // 실제 저장 로직 — 성공 여부 반환. 버튼/commit() 양쪽에서 재사용.
  const persist = useCallback(async (): Promise<boolean> => {
    setSaving(true);
    setError(null);
    const next = fromDraft(draft);
    const result: UpdateCaptionsResult = await updateCaptionsAction({
      contentId,
      captions: next,
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    setLastSaved(result.savedAt);
    setIsEditing(false);
    // 저장값으로 초안/기준선을 정규화해 dirty를 해제한다.
    const normalized = toDraft(next);
    lastCaptionsRef.current = next;
    setBaseline(JSON.stringify(normalized));
    setDraft(normalized);
    // 부모가 들고 있는 캡션 상태(예: 업로드 마법사)도 갱신해 검토 단계·단계 재진입 시 수정본이 유지되게 한다.
    onSaved?.(next, result.savedAt);
    return true;
  }, [draft, contentId, onSaved]);

  // 마법사가 단계를 넘기기 전 호출 — 미저장 편집이 있을 때만 저장한다.
  useImperativeHandle(
    ref,
    () => ({
      commit: async () => (dirty ? persist() : true),
    }),
    [dirty, persist],
  );

  function handleSave() {
    void persist();
  }

  function handleCancel() {
    setDraft(toDraft(captions));
    setIsEditing(false);
    setError(null);
  }

  if (activeTabs.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>AI 캡션</CardTitle>
          <CardDescription>저장된 캡션이 없습니다.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>AI 캡션</CardTitle>
            <CardDescription className="mt-1">
              플랫폼별 결과를 수정할 수 있습니다.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {!isEditing && (
              <Badge variant="secondary">
                저장됨 · <RelativeTime iso={lastSaved} />
              </Badge>
            )}
            {isEditing ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleCancel}
                  disabled={saving}
                >
                  <XIcon className="size-4" /> 취소
                </Button>
                <Button size="sm" onClick={handleSave} disabled={saving}>
                  <Check className="size-4" />
                  {saving ? "저장 중..." : "저장"}
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsEditing(true)}
              >
                <Pencil className="size-4" /> 수정
              </Button>
            )}
          </div>
        </div>
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </CardHeader>
      <CardContent className="space-y-6">
        {thumbnails.length > 0 && (
          <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
            {thumbnails.map((url, i) => (
              <li
                key={i}
                className="relative aspect-square overflow-hidden rounded-md border bg-muted"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={url}
                  alt={`이미지 ${i + 1}`}
                  className="size-full object-cover"
                />
                <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-xs font-medium text-white">
                  {i + 1}
                </span>
              </li>
            ))}
          </ul>
        )}

        <Tabs defaultValue={activeTabs[0]}>
          <TabsList
            className="grid w-full"
            style={{
              gridTemplateColumns: `repeat(${activeTabs.length}, minmax(0, 1fr))`,
            }}
          >
            {activeTabs.includes("youtube") && (
              <TabsTrigger value="youtube">YouTube</TabsTrigger>
            )}
            {activeTabs.includes("instagram") && (
              <TabsTrigger value="instagram">Instagram</TabsTrigger>
            )}
            {activeTabs.includes("tiktok") && (
              <TabsTrigger value="tiktok">TikTok</TabsTrigger>
            )}
          </TabsList>

          {draft.youtube && (
            <TabsContent value="youtube" className="pt-4">
              <div className="grid gap-6 lg:grid-cols-[1fr_240px]">
                <div className="space-y-4">
                  <Field
                    label="제목 (100자 이내)"
                    value={draft.youtube.title}
                    readOnly={!isEditing}
                    rows={1}
                    onChange={(v) =>
                      setDraft({
                        ...draft,
                        youtube: { ...draft.youtube!, title: v },
                      })
                    }
                  />
                  <Field
                    label="설명 (5000자 이내, 타임스탬프/CTA 포함)"
                    value={draft.youtube.description}
                    readOnly={!isEditing}
                    rows={6}
                    onChange={(v) =>
                      setDraft({
                        ...draft,
                        youtube: { ...draft.youtube!, description: v },
                      })
                    }
                  />
                  <Field
                    label="카테고리"
                    value={draft.youtube.category}
                    readOnly={!isEditing}
                    rows={1}
                    onChange={(v) =>
                      setDraft({
                        ...draft,
                        youtube: { ...draft.youtube!, category: v },
                      })
                    }
                  />
                  <Field
                    label="해시태그 (최대 15개)"
                    value={draft.youtube.hashtagsText}
                    readOnly={!isEditing}
                    rows={3}
                    onChange={(v) =>
                      setDraft({
                        ...draft,
                        youtube: { ...draft.youtube!, hashtagsText: v },
                      })
                    }
                  />
                </div>
                <div className="lg:sticky lg:top-4 lg:self-start">
                  <YoutubeShortsPreview
                    title={draft.youtube.title}
                    description={draft.youtube.description}
                    hashtags={draft.youtube.hashtagsText
                      .trim()
                      .split(/\s+/)
                      .filter(Boolean)}
                    thumbnailUrl={thumbnails[0]}
                  />
                </div>
              </div>
            </TabsContent>
          )}

          {draft.instagram && (
            <TabsContent value="instagram" className="pt-4">
              <div className="grid gap-6 lg:grid-cols-[1fr_240px]">
                <div className="space-y-4">
                  <Field
                    label="캡션 (2200자 이내)"
                    value={draft.instagram.caption}
                    readOnly={!isEditing}
                    rows={8}
                    onChange={(v) =>
                      setDraft({
                        ...draft,
                        instagram: { ...draft.instagram!, caption: v },
                      })
                    }
                  />
                  <Field
                    label="해시태그 (최대 20개)"
                    value={draft.instagram.hashtagsText}
                    readOnly={!isEditing}
                    rows={3}
                    onChange={(v) =>
                      setDraft({
                        ...draft,
                        instagram: { ...draft.instagram!, hashtagsText: v },
                      })
                    }
                  />
                </div>
                <div className="lg:sticky lg:top-4 lg:self-start">
                  <InstagramPreview
                    caption={draft.instagram.caption}
                    hashtags={draft.instagram.hashtagsText
                      .trim()
                      .split(/\s+/)
                      .filter(Boolean)}
                    thumbnailUrl={thumbnails[0]}
                  />
                </div>
              </div>
            </TabsContent>
          )}

          {draft.tiktok && (
            <TabsContent value="tiktok" className="pt-4">
              <div className="grid gap-6 lg:grid-cols-[1fr_240px]">
                <div className="space-y-4">
                  <Field
                    label="본문 (300자 이내, 해시태그 #는 본문 안에 직접 작성)"
                    value={draft.tiktok.caption}
                    readOnly={!isEditing}
                    rows={6}
                    onChange={(v) =>
                      setDraft({
                        ...draft,
                        tiktok: { ...draft.tiktok!, caption: v },
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    해시태그는 본문 안에 #으로 작성하세요. 저장 시 자동으로
                    추출되어 검색용 메타데이터에 포함됩니다.
                  </p>
                </div>
                <div className="lg:sticky lg:top-4 lg:self-start">
                  <TiktokPreview
                    caption={draft.tiktok.caption}
                    thumbnailUrl={thumbnails[0]}
                  />
                </div>
              </div>
            </TabsContent>
          )}
        </Tabs>
      </CardContent>
    </Card>
  );
});

function Field({
  label,
  value,
  readOnly,
  rows,
  onChange,
}: {
  label: string;
  value: string;
  readOnly: boolean;
  rows: number;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Textarea
        value={value}
        readOnly={readOnly}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        className={readOnly ? "cursor-default bg-muted/30" : ""}
      />
    </div>
  );
}
