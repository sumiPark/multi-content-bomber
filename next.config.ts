import type { NextConfig } from "next";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");

const nextConfig: NextConfig = {
  async rewrites() {
    if (!supabaseUrl) return [];
    return [
      // TikTok 게시용 영상 주소(lib/platforms/tiktok-business.ts의 tiktokMediaUrl).
      // TikTok은 소유 인증한 도메인의 주소만 가져가서, Supabase 서명 주소를 우리 도메인으로 받아 그대로 전달한다
      // (리다이렉트가 아니라 대신 받아 넘김). 서명 token이 있어야만 맞으므로 열리는 범위는 서명 주소와 같다.
      {
        source: "/tiktok-media/:path*",
        has: [{ type: "query", key: "token", value: "(?<token>.+)" }],
        destination: `${supabaseUrl}/storage/v1/object/sign/:path*?token=:token`,
      },
    ];
  },
};

export default nextConfig;
