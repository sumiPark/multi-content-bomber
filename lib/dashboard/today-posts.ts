import { kstDate } from "@/lib/automation/time";
import { decryptToken } from "@/lib/crypto";
import { listRecentMedia } from "@/lib/platforms/instagram-insights";
import { createServiceClient } from "@/lib/supabase/service";

// 대시보드 "오늘 올린 게시물" — 계정별로 인스타에서 바로 읽는다(MCB로 올린 것 + 앱에서 올린 것).
// 수집 워커는 하루 한 번이라 오늘 개수로는 늦다(2026-11-04 사용자 결정). 게시물 목록은 계정 토큰으로 읽는다.
// 대시보드를 열 때마다 계정 수만큼 호출하지 않게 서버에 2분 동안 담아 둔다.

export interface TodayPostsRow {
  account: string;
  // 못 읽었으면 null
  count: number | null;
  reels: number;
}

export interface TodayPosts {
  rows: TodayPostsRow[];
}

const CACHE_MS = 2 * 60_000;
// 하루에 올릴 수 있는 양보다 넉넉하게
const RECENT_LIMIT = 25;
const READ_TIMEOUT_MS = 8_000;

const cache = new Map<string, { at: number; data: TodayPosts }>();

function kstDay(iso: string): string {
  return new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 10);
}

async function readAccount(token: string, today: string): Promise<{ count: number; reels: number }> {
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("인스타 응답 시간 초과")), READ_TIMEOUT_MS));
  const media = await Promise.race([listRecentMedia(token, RECENT_LIMIT), timeout]);
  const todays = media.filter((m) => m.timestamp && kstDay(m.timestamp) === today);
  return { count: todays.length, reels: todays.filter((m) => m.mediaProductType === "REELS").length };
}

export async function loadTodayPosts(orgId: string, now = Date.now()): Promise<TodayPosts> {
  const cached = cache.get(orgId);
  if (cached && now - cached.at < CACHE_MS) return cached.data;

  const today = kstDate(0, now);
  const service = createServiceClient();
  const { data: accounts, error } = await service
    .from("social_accounts")
    .select("display_name, access_token_encrypted")
    .eq("organization_id", orgId)
    .eq("platform", "INSTAGRAM")
    .is("disconnected_at", null)
    // 토큰이 만료된 계정은 읽을 수 없다 — 다 "못 읽음"으로 깔리지 않게 뺀다(쓰는 계정이면 경고 줄이 따로 알린다)
    .eq("is_active", true)
    .not("access_token_encrypted", "is", null)
    .order("display_name");
  if (error) throw new Error(error.message);

  const rows = await Promise.all(
    (accounts ?? []).map(async (a): Promise<TodayPostsRow> => {
      const account = a.display_name ?? "";
      try {
        return { account, ...(await readAccount(decryptToken(a.access_token_encrypted as string), today)) };
      } catch (e) {
        console.error(`[dashboard] @${account} 게시물 읽기 실패:`, e instanceof Error ? e.message : e);
        return { account, count: null, reels: 0 };
      }
    }),
  );
  // 많이 올린 계정 먼저, 못 읽은 계정은 뒤로
  rows.sort((x, y) => (y.count ?? -1) - (x.count ?? -1) || x.account.localeCompare(y.account));

  const data = { rows };
  cache.set(orgId, { at: now, data });
  return data;
}
