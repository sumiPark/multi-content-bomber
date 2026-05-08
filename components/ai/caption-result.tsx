"use client";

import { useState } from "react";
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

interface CaptionResultProps {
  contentId: string;
  captions: Captions;
  savedAt: string;
  thumbnails: string[];
}

type DraftCaptions = {
  youtube: {
    title: string;
    description: string;
    hashtagsText: string;
    category: string;
  };
  instagram: {
    caption: string;
    hashtagsText: string;
    cover_text: string;
  };
  tiktok: {
    hook: string;
    caption: string;
    hashtagsText: string;
    sound_recommendation: string;
  };
};

function toDraft(c: Captions): DraftCaptions {
  return {
    youtube: {
      title: c.youtube.title,
      description: c.youtube.description,
      hashtagsText: c.youtube.hashtags.join(" "),
      category: c.youtube.category ?? "",
    },
    instagram: {
      caption: c.instagram.caption,
      hashtagsText: c.instagram.hashtags.join(" "),
      cover_text: c.instagram.cover_text ?? "",
    },
    tiktok: {
      hook: c.tiktok.hook,
      caption: c.tiktok.caption,
      hashtagsText: c.tiktok.hashtags.join(" "),
      sound_recommendation: c.tiktok.sound_recommendation ?? "",
    },
  };
}

function fromDraft(d: DraftCaptions): Captions {
  const splitHashtags = (s: string) =>
    s.trim().split(/\s+/).filter(Boolean);
  return {
    youtube: {
      title: d.youtube.title.trim(),
      description: d.youtube.description.trim(),
      hashtags: splitHashtags(d.youtube.hashtagsText),
      category: d.youtube.category.trim(),
    },
    instagram: {
      caption: d.instagram.caption.trim(),
      hashtags: splitHashtags(d.instagram.hashtagsText),
      cover_text: d.instagram.cover_text.trim(),
    },
    tiktok: {
      hook: d.tiktok.hook.trim(),
      caption: d.tiktok.caption.trim(),
      hashtags: splitHashtags(d.tiktok.hashtagsText),
      sound_recommendation: d.tiktok.sound_recommendation.trim(),
    },
  };
}

export function CaptionResult({
  contentId,
  captions,
  savedAt,
  thumbnails,
}: CaptionResultProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState<DraftCaptions>(() => toDraft(captions));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSaved, setLastSaved] = useState(savedAt);

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

        <Tabs defaultValue="instagram">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="youtube">YouTube</TabsTrigger>
            <TabsTrigger value="instagram">Instagram</TabsTrigger>
            <TabsTrigger value="tiktok">TikTok</TabsTrigger>
          </TabsList>

          <TabsContent value="youtube" className="space-y-4 pt-4">
            <Field
              label="제목 (100자 이내)"
              value={draft.youtube.title}
              readOnly={!isEditing}
              rows={1}
              onChange={(v) =>
                setDraft({
                  ...draft,
                  youtube: { ...draft.youtube, title: v },
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
                  youtube: { ...draft.youtube, description: v },
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
                  youtube: { ...draft.youtube, category: v },
                })
              }
            />
            <Field
              label="해시태그 (최대 30개)"
              value={draft.youtube.hashtagsText}
              readOnly={!isEditing}
              rows={3}
              onChange={(v) =>
                setDraft({
                  ...draft,
                  youtube: { ...draft.youtube, hashtagsText: v },
                })
              }
            />
          </TabsContent>

          <TabsContent value="instagram" className="space-y-4 pt-4">
            <Field
              label="릴스 커버 텍스트"
              value={draft.instagram.cover_text}
              readOnly={!isEditing}
              rows={1}
              onChange={(v) =>
                setDraft({
                  ...draft,
                  instagram: { ...draft.instagram, cover_text: v },
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
                  instagram: { ...draft.instagram, caption: v },
                })
              }
            />
            <Field
              label="해시태그 (최대 30개)"
              value={draft.instagram.hashtagsText}
              readOnly={!isEditing}
              rows={3}
              onChange={(v) =>
                setDraft({
                  ...draft,
                  instagram: { ...draft.instagram, hashtagsText: v },
                })
              }
            />
          </TabsContent>

          <TabsContent value="tiktok" className="space-y-4 pt-4">
            <Field
              label="훅 (첫 3초)"
              value={draft.tiktok.hook}
              readOnly={!isEditing}
              rows={1}
              onChange={(v) =>
                setDraft({
                  ...draft,
                  tiktok: { ...draft.tiktok, hook: v },
                })
              }
            />
            <Field
              label="본문 (hook + caption 합쳐서 300자 이내)"
              value={draft.tiktok.caption}
              readOnly={!isEditing}
              rows={4}
              onChange={(v) =>
                setDraft({
                  ...draft,
                  tiktok: { ...draft.tiktok, caption: v },
                })
              }
            />
            <Field
              label="사운드/효과 추천"
              value={draft.tiktok.sound_recommendation}
              readOnly={!isEditing}
              rows={1}
              onChange={(v) =>
                setDraft({
                  ...draft,
                  tiktok: { ...draft.tiktok, sound_recommendation: v },
                })
              }
            />
            <Field
              label="해시태그 (최대 5개, 바이럴 중심)"
              value={draft.tiktok.hashtagsText}
              readOnly={!isEditing}
              rows={2}
              onChange={(v) =>
                setDraft({
                  ...draft,
                  tiktok: { ...draft.tiktok, hashtagsText: v },
                })
              }
            />
          </TabsContent>
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
