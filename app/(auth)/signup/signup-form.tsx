"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signup, type AuthFormState } from "../actions";

export function SignupForm() {
  const [state, action, pending] = useActionState<AuthFormState, FormData>(
    signup,
    undefined,
  );

  return (
    <form action={action} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">이메일</Label>
        <Input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">비밀번호 (6자 이상)</Label>
        <Input
          id="password"
          name="password"
          type="password"
          required
          minLength={6}
          autoComplete="new-password"
        />
      </div>
      {state && "error" in state && (
        <p className="text-sm text-destructive">{state.error}</p>
      )}
      {state && "message" in state && (
        <p className="text-sm text-muted-foreground">{state.message}</p>
      )}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "가입 중..." : "가입하기"}
      </Button>
    </form>
  );
}
