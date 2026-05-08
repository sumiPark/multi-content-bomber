"use client";

import { useActionState } from "react";
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
import {
  acceptInvitation,
  createOrganization,
  type OnboardingFormState,
} from "./actions";

export function CreateOrgForm() {
  const [state, action, pending] = useActionState<
    OnboardingFormState,
    FormData
  >(createOrganization, undefined);

  return (
    <Card>
      <CardHeader>
        <CardTitle>새 워크스페이스</CardTitle>
        <CardDescription>관리자(ADMIN)로 가입됩니다.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">워크스페이스 이름</Label>
            <Input
              id="name"
              name="name"
              required
              minLength={2}
              maxLength={100}
              placeholder="예: Bomber Studio"
            />
          </div>
          {state?.error && (
            <p className="text-sm text-destructive">{state.error}</p>
          )}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "생성 중..." : "만들기"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export function AcceptInviteForm() {
  const [state, action, pending] = useActionState<
    OnboardingFormState,
    FormData
  >(acceptInvitation, undefined);

  return (
    <Card>
      <CardHeader>
        <CardTitle>초대 토큰으로 합류</CardTitle>
        <CardDescription>관리자가 발급한 토큰을 붙여넣으세요.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="token">초대 토큰</Label>
            <Input
              id="token"
              name="token"
              required
              placeholder="48자리 hex 문자열"
            />
          </div>
          {state?.error && (
            <p className="text-sm text-destructive">{state.error}</p>
          )}
          <Button
            type="submit"
            variant="outline"
            className="w-full"
            disabled={pending}
          >
            {pending ? "확인 중..." : "합류하기"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
