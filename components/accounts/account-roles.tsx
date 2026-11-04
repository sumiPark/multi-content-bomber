"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { updateAccountRoleAction } from "@/app/(dashboard)/accounts/actions";
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
import { PlatformIcon } from "@/components/ui/platform-icon";
import { cn } from "@/lib/utils";

// 인스타 계정 역할 · 성과 권한 (콘텐츠 자동화 1단계).
// 역할은 기획 에이전트가 영상 방향을 정하는 입력이고, 성과 권한이 없으면 분석이
// 팔로워 · 좋아요 · 댓글 수만으로 돌아가서 다시 연결을 안내한다.

export type RoleFocus = "PRODUCT" | "PERSON";

export interface InstagramRoleRow {
  id: string;
  display_name: string | null;
  role_focus: RoleFocus | null;
  role_note: string | null;
  // 0024 이전 연결이면 null(모름)
  granted_scopes: string[] | null;
  // 마지막 수집에서 계정 성과(도달)를 읽었는지 — 저장된 동의 목록이 없을 때의 실제 근거
  insights_seen: boolean;
  last_collected_on: string | null;
}

const INSIGHTS_SCOPE = "instagram_business_manage_insights";

const FOCUS_OPTIONS: { value: RoleFocus | ""; label: string }[] = [
  { value: "", label: "미정" },
  { value: "PRODUCT", label: "상품 중심" },
  { value: "PERSON", label: "사람 중심" },
];

function insightsStatus(row: InstagramRoleRow): {
  label: string;
  variant: "secondary" | "destructive" | "outline";
  needsReconnect: boolean;
} {
  if (row.granted_scopes?.includes(INSIGHTS_SCOPE) || row.insights_seen) {
    return { label: "성과 권한 있음", variant: "secondary", needsReconnect: false };
  }
  if (row.granted_scopes) {
    return { label: "성과 권한 없음", variant: "destructive", needsReconnect: true };
  }
  return { label: "권한 확인 안 됨", variant: "outline", needsReconnect: true };
}

export function AccountRolesCard({
  accounts,
  canManage,
}: {
  accounts: InstagramRoleRow[];
  canManage: boolean;
}) {
  if (accounts.length === 0) return null;
  const missing = accounts.filter((a) => insightsStatus(a).needsReconnect).length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">인스타 계정 역할 · 성과 권한</CardTitle>
        <CardDescription>
          역할은 프로필 점수와 계정 분석에서 계정 성격을 볼 때 씁니다. 영상 방향은 자동 콘텐츠 설정 · 촬영 설정에서 방식별로 따로 정해요. 성과 권한이 있어야
          조회 · 도달 · 저장 · 공유를 분석할 수 있어요.
          {missing > 0 && (
            <>
              {" "}
              <b className="text-foreground">{missing}개 계정</b>은 다시 연결이
              필요합니다 — 다시 연결해도 발행 이력은 그대로 이어집니다.
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {accounts.map((acc) => (
          <RoleRow key={acc.id} account={acc} canManage={canManage} />
        ))}
      </CardContent>
    </Card>
  );
}

function RoleRow({
  account,
  canManage,
}: {
  account: InstagramRoleRow;
  canManage: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [focus, setFocus] = useState<RoleFocus | "">(account.role_focus ?? "");
  const [note, setNote] = useState(account.role_note ?? "");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const status = insightsStatus(account);
  const dirty =
    focus !== (account.role_focus ?? "") || note !== (account.role_note ?? "");

  function save() {
    startTransition(async () => {
      setMessage(null);
      const result = await updateAccountRoleAction({
        accountId: account.id,
        focus: focus || null,
        note: note || null,
      });
      if (result.ok) {
        setMessage({ ok: true, text: "저장됨" });
        router.refresh();
      } else {
        setMessage({ ok: false, text: result.error });
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
      <PlatformIcon platform="INSTAGRAM" size={22} />
      <div className="min-w-[8rem]">
        <p className="text-sm font-medium leading-tight">
          @{account.display_name ?? "(이름 없음)"}
        </p>
        <p className="text-xs leading-tight text-muted-foreground">
          {account.last_collected_on
            ? `마지막 수집 ${account.last_collected_on}`
            : "아직 수집 전"}
        </p>
      </div>

      <select
        value={focus}
        onChange={(e) => setFocus(e.target.value as RoleFocus | "")}
        disabled={!canManage || isPending}
        className="h-8 rounded-md border bg-card px-2 text-xs"
        aria-label="계정 역할"
      >
        {FOCUS_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        disabled={!canManage || isPending}
        maxLength={100}
        placeholder="다루는 상품 (예: 쿠마 건기식 + 리유 화장품)"
        className="h-8 min-w-[12rem] flex-1 text-xs"
        aria-label="역할 메모"
      />
      {canManage && (
        <Button size="sm" onClick={save} disabled={!dirty || isPending}>
          저장
        </Button>
      )}

      <Badge variant={status.variant} className="text-xs">
        {status.label}
      </Badge>
      {status.needsReconnect && canManage && (
        <Link
          href="/api/auth/connect/instagram"
          className={cn(
            buttonVariants({ variant: "outline", size: "sm" }),
            "h-8 gap-1 text-xs",
          )}
        >
          <RefreshCw className="size-3" /> 다시 연결
        </Link>
      )}
      {message && (
        <span
          className={cn(
            "w-full text-xs",
            message.ok ? "text-muted-foreground" : "text-destructive",
          )}
        >
          {message.text}
        </span>
      )}
    </div>
  );
}
