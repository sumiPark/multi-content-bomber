"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  Check,
  CircleAlert,
  FolderPlus,
  Pencil,
  Plug,
  Trash2,
  Unplug,
  XIcon,
} from "lucide-react";
import {
  assignAccountsToGroupAction,
  createGroupAction,
  deleteGroupAction,
  disconnectAccountAction,
  updateGroupAction,
  type GroupActionResult,
} from "@/app/(dashboard)/accounts/actions";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PlatformIcon } from "@/components/ui/platform-icon";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Platform = "YOUTUBE" | "INSTAGRAM" | "TIKTOK";

export interface AccountRow {
  id: string;
  platform: Platform;
  display_name: string | null;
  is_active: boolean;
  token_expires_at: string | null;
  created_at: string;
  group_id: string | null;
}

export interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  color: string;
  created_at: string;
}

interface AccountsPageProps {
  accounts: AccountRow[];
  groups: GroupRow[];
  canManage: boolean;
  flashMessage: string | null;
  flashError: string | null;
}

const PLATFORM_BUTTONS: {
  id: Platform;
  name: string;
}[] = [
  { id: "INSTAGRAM", name: "Instagram" },
  { id: "TIKTOK", name: "TikTok" },
  { id: "YOUTUBE", name: "YouTube" },
];

export type GroupColor =
  | "zinc"
  | "red"
  | "amber"
  | "green"
  | "blue"
  | "pink"
  | "purple";

export const GROUP_COLORS: Array<{
  id: GroupColor;
  label: string;
  bg: string;
  text: string;
  border: string;
  ring: string;
}> = [
  {
    id: "zinc",
    label: "회색",
    bg: "bg-zinc-100",
    text: "text-zinc-700",
    border: "border-zinc-300",
    ring: "ring-zinc-400",
  },
  {
    id: "red",
    label: "빨강",
    bg: "bg-red-100",
    text: "text-red-800",
    border: "border-red-300",
    ring: "ring-red-400",
  },
  {
    id: "amber",
    label: "주황",
    bg: "bg-amber-100",
    text: "text-amber-800",
    border: "border-amber-300",
    ring: "ring-amber-400",
  },
  {
    id: "green",
    label: "초록",
    bg: "bg-green-100",
    text: "text-green-800",
    border: "border-green-300",
    ring: "ring-green-400",
  },
  {
    id: "blue",
    label: "파랑",
    bg: "bg-blue-100",
    text: "text-blue-800",
    border: "border-blue-300",
    ring: "ring-blue-400",
  },
  {
    id: "pink",
    label: "분홍",
    bg: "bg-pink-100",
    text: "text-pink-800",
    border: "border-pink-300",
    ring: "ring-pink-400",
  },
  {
    id: "purple",
    label: "보라",
    bg: "bg-purple-100",
    text: "text-purple-800",
    border: "border-purple-300",
    ring: "ring-purple-400",
  },
];

export function colorClass(color: string) {
  return GROUP_COLORS.find((c) => c.id === color) ?? GROUP_COLORS[0];
}

function getStatus(
  isActive: boolean,
  expiresAt: string | null,
  platform: Platform,
): { label: string; variant: "secondary" | "destructive" | "outline" } {
  if (!isActive) return { label: "비활성", variant: "destructive" };
  if (platform === "TIKTOK" || platform === "YOUTUBE")
    return { label: "활성", variant: "secondary" };
  if (!expiresAt) return { label: "활성", variant: "secondary" };
  const days = (new Date(expiresAt).getTime() - Date.now()) / (24 * 3600 * 1000);
  if (days < 0) return { label: "토큰 만료", variant: "destructive" };
  if (days < 7) return { label: "만료 임박", variant: "outline" };
  return { label: "활성", variant: "secondary" };
}

