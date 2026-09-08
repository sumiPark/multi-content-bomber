import "./server-guard";
import {
  MediaError,
  PublishError,
  RateLimitedError,
  TokenExpiredError,
  type OAuthTokens,
  type PlatformAdapter,
  type PublishContext,
  type PublishResult,
  type RefreshedTokens,
} from "./types";

// YouTube Data API v3 + Google OAuth 2.0.
// Google Cloud Console에서 OAuth 2.0 클라이언트(웹 애플리케이션) 생성 후
// "YouTube Data API v3"를 활성화해야 함.
//
// access_type=offline + prompt=consent 둘 다 있어야 refresh_token이 발급됨.
// 한 번 동의한 사용자는 prompt 없으면 refresh_token이 안 와서 만료 후 재연동 필요.
const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
].join(" ");

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CHANNEL_URL =
  "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true";
const VIDEOS_RESUMABLE_URL =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
// 커스텀 썸네일 업로드. videoId 쿼리에 박고 이미지 바이트를 그대로 보낸다.
// ⚠️ 채널이 전화 인증(verified)된 경우에만 동작 — 미인증이면 403.
const THUMBNAIL_SET_URL =
  "https://www.googleapis.com/upload/youtube/v3/thumbnails/set?uploadType=media";

// resumable 업로드 청크 크기.
// ⚠️ Google 규격: 마지막 청크를 제외한 모든 청크는 256KB의 배수여야 한다.
// 16MB면 800MB 영상이 50청크 — 메모리는 청크 하나(16MB)만 점유하고,
// 중간에 끊겨도 그 청크만 다시 보내면 된다.
const UPLOAD_CHUNK_SIZE = 16 * 1024 * 1024;

// 5xx/네트워크 오류로 한 청크가 실패했을 때 같은 지점을 다시 시도하는 횟수.
// 이걸 넘기면 job 자체를 RETRYING으로 떨어뜨려 다음 sweep에 맡긴다.
const CHUNK_MAX_RETRIES = 3;

// YouTube는 title·description·tags에 꺾쇠(< >)가 들어가면 400을 던진다
// (invalidTitle / invalidDescription / invalidTags). 한국어 캡션에서 <제목>처럼
// 인용부호로 자주 쓰여 실제로 발행이 통째로 막혔다. 거부 대신 대괄호로 치환해
// 의미를 살린 채 올린다 — 대괄호는 YouTube 제한 문자가 아니다([MV], [4K] 등).
function replaceAngleBrackets(text: string): string {
  return text.replace(/</g, "[").replace(/>/g, "]");
}

// Google API JSON 에러 형태. error.code(HTTP), error.errors[].reason으로
// 토큰 만료(invalidCredentials) / 쿼터 초과(quotaExceeded) 등을 분기.
interface GoogleApiError {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{ reason?: string; message?: string }>;
  };
}

