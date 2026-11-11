import "./server-guard";
import { instagram } from "./instagram";
import { threads } from "./threads";
import { tiktok } from "./tiktok";
import { youtube } from "./youtube";
import type { Platform, PlatformAdapter } from "./types";

export type {
  ContentPlatform,
  Platform,
  PlatformAdapter,
  OAuthTokens,
  PublishContext,
  PublishResult,
  RefreshedTokens,
} from "./types";
export {
  MediaError,
  PublishError,
  RateLimitedError,
  TokenExpiredError,
} from "./types";

const ADAPTERS: Partial<Record<Platform, PlatformAdapter>> = {
  INSTAGRAM: instagram,
  TIKTOK: tiktok,
  YOUTUBE: youtube,
  THREADS: threads,
};

export function getAdapter(platform: Platform): PlatformAdapter | null {
  return ADAPTERS[platform] ?? null;
}

export function isSupportedPlatform(value: string): value is Platform {
  return value === "INSTAGRAM" || value === "TIKTOK" || value === "YOUTUBE" || value === "THREADS";
}

export function getRedirectUri(platform: Platform): string {
  const base =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ||
    "http://localhost:3000";
  return `${base}/api/auth/callback/${platform.toLowerCase()}`;
}
