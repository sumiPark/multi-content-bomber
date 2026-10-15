// server-only는 쓰지 않는다 — 발행 워커(tsx + plain Node)에서도 import한다.
import { generateReplyTemplates } from "@/lib/ai/reply-template-generator";
import { getInstagramMe, listAllComments } from "@/lib/platforms/instagram-comments";
import type { createServiceClient } from "@/lib/supabase/service";
import type { InstagramAccountAuth } from "./server";

// 시리즈 댓글 자동화 — 새 화를 추가하면 답글 문구를 AI가 새로 쓴다.
// 화마다 문구가 달라 같은 사람이 여러 화 답글을 받아도 복붙처럼 보이지 않고, 같은 문장 반복
// (가장 흔한 스팸 신호)도 줄어든다. 계정 주인이 최근 회차 댓글에 손으로 단 답글을 말투 예시로
// 넘겨 AI 티가 덜 나게 한다.
// 실패해도 회차 추가·발행은 막지 않는다 — 기존 문구를 그대로 쓴다.

type Service = ReturnType<typeof createServiceClient>;

// 최근 몇 화의 댓글에서 말투 예시를 모을지, 최대 몇 개까지.
const VOICE_EPISODES = 3;
const VOICE_MAX = 12;
const VOICE_MAX_LENGTH = 80;

// 반환: 새 문구로 바꿨는지.
export async function refreshSeriesTemplates(
  service: Service,
  args: { seriesId: string; auth: InstagramAccountAuth | null },
): Promise<boolean> {
  try {
    const { data: series } = await service
      .from("series")
      .select("name, reply_templates")
      .eq("id", args.seriesId)
      .maybeSingle();
    if (!series) return false;

    // 말투 예시는 덤 — 못 모아도(토큰 만료 등) 문구는 새로 쓴다.
    const voiceSamples = args.auth
      ? await loadCreatorReplies(service, args.seriesId, args.auth).catch((err) => {
          console.warn(
            `[episode-alerts] 시리즈 ${args.seriesId} 말투 예시 수집 실패:`,
            err instanceof Error ? err.message : err,
          );
          return [];
        })
      : [];

    const templates = await generateReplyTemplates({
      seriesName: series.name,
      current: series.reply_templates,
      voiceSamples,
    });
    const { error } = await service
      .from("series")
      .update({ reply_templates: templates })
      .eq("id", args.seriesId);
    if (error) throw new Error(error.message);

    console.log(
      `[episode-alerts] 시리즈 ${args.seriesId} 답글 문구 새로 씀 (${templates.length}개, 말투 예시 ${voiceSamples.length}개)`,
    );
    return true;
  } catch (err) {
    console.error(
      `[episode-alerts] 시리즈 ${args.seriesId} 답글 문구 새로 쓰기 실패 — 기존 문구 유지:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

// 계정 주인이 최근 회차 게시물에 손으로 단 댓글·답글. 자동으로 보낸 답글은 뺀다(AI 문구를 다시
// 예시로 주면 AI 말투가 굳는다).
async function loadCreatorReplies(
  service: Service,
  seriesId: string,
  auth: InstagramAccountAuth,
): Promise<string[]> {
  const [{ data: episodes }, { data: autoReplies }, me] = await Promise.all([
    service
      .from("series_episodes")
      .select("ig_media_id")
      .eq("series_id", seriesId)
      .order("episode_no", { ascending: false })
      .limit(VOICE_EPISODES),
    service
      .from("episode_alert_replies")
      .select("reply_ig_id, episode_alert_tasks!inner(series_id)")
      .eq("episode_alert_tasks.series_id", seriesId)
      .not("reply_ig_id", "is", null)
      .order("sent_at", { ascending: false })
      .limit(1000),
    getInstagramMe(auth.token),
  ]);
  const autoIds = new Set((autoReplies ?? []).map((r) => r.reply_ig_id));
  // 댓글 from.id는 /me의 user_id와 같다(실측) — collect.ts와 같은 판별.
  const ownIds = new Set(
    [me.id, me.userId, auth.platformAccountId].filter((v): v is string => !!v),
  );
  const ownName = me.username.toLowerCase();

  const samples: string[] = [];
  const seen = new Set<string>();
  for (const episode of episodes ?? []) {
    const comments = await listAllComments(episode.ig_media_id, auth.token);
    for (const c of comments) {
      const own =
        (c.fromId !== null && ownIds.has(c.fromId)) || c.username?.toLowerCase() === ownName;
      if (!own || autoIds.has(c.id)) continue;
      // 앞의 @멘션은 빼고 말투만 남긴다.
      const text = c.text.replace(/^(@[\w.]+\s*)+/, "").replace(/\s+/g, " ").trim();
      if (text.length < 2 || text.length > VOICE_MAX_LENGTH || seen.has(text)) continue;
      seen.add(text);
      samples.push(text);
      if (samples.length >= VOICE_MAX) return samples;
    }
  }
  return samples;
}