export function AccountsPage({
  accounts,
  groups,
  canManage,
  flashMessage,
  flashError,
}: AccountsPageProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editingGroup, setEditingGroup] = useState<GroupRow | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const accountsByGroup = new Map<string | null, AccountRow[]>();
  for (const acc of accounts) {
    const key = acc.group_id;
    const list = accountsByGroup.get(key) ?? [];
    list.push(acc);
    accountsByGroup.set(key, list);
  }

  function handleResult(result: GroupActionResult, successLabel: string) {
    if (result.ok) {
      setActionMessage(`${successLabel} 완료`);
      router.refresh();
    } else {
      setActionMessage(result.error);
    }
  }

  function changeAccountGroup(accountId: string, newGroupId: string | null) {
    startTransition(async () => {
      setActionMessage(null);
      const result = await assignAccountsToGroupAction({
        accountIds: [accountId],
        groupId: newGroupId,
      });
      handleResult(result, "그룹 이동");
    });
  }

  return (
    <main className="container mx-auto max-w-5xl space-y-6 px-6 py-10">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">계정 관리</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            소셜 계정을 그룹으로 묶어 관리하세요. 새 콘텐츠 만들 때 그룹
            단위로 한 번에 선택할 수 있어요.
          </p>
        </div>
        {canManage && (
          <div className="flex shrink-0 gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsCreating(true)}
              disabled={isCreating || isPending}
            >
              <FolderPlus className="size-4" /> 그룹 만들기
            </Button>
          </div>
        )}
      </header>

      {flashMessage && (
        <div className="rounded-md border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm">
          {flashMessage}
        </div>
      )}
      {flashError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {flashError}
        </div>
      )}
      {actionMessage && (
        <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
          {actionMessage}
        </div>
      )}

      {/* 계정 추가 — 가장 많이 쓰는 액션이라 상단 고정 */}
      <ConnectorCard />

      {isCreating && canManage && (
        <GroupForm
          mode="create"
          onCancel={() => setIsCreating(false)}
          onSubmit={(values) => {
            startTransition(async () => {
              const result = await createGroupAction(values);
              if (result.ok) {
                setIsCreating(false);
                setActionMessage("그룹 생성 완료");
                router.refresh();
              } else {
                setActionMessage(result.error);
              }
            });
          }}
          isPending={isPending}
        />
      )}

      {editingGroup && canManage && (
        <GroupForm
          mode="edit"
          initial={editingGroup}
          onCancel={() => setEditingGroup(null)}
          onSubmit={(values) => {
            startTransition(async () => {
              const result = await updateGroupAction({
                ...values,
                id: editingGroup.id,
              });
              if (result.ok) {
                setEditingGroup(null);
                setActionMessage("그룹 수정 완료");
                router.refresh();
              } else {
                setActionMessage(result.error);
              }
            });
          }}
          isPending={isPending}
        />
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground">
          연동된 계정 ({accounts.length}개)
        </h2>

        {groups.length === 0 && accounts.length === 0 && (
          <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            아직 연동된 계정이 없어요. 위 “계정 추가”에서 시작하세요.
          </div>
        )}

        {/* 그룹 카드 — 2열 그리드. 카드 자체는 컴팩트 */}
        <div className="grid gap-3 md:grid-cols-2">
          {groups.map((group) => {
            const list = accountsByGroup.get(group.id) ?? [];
            return (
              <GroupCard
                key={group.id}
                group={group}
                accounts={list}
                groups={groups}
                canManage={canManage}
                isPending={isPending}
                onEdit={() => setEditingGroup(group)}
                onDelete={() => {
                  if (
                    !window.confirm(
                      `“${group.name}” 그룹을 삭제할까요? 소속 계정은 그룹 미지정으로 변경됩니다 (계정 자체는 삭제되지 않음).`,
                    )
                  )
                    return;
                  startTransition(async () => {
                    const result = await deleteGroupAction({ id: group.id });
                    handleResult(result, "그룹 삭제");
                  });
                }}
                onChangeAccountGroup={changeAccountGroup}
              />
            );
          })}

          {/* 그룹 미지정 카드 */}
          {(accountsByGroup.get(null)?.length ?? 0) > 0 && (
            <UnassignedCard
              accounts={accountsByGroup.get(null) ?? []}
              groups={groups}
              canManage={canManage}
              isPending={isPending}
              onChangeAccountGroup={changeAccountGroup}
            />
          )}
        </div>
      </section>
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Group form (create / edit)
// ─────────────────────────────────────────────────────────────────────────────

function GroupForm({
  mode,
  initial,
  onCancel,
  onSubmit,
  isPending,
}: {
  mode: "create" | "edit";
  initial?: GroupRow;
  onCancel: () => void;
  onSubmit: (values: {
    name: string;
    description: string | null;
    color: GroupColor;
  }) => void;
  isPending: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [color, setColor] = useState<GroupColor>(
    (initial?.color as GroupColor) ?? "zinc",
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {mode === "create" ? "새 그룹 만들기" : "그룹 수정"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="group-name" className="text-xs">
            그룹 이름 *
          </Label>
          <Input
            id="group-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="예) A브랜드, 글로벌팀"
            maxLength={50}
            disabled={isPending}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="group-desc" className="text-xs">
            설명 (선택)
          </Label>
          <Textarea
            id="group-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            maxLength={200}
            disabled={isPending}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">색상</Label>
          <div className="flex flex-wrap gap-2">
            {GROUP_COLORS.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setColor(c.id)}
                disabled={isPending}
                aria-label={c.label}
                className={cn(
                  "size-7 rounded-full border-2 transition",
                  c.bg,
                  color === c.id ? `ring-2 ${c.ring}` : "border-transparent",
                )}
              />
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={isPending}
          >
            취소
          </Button>
          <Button
            size="sm"
            onClick={() =>
              onSubmit({
                name: name.trim(),
                description: description.trim() || null,
                color,
              })
            }
            disabled={isPending || !name.trim()}
          >
            <Check className="size-3.5" />
            {mode === "create" ? "만들기" : "저장"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Group card
// ─────────────────────────────────────────────────────────────────────────────

const GROUP_BAR_COLOR: Record<GroupColor, string> = {
  zinc: "bg-zinc-400",
  red: "bg-red-500",
  amber: "bg-amber-500",
  green: "bg-green-500",
  blue: "bg-blue-500",
  pink: "bg-pink-500",
  purple: "bg-purple-500",
};

function GroupCard({
  group,
  accounts,
  groups,
  canManage,
  isPending,
  onEdit,
  onDelete,
  onChangeAccountGroup,
}: {
  group: GroupRow;
  accounts: AccountRow[];
  groups: GroupRow[];
  canManage: boolean;
  isPending: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onChangeAccountGroup: (accountId: string, newGroupId: string | null) => void;
}) {
  const bar = GROUP_BAR_COLOR[(group.color as GroupColor) ?? "zinc"];
  return (
    <Card className="relative overflow-hidden">
      {/* 좌측 컬러바 — 카드 전체 색상 채우기보다 subtle */}
      <div className={cn("absolute inset-y-0 left-0 w-1", bar)} />
      <CardHeader className="pb-3 pl-5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-sm font-semibold">
              {group.name}
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                {accounts.length}
              </span>
            </CardTitle>
            {group.description && (
              <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                {group.description}
              </p>
            )}
          </div>
          {canManage && (
            <div className="-mr-2 -mt-1 flex shrink-0">
              <Button
                variant="ghost"
                size="sm"
                onClick={onEdit}
                disabled={isPending}
                className="h-7 w-7 p-0"
                aria-label="그룹 수정"
              >
                <Pencil className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onDelete}
                disabled={isPending}
                className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                aria-label="그룹 삭제"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-1.5 pl-5 pt-0">
        {accounts.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            소속 계정 없음
          </p>
        ) : (
          accounts.map((acc) => (
            <AccountItem
              key={acc.id}
              account={acc}
              groups={groups}
              canManage={canManage}
              isPending={isPending}
              onChangeAccountGroup={onChangeAccountGroup}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}

function UnassignedCard({
  accounts,
  groups,
  canManage,
  isPending,
  onChangeAccountGroup,
}: {
  accounts: AccountRow[];
  groups: GroupRow[];
  canManage: boolean;
  isPending: boolean;
  onChangeAccountGroup: (accountId: string, newGroupId: string | null) => void;
}) {
  return (
    <Card className="relative overflow-hidden border-dashed">
      <div className="absolute inset-y-0 left-0 w-1 bg-zinc-300" />
      <CardHeader className="pb-3 pl-5">
        <CardTitle className="text-sm font-semibold text-muted-foreground">
          그룹 미지정
          <span className="ml-1.5 text-xs font-normal">{accounts.length}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5 pl-5 pt-0">
        {accounts.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            모든 계정이 그룹에 할당됨
          </p>
        ) : (
          accounts.map((acc) => (
            <AccountItem
              key={acc.id}
              account={acc}
              groups={groups}
              canManage={canManage}
              isPending={isPending}
              onChangeAccountGroup={onChangeAccountGroup}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Account row
// ─────────────────────────────────────────────────────────────────────────────

function AccountItem({
  account,
  groups,
  canManage,
  isPending,
  onChangeAccountGroup,
}: {
  account: AccountRow;
  groups: GroupRow[];
  canManage: boolean;
  isPending: boolean;
  onChangeAccountGroup: (accountId: string, newGroupId: string | null) => void;
}) {
  const status = getStatus(
    account.is_active,
    account.token_expires_at,
    account.platform,
  );
  return (
    <div className="flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 text-sm transition hover:bg-accent/30">
      <PlatformIcon platform={account.platform} size={22} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium leading-tight">
          {account.display_name ?? "(이름 없음)"}
        </p>
        <p className="text-[10px] leading-tight text-muted-foreground">
          {account.platform}
        </p>
      </div>
      {status.label !== "활성" && (
        <Badge variant={status.variant} className="text-[10px]">
          {status.label}
        </Badge>
      )}
      {canManage && (
        <>
          <select
            value={account.group_id ?? ""}
            onChange={(e) =>
              onChangeAccountGroup(account.id, e.target.value || null)
            }
            disabled={isPending}
            className="rounded border bg-background px-1.5 py-0.5 text-[11px]"
            aria-label="그룹 이동"
            title="그룹 이동"
          >
            <option value="">미지정</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <form action={disconnectAccountAction}>
            <input type="hidden" name="accountId" value={account.id} />
            <button
              type="submit"
              className="rounded p-1 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
              aria-label="연결 해제"
              title="연결 해제"
            >
              <Unplug className="size-3.5" />
            </button>
          </form>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Connector card (플랫폼 추가)
// ─────────────────────────────────────────────────────────────────────────────

function ConnectorCard() {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-3 py-4">
        <div className="mr-auto">
          <p className="text-sm font-semibold">계정 추가</p>
          <p className="text-xs text-muted-foreground">
            플랫폼 OAuth로 새 계정을 연결합니다.
          </p>
        </div>
        {PLATFORM_BUTTONS.map((p) => (
          <Link
            key={p.id}
            href={`/api/auth/connect/${p.id.toLowerCase()}`}
            className={cn(
              buttonVariants({ variant: "outline", size: "sm" }),
              "gap-2",
            )}
          >
            <PlatformIcon platform={p.id} size={18} />
            <span>{p.name}</span>
            <Plug className="size-3" />
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}
