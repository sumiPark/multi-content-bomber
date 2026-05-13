import type { MetadataRoute } from "next";

// Meta Sharing Debugger가 403 + "robots.txt block" 안내를 줘서 명시적 allowlist 추가.
// 우리는 robots.txt 자체가 없었고 일반 curl로 facebookexternalhit User-Agent를 흉내내도
// 200 OK가 돌아왔지만, Meta 서버 측에서 일관되게 403이 발생. Vercel의 자동 봇 보호
// 또는 Meta IP 대역 차단 가능성. 명시적 robots.txt가 자동 보호 트리거를 피할 수 있어
// 무해한 1차 시도로 추가.
//
// 추가로 Facebot은 Facebook 공식 두 번째 crawler — preview/sharing용. 같이 allowlist.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/" },
      { userAgent: "facebookexternalhit", allow: "/" },
      { userAgent: "Facebot", allow: "/" },
      // Meta가 Instagram 관련 crawl에 쓰는 추가 user-agent
      { userAgent: "meta-externalagent", allow: "/" },
    ],
  };
}
