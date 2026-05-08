import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/**
 * service_role 키로 인증된 Supabase 클라이언트. RLS를 우회하므로
 * - 토큰 컬럼처럼 컬럼-레벨 revoke된 필드 INSERT/UPDATE
 * - 워커가 publish_jobs UPDATE
 * 같은 서버-전용 작업에만 사용. 사용자 요청 흐름에서는 호출 X.
 */
export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.",
    );
  }
  return createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
