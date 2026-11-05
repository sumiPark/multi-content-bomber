// .env.local 로드는 다른 어떤 import보다 먼저 (dev 전용 — GitHub Actions에선 no-op)
import "./load-env";

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServiceClient } from "@/lib/supabase/service";

// 자막 모션 스킬을 비공개 저장 공간(private-tools, 0049)에서 받아 러너 임시 폴더에 푼다.
// 구매한 유료 자료라 저장소에 넣지 않는다. 받은 파일을 실행 기록(artifact)에 올리거나 로그에 내용을 출력하지 않는다.
// 사용: tsx worker/fetch-caption-skill.ts <풀 폴더>

const OBJECT = "caption-motion-seqc.tgz";

async function main() {
  const to = process.argv[2];
  if (!to) throw new Error("풀 폴더를 알려 주세요");
  const { data, error } = await createServiceClient().storage.from("private-tools").download(OBJECT);
  if (error || !data) throw new Error(`자막 모션 스킬 받기 실패: ${error?.message ?? "빈 파일"}`);
  mkdirSync(to, { recursive: true });
  const file = join(to, OBJECT);
  writeFileSync(file, Buffer.from(await data.arrayBuffer()));
  const res = spawnSync("tar", ["-xzf", file, "-C", to], { stdio: "inherit" });
  if (res.status !== 0) throw new Error("자막 모션 스킬 압축 풀기 실패");
  console.log("자막 모션 스킬 준비됨");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
