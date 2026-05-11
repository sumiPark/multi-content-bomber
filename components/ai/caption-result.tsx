"use client";

import { useMemo, useState } from "react";
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
  cover_text: string;
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
          cover_text: c.instagram.cover_text ?? "",
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
          cover_text: d.instagram.cover_text.trim(),
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

export function CaptionResult({
  contentId,
  captions,
  savedAt,
  thumbnails,
  initialEditing = false,
}: CaptionResultProps) {
  const [isEditing, setIsEditing] = useState(initialEditing);
  const [draft, setDraft] = useState<DraftCaptions>(() => toDraft(captions));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSaved, setLastSaved] = useState(savedAt);

  const activeTabs = useMemo(() => {
    const tabs: Array<"youtube" | "instagram" | "tiktok"> = [];
    if (draft.youtube) tabs.push("youtube");
    if (draft.instagram) tabs.push("instagram");
    if (draft.tiktok) tabs.push("tiktok");
    return tabs;
  }, [draft]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    const result: UpdateCaptionsResult = await updateCaptionsAction({
      contentId,
      captions: fromDraft(draft),
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setLastSaved(result.savedAt);
    setIsEditing(false);
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
                    label="릴스 커버 텍스트"
                    value={draft.instagram.cover_text}
                    readOnly={!isEditing}
                    rows={1}
                    onChange={(v) =>
                      setDraft({
                        ...draft,
                        instagram: { ...draft.instagram!, cover_text: v },
                      })
                    }
                  />
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
                    coverText={draft.instagram.cover_text}
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
}

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