// HTTP 응답 + 본문을 우리 에러 타입으로 매핑. 워커가 instanceof로 분기.
function mapYoutubeError(status: number, body: string): never {
  let parsed: GoogleApiError | null = null;
  try {
    parsed = JSON.parse(body) as GoogleApiError;
  } catch {
    // body가 JSON 아니면 그대로 흘림
  }
  const reasons =
    parsed?.error?.errors?.map((e) => e.reason).filter(Boolean) ?? [];
  const message = parsed?.error?.message ?? body.slice(0, 300);

  if (status === 401 || reasons.includes("authError")) {
    throw new TokenExpiredError(`YouTube access_token 만료/무효: ${message}`);
  }
  if (status === 429 || reasons.includes("rateLimitExceeded")) {
    throw new RateLimitedError(`YouTube rate limit: ${message}`);
  }
  if (status === 403 && reasons.includes("quotaExceeded")) {
    // 일일 쿼터(10k units/day) 초과. 시간 지나야 회복 — rate limit 카테고리.
    throw new RateLimitedError(`YouTube 일일 쿼터 초과: ${message}`);
  }
  throw new PublishError(`YouTube API 오류 (${status}): ${message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// resumable 업로드 헬퍼
//
// 예전엔 영상 전체를 arrayBuffer → Buffer → multipart concat으로 세 벌 복사한 뒤
// 단일 요청으로 보냈다. 100MB까진 버텼지만 800MB에선 피크 메모리가 2.4GB로 뛰고,
// 업로드 도중 한 번만 끊겨도 처음부터 다시 올려야 했다.
//
// 지금은 Storage에서 Range 요청으로 청크만 잘라 와 resumable 세션에 이어 붙인다.
// 메모리는 청크 하나(16MB)로 고정되고, 끊기면 그 지점부터 재개한다.
// ─────────────────────────────────────────────────────────────────────────────

interface MediaProbe {
  size: number;
  contentType: string;
  supportsRange: boolean;
}

interface UploadedVideo {
  id?: string;
  snippet?: { channelId?: string };
}

type ResumeState =
  | { done: true; video: UploadedVideo }
  | { done: false; offset: number };

// 1바이트 Range 요청으로 전체 크기·타입·Range 지원 여부를 한 번에 확인한다.
// 본문은 즉시 취소 — probe 하나 때문에 800MB를 통째로 받아버리면 의미가 없다.
async function probeMedia(signedUrl: string): Promise<MediaProbe> {
  const res = await fetch(signedUrl, { headers: { Range: "bytes=0-0" } });
  if (!res.ok) {
    await res.body?.cancel();
    throw new MediaError(`YouTube publish: 미디어 probe 실패 (${res.status})`);
  }

  const contentType = res.headers.get("content-type") ?? "video/mp4";
  let size: number | null = null;
  let supportsRange = false;

  if (res.status === 206) {
    // "bytes 0-0/812345678" 의 마지막 숫자가 전체 크기.
    supportsRange = true;
    const m = /\/(\d+)\s*$/.exec(res.headers.get("content-range") ?? "");
    if (m) size = Number(m[1]);
  } else {
    const cl = res.headers.get("content-length");
    if (cl) size = Number(cl);
  }
  await res.body?.cancel();

  if (size === null || !Number.isFinite(size) || size <= 0) {
    throw new MediaError("YouTube publish: 미디어 크기를 확인할 수 없습니다");
  }
  return { size, contentType, supportsRange };
}

async function fetchRange(
  signedUrl: string,
  start: number,
  end: number,
): Promise<Buffer<ArrayBuffer>> {
  const res = await fetch(signedUrl, {
    headers: { Range: `bytes=${start}-${end}` },
  });
  if (res.status !== 206) {
    await res.body?.cancel();
    throw new MediaError(
      `YouTube publish: 청크 fetch 실패 (${res.status}, bytes ${start}-${end})`,
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

async function fetchWhole(signedUrl: string): Promise<Buffer<ArrayBuffer>> {
  const res = await fetch(signedUrl);
  if (!res.ok) {
    await res.body?.cancel();
    throw new MediaError(
      `YouTube publish: 미디어 fetch 실패 (${res.status})`,
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

// 업로드 세션을 연다. 실제 바이트는 응답의 Location(세션 URI)으로 보낸다.
async function startResumableSession(
  meta: unknown,
  probe: MediaProbe,
  accessToken: string,
): Promise<string> {
  const res = await fetch(VIDEOS_RESUMABLE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(probe.size),
      "X-Upload-Content-Type": probe.contentType,
    },
    body: JSON.stringify(meta),
  });
  if (!res.ok) {
    mapYoutubeError(res.status, await res.text());
  }
  const sessionUri = res.headers.get("location");
  if (!sessionUri) {
    throw new PublishError("YouTube resumable 세션 URI(Location)가 없습니다");
  }
  return sessionUri;
}

// 308 응답의 Range 헤더("bytes=0-262143")는 서버가 실제로 받은 마지막 바이트다.
// 다음에 보낼 offset은 그 +1. 헤더가 없으면 아직 아무것도 못 받은 것.
function parseNextOffset(range: string | null): number | null {
  if (!range) return null;
  const m = /bytes=0-(\d+)/.exec(range);
  return m ? Number(m[1]) + 1 : null;
}

// 청크 전송이 끊겼을 때 서버가 어디까지 받았는지 물어본다.
// Content-Range: bytes */total + 빈 본문 = Google이 정의한 상태 조회.
async function queryResumeState(
  sessionUri: string,
  size: number,
  accessToken: string,
): Promise<ResumeState> {
  const res = await fetch(sessionUri, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Range": `bytes */${size}`,
    },
  });
  if (res.status === 200 || res.status === 201) {
    return { done: true, video: (await res.json()) as UploadedVideo };
  }
  if (res.status === 308) {
    await res.body?.cancel();
    return {
      done: false,
      offset: parseNextOffset(res.headers.get("range")) ?? 0,
    };
  }
  mapYoutubeError(res.status, await res.text());
}

async function uploadResumable(
  sessionUri: string,
  signedUrl: string,
  probe: MediaProbe,
  accessToken: string,
): Promise<UploadedVideo> {
  // Range 미지원 Storage — 예전처럼 전체를 한 번에 보낸다. Supabase Storage는
  // Range를 지원하므로 여기 오는 건 예외적인 경우다.
  if (!probe.supportsRange) {
    const whole = await fetchWhole(signedUrl);
    const res = await fetch(sessionUri, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": probe.contentType,
        "Content-Range": `bytes 0-${probe.size - 1}/${probe.size}`,
      },
      body: whole,
    });
    if (res.status === 200 || res.status === 201) {
      return (await res.json()) as UploadedVideo;
    }
    mapYoutubeError(res.status, await res.text());
  }

  let offset = 0;
  let retries = 0;

  while (offset < probe.size) {
    const end = Math.min(offset + UPLOAD_CHUNK_SIZE, probe.size) - 1;
    const chunk = await fetchRange(signedUrl, offset, end);

    let res: Response;
    try {
      res = await fetch(sessionUri, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": probe.contentType,
          "Content-Range": `bytes ${offset}-${end}/${probe.size}`,
        },
        body: chunk,
      });
    } catch (err) {
      // 네트워크 단절. 서버가 어디까지 받았는지 확인하고 그 지점부터 재개.
      if (retries >= CHUNK_MAX_RETRIES) throw err;
      retries += 1;
      const state = await queryResumeState(sessionUri, probe.size, accessToken);
      if (state.done) return state.video;
      offset = state.offset;
      continue;
    }

    if (res.status === 200 || res.status === 201) {
      return (await res.json()) as UploadedVideo;
    }
    if (res.status === 308) {
      // 정상 — 다음 청크로. 서버가 알려준 offset을 신뢰한다.
      await res.body?.cancel();
      offset = parseNextOffset(res.headers.get("range")) ?? end + 1;
      retries = 0;
      continue;
    }
    if (res.status >= 500 && retries < CHUNK_MAX_RETRIES) {
      await res.body?.cancel();
      retries += 1;
      const state = await queryResumeState(sessionUri, probe.size, accessToken);
      if (state.done) return state.video;
      offset = state.offset;
      continue;
    }
    mapYoutubeError(res.status, await res.text());
  }

  // 마지막 청크까지 보냈는데 완료 응답을 못 받은 경우 — 한 번 더 확인.
  const state = await queryResumeState(sessionUri, probe.size, accessToken);
  if (state.done) return state.video;
  throw new PublishError("YouTube resumable 업로드가 완료 응답 없이 끝났습니다");
}

export const youtube: PlatformAdapter = {
  buildAuthUrl(state, redirectUri) {
    const clientId = process.env.YOUTUBE_CLIENT_ID;
    if (!clientId) throw new Error("YOUTUBE_CLIENT_ID 환경변수 없음");
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: SCOPES,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  },

  async exchangeCode(code, redirectUri): Promise<OAuthTokens> {
    const clientId = process.env.YOUTUBE_CLIENT_ID;
    const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET 환경변수 없음");
    }

    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      throw new Error(
        `YouTube 토큰 교환 실패 (${tokenRes.status}): ${text.slice(0, 200)}`,
      );
    }

    const tokenData = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      token_type?: string;
    };

    const channelRes = await fetch(CHANNEL_URL, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!channelRes.ok) {
      const text = await channelRes.text();
      throw new Error(
        `YouTube 채널 조회 실패 (${channelRes.status}): ${text.slice(0, 200)}`,
      );
    }
    const channelData = (await channelRes.json()) as {
      items?: Array<{
        id: string;
        snippet?: {
          title?: string;
          thumbnails?: { default?: { url?: string } };
        };
      }>;
    };

    const channel = channelData.items?.[0];
    if (!channel) {
      throw new Error(
        "연결된 YouTube 채널이 없습니다. 채널을 먼저 생성한 뒤 다시 시도하세요.",
      );
    }

    return {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token ?? null,
      expiresAt: tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1000)
        : null,
      accountInfo: {
        platformAccountId: channel.id,
        displayName: channel.snippet?.title ?? null,
        avatarUrl: channel.snippet?.thumbnails?.default?.url ?? null,
      },
    };
  },

  // ───────────────────────────────────────────────────────────────────────────
  // YouTube Data API v3 videos.insert (resumable upload).
  // Storage에서 16MB씩 잘라 와 이어 올린다 — 800MB급도 메모리 16MB로 처리하고,
  // 끊기면 그 지점부터 재개한다. 자세한 배경은 위 헬퍼 블록 주석 참고.
  //
  // 캡션 매핑:
  //   title       → snippet.title (필수)
  //   description → snippet.description (선택, hashtags 본문에 부착)
  //   hashtags    → snippet.tags 그리고 description 끝에 #tag 형태로 추가
  //                 (YouTube는 description의 #태그가 검색에 반영됨)
  //
  // 공개 범위는 일단 PUBLIC. 추후 사용자 설정으로 빼야 함.
  // ───────────────────────────────────────────────────────────────────────────
  async publish(ctx, accessToken): Promise<PublishResult> {
    if (ctx.mediaType !== "VIDEO") {
      throw new PublishError(
        `YouTube는 동영상만 지원합니다 (received: ${ctx.mediaType})`,
      );
    }
    const signedUrl = ctx.mediaSignedUrls[0];
    if (!signedUrl) {
      throw new MediaError("YouTube publish: 미디어 서명 URL이 비어있습니다");
    }
    if (!ctx.title) {
      throw new PublishError("YouTube publish: title 누락");
    }

    // 1. Storage 미디어 크기·타입 확인 (본문은 받지 않는다)
    const probe = await probeMedia(signedUrl);

    // 2. snippet/status JSON 조립
    const hashtagText = ctx.hashtags.length > 0 ? ctx.hashtags.join(" ") : "";
    const description = replaceAngleBrackets(
      [ctx.description, hashtagText].filter((s) => s && s.trim()).join("\n\n"),
    );

    const meta = {
      snippet: {
        title: replaceAngleBrackets(ctx.title),
        description,
        // YouTube tags는 # 없이 키워드만. hashtags는 사용자가 #포함으로 저장하므로 strip.
        tags: ctx.hashtags
          .map((t) => replaceAngleBrackets(t.replace(/^#/, "")))
          .slice(0, 15),
      },
      status: {
        privacyStatus: "public" as const,
        selfDeclaredMadeForKids: false,
      },
    };

    // 3. resumable 세션을 열고 청크로 이어 올린다
    const sessionUri = await startResumableSession(meta, probe, accessToken);
    const uploaded = await uploadResumable(
      sessionUri,
      signedUrl,
      probe,
      accessToken,
    );

    if (!uploaded.id) {
      throw new PublishError("YouTube 응답에 video id가 없습니다");
    }

    // 4. 커스텀 썸네일(커버) — 사용자가 고른 프레임을 이미지로 추출해 올려둔 것.
    //    best-effort: 영상 업로드는 이미 성공했으므로 실패해도 throw하지 않는다.
    //    미인증 채널(403)·일시 오류 등은 경고만 남기고 영상 게시는 성공 처리.
    if (ctx.coverSignedUrl) {
      await setThumbnail(uploaded.id, ctx.coverSignedUrl, accessToken);
    }

    return {
      platformPostId: uploaded.id,
      platformPostUrl: `https://www.youtube.com/watch?v=${uploaded.id}`,
    };
  },

  async refreshToken(refreshTokenPlain): Promise<RefreshedTokens> {
    const clientId = process.env.YOUTUBE_CLIENT_ID;
    const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET 환경변수 없음");
    }

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshTokenPlain,
        grant_type: "refresh_token",
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      // Google: refresh_token이 revoke되면 400 + "invalid_grant". 영구 실패.
      if (
        res.status === 400 &&
        (text.includes("invalid_grant") || text.includes("invalid_token"))
      ) {
        throw new TokenExpiredError(
          `YouTube refresh_token revoke됨: ${text.slice(0, 200)}`,
        );
      }
      throw new PublishError(
        `YouTube refresh 실패 (${res.status}): ${text.slice(0, 200)}`,
      );
    }

    const data = (await res.json()) as {
      access_token: string;
      expires_in?: number;
      refresh_token?: string;
    };

    return {
      accessToken: data.access_token,
      // Google은 보통 refresh_token을 재발급하지 않음 (있으면 사용).
      refreshToken: data.refresh_token ?? null,
      expiresAt: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000)
        : null,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 커스텀 썸네일 업로드 (best-effort). 커버 이미지를 Storage에서 가져와 그대로
