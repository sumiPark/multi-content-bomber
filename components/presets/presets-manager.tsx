"use client";

import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import {
  createPresetAction,
  deletePresetAction,
  updatePresetAction,
  type PresetActionResult,
} from "@/app/(dashboard)/presets/actions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface Preset {
  id: string;
  name: string;
  description: string | null;
  instructions: string;
  created_by: string | null;
  updated_at: string;
}

interface PresetsManagerProps {
  presets: Preset[];
  currentUserId: string;
  isAdmin: boolean;
}

export function PresetsManager({
  presets,
  currentUserId,
  isAdmin,
}: PresetsManagerProps) {
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-4">
      {creating ? (
        <PresetForm
          mode="create"
          onClose={() => setCreating(false)}
        />
      ) : (
        <Button onClick={() => setCreating(true)}>
          <Plus className="size-4" /> 새 프리셋
        </Button>
      )}

      {presets.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            아직 프리셋이 없어요. 위에서 첫 프리셋을 만들어보세요.
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-3">
          {presets.map((p) => (
            <li key={p.id}>
              <PresetCard
                preset={p}
                canEdit={isAdmin || p.created_by === currentUserId}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PresetCard({ preset, canEdit }: { preset: Preset; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <PresetForm
        mode="edit"
        initialValues={preset}
        onClose={() => setEditing(false)}
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>{preset.name}</CardTitle>
            {preset.description && (
              <CardDescription className="mt-1">
                {preset.description}
              </CardDescription>
            )}
          </div>
          {canEdit && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditing(true)}
              >
                <Pencil className="size-4" /> 수정
              </Button>
              <DeleteButton id={preset.id} name={preset.name} />
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">
          {preset.instructions}
        </p>
      </CardContent>
    </Card>
  );
}

interface PresetFormProps {
  mode: "create" | "edit";
  initialValues?: {
    id: string;
    name: string;
    description: string | null;
    instructions: string;
  };
  onClose: () => void;
}

function PresetForm({ mode, initialValues, onClose }: PresetFormProps) {
  const [name, setName] = useState(initialValues?.name ?? "");
  const [description, setDescription] = useState(
    initialValues?.description ?? "",
  );
  const [instructions, setInstructions] = useState(
    initialValues?.instructions ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setSaving(true);
    setError(null);
    let result: PresetActionResult;
    if (mode === "edit" && initialValues) {
      result = await updatePresetAction({
        id: initialValues.id,
        name,
        description: description.trim() || null,
        instructions,
      });
    } else {
      result = await createPresetAction({
        name,
        description: description.trim() || null,
        instructions,
      });
    }
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onClose();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {mode === "create" ? "새 프리셋" : "프리셋 수정"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="preset-name">이름</Label>
          <Input
            id="preset-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="예: 제품 리뷰형"
            maxLength={50}
            disabled={saving}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="preset-description">설명 (선택)</Label>
          <Input
            id="preset-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="이 프리셋이 어떤 톤인지 한 줄로 설명"
            maxLength={200}
            disabled={saving}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="preset-instructions">
            지시문 (AI 프롬프트에 추가됨)
          </Label>
          <Textarea
            id="preset-instructions"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={6}
            placeholder="예) 친근한 반말 톤으로 작성. 첫 줄에 핵심 메시지를 짧게. 이모지는 1-2개만 절제해서 사용."
            maxLength={2000}
            disabled={saving}
          />
          <p className="text-xs text-muted-foreground">
            10~2000자. 캡션 생성 시 이 가이드가 GPT-4o에 전달됩니다.
          </p>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            취소
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving ? "저장 중..." : "저장"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function DeleteButton({ id, name }: { id: string; name: string }) {
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!confirm(`'${name}' 프리셋을 삭제할까요?`)) return;
    setDeleting(true);
    const result = await deletePresetAction({ id });
    setDeleting(false);
    if (!result.ok) {
      alert(result.error);
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleDelete}
      disabled={deleting}
      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
    >
      <Trash2 className="size-4" />
    </Button>
  );
}
