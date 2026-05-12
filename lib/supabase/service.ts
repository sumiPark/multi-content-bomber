import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/**
 * service_role 키로 인증된 Supabase 클라이언트. RLS를 우회하므로
 * - 토큰 컬럼처럼 컬럼-레벨 revoke된 필드 INSERT/UPDATE
 * - 워커가 publish_jobs UPDATE
 * 같은 서버-전용 작업에만 사용. 사용자 요청 흐름에서는 호출 X.
 *
 * 가드 정책:
 *   원래 `import "server-only"`로 클라이언트 번들 import를 차단했으나, 워커
 *   (Next.js 외부, plain Node + tsx)에서 같은 코드를 공유해야 해서 제거함.
 *   대신 런타임 `typeof window` 체크로 브라우저에서 호출 시 즉시 throw —
 *   Next.js client component에서 실수로 import해도 첫 사용 시점에 빨리 깨진다.
 */
export function createServiceClient() {
  if (typeof window !== "undefined") {
    throw new Error(
      "createServiceClient는 서버 컨텍스트(Server Action / API route / worker)에서만 호출해야 합니다.",
    );
  }
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
