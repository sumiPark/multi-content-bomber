import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

/**
 * React 요청 단위 메모이즈 헬퍼.
 *
 * 한 RSC 렌더 패스(레이아웃 + 자식 페이지)에서 `auth.getUser()`와 profile
 * 조회는 여러 번 호출되는 경우가 잦다. `react.cache`로 감싸면 같은 render
 * scope 안에서는 한 번만 실제로 실행되고, 이후 호출은 같은 promise를 공유한다.
 *
 * Server Action invocation은 별도 scope라 매번 새로 실행되므로 동작에 영향 없음.
 */

export const getServerSupabase = cache(async () => createClient());

export const getSessionUser = cache(async () => {
  const supabase = await getServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

export interface ProfileSummary {
  organization_id: string | null;
  role: "ADMIN" | "MANAGER" | "STAFF";
}

export const getCurrentProfile = cache(async (): Promise<ProfileSummary | null> => {
  const supabase = await getServerSupabase();
  const user = await getSessionUser();
  if (!user) return null;
  const { data } = await supabase
    .from("profiles")
    .select("organization_id, role")
    .eq("id", user.id)
    .maybeSingle();
  return (data as ProfileSummary | null) ?? null;
});
