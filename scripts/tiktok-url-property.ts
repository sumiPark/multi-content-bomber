// TikTok 영상 주소 소유 인증(URL property). TikTok은 인증한 주소에서만 영상을 가져가 게시한다.
//
//   npx tsx scripts/tiktok-url-property.ts list
//   npx tsx scripts/tiktok-url-property.ts add    [https://mcb.cuma.co.kr/]   → 서명 파일을 public/에 만든다
//   (커밋 · 배포해서 https://mcb.cuma.co.kr/<파일 이름>이 열리면)
//   npx tsx scripts/tiktok-url-property.ts verify [https://mcb.cuma.co.kr/]
//
// 주소 앞부분(property_type 2) 방식 — 서명 파일을 그 주소 바로 아래에 둔다. 도메인 첫 경로(/)를 인증하면
// /tiktok-media/ 아래 영상 주소도 포함된다.
import "../worker/load-env";

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { addUrlProperty, listUrlProperties, verifyUrlProperty } from "@/lib/platforms/tiktok-business";

const PROPERTY_TYPE = 2 as const;

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const site = (process.env.TIKTOK_MEDIA_BASE_URL || process.env.NEXT_PUBLIC_SITE_URL || "").replace(/\/$/, "");
  const url = arg ?? `${site}/`;

  if (cmd === "list") {
    console.log(JSON.stringify(await listUrlProperties(), null, 2));
    return;
  }
  if (!url.startsWith("https://") || !url.endsWith("/")) {
    throw new Error(`주소는 https://로 시작하고 /로 끝나야 해요: ${url}`);
  }
  if (cmd === "add") {
    const info = await addUrlProperty(PROPERTY_TYPE, url);
    console.log(JSON.stringify(info, null, 2));
    if (info.file_name && info.signature) {
      const path = new URL(url).pathname.replace(/^\//, "");
      const target = join(process.cwd(), "public", path, info.file_name);
      writeFileSync(target, info.signature, "utf8");
      console.log(`서명 파일을 만들었어요: ${target} → 배포 후 verify`);
    }
    return;
  }
  if (cmd === "verify") {
    const info = await verifyUrlProperty(PROPERTY_TYPE, url);
    console.log(JSON.stringify(info, null, 2));
    console.log(info.property_status === 1 ? "인증됐어요" : "아직 인증 전이에요 — 서명 파일이 배포됐는지 확인");
    return;
  }
  throw new Error("명령: list | add [주소] | verify [주소]");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