// thumbnails.set에 PUT한다. 영상 게시는 이미 끝났으므로 실패해도 throw하지 않고
// 경고만 남긴다 — 미인증 채널이면 403(youtubeSignupRequired 등)이 흔하다.
// ─────────────────────────────────────────────────────────────────────────────
async function setThumbnail(
  videoId: string,
  coverSignedUrl: string,
  accessToken: string,
): Promise<void> {
  try {
    const imgRes = await fetch(coverSignedUrl);
    if (!imgRes.ok) {
      console.warn(
        `[youtube] 커버 이미지 fetch 실패 (${imgRes.status}) — 썸네일 건너뜀`,
      );
      return;
    }
    const imgBytes = Buffer.from(await imgRes.arrayBuffer());
    const contentType = imgRes.headers.get("content-type") ?? "image/jpeg";

    const res = await fetch(`${THUMBNAIL_SET_URL}&videoId=${videoId}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": contentType,
      },
      body: imgBytes,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(
        `[youtube] 썸네일 set 실패 (${res.status}) — 영상 게시는 완료됨. ` +
          `미인증 채널이면 채널 전화 인증 필요. ${text.slice(0, 200)}`,
      );
    }
  } catch (err) {
    console.warn(
      "[youtube] 썸네일 set 중 예외 — 영상 게시는 완료됨:",
      err instanceof Error ? err.message : err,
    );
  }
}
