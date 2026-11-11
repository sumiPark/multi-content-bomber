import "server-only";
import { createServiceClient } from "@/lib/supabase/service";

// 스레드 앱 연결 해제 · 데이터 삭제 요청이 오면 그 스레드 계정의 토큰을 지우고 비활성으로 둔다.
// 행은 지우지 않는다 — 발행 이력(publish_jobs)이 계정 행에 걸려 있어 함께 사라지면 안 된다.
export async function revokeThreadsAccount(threadsUserId: string): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase
    .from("social_accounts")
    .update({
      is_active: false,
      access_token_encrypted: null,
      refresh_token_encrypted: null,
      token_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("platform", "THREADS")
    .eq("platform_account_id", threadsUserId);
  if (error) throw new Error(`스레드 계정 비활성 처리 실패: ${error.message}`);
}
