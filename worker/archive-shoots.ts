// .env.local 로드는 다른 어떤 import보다 먼저 (dev 전용 — GitHub Actions에선 no-op)
import "./load-env";

import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { videoProductName } from "@/lib/agents/product-facts";
import { findArchiveCut, saveArchiveCut, verifyArchiveCut, type ArchiveCandidate } from "@/lib/auto-video/archive";
import { warnIfError } from "@/lib/supabase/result";
import { createServiceClient } from "@/lib/supabase/service";

// 자사 촬영 아카이브 워커 — "올렸어요"를 누른 촬영본에서 재사용할 제품 컷을 남긴다(얼굴 제외, 손 · 팔 허용). shoot-edit 워크플로에서 돈다.
// 사용: npm run worker:archive-shoots -- [--request <id>] [--dry-run]

type Service = ReturnType<typeof createServiceClient>;
type Clip = { cut: number; path: string };
type Cut = { no: number; shot?: string };

const MAX_REQUESTS_PER_RUN = 3;
const MAX_ATTEMPTS = 3;
const MAX_PER_SHOOT = 3;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
}

async function download(service: Service, path: string, to: string): Promise<void> {
  const { data, error } = await service.storage.from("media").createSignedUrl(path, 3600);
  if (error || !data) throw new Error(`촬영본 링크 실패: ${error?.message}`);
  const res = await fetch(data.signedUrl);
  if (!res.ok || !res.body) throw new Error(`촬영본 받기 실패 (${res.status})`);
  await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), createWriteStream(to));
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const only = arg("--request");
  const service = createServiceClient();
  let q = service
    .from("shoot_requests")
    .select("id, organization_id, clips, cuts, archive_attempts, content_plans!inner(product_id, posted_at, track, products(name))")
    .eq("content_plans.track", "A")
    .not("content_plans.posted_at", "is", null);
  q = only ? q.eq("id", only) : q.is("archived_at", null).lt("archive_attempts", MAX_ATTEMPTS).order("updated_at").limit(MAX_REQUESTS_PER_RUN);
  const { data, error } = await q;
  if (error) throw new Error(`촬영 요청 조회 실패: ${error.message}`);
  console.log(`[archive-shoots] 대상 ${data?.length ?? 0}건${dryRun ? " (저장 안 함)" : ""}`);

  for (const req of data ?? []) {
    const plan = req.content_plans;
    const clips = (Array.isArray(req.clips) ? req.clips : []) as unknown as Clip[];
    const cuts = (Array.isArray(req.cuts) ? req.cuts : []) as unknown as Cut[];
    const workDir = join(tmpdir(), `archive-${req.id}`);
    rmSync(workDir, { recursive: true, force: true });
    mkdirSync(workDir, { recursive: true });
    let tokens = 0;
    try {
      // 원본이 이미 정리됐거나 상품이 없으면 남길 수 없으니 끝낸 것으로 친다
      if (clips.length && plan.product_id) {
        const productName = videoProductName(plan.products?.name ?? "");
        const found: { cut: ArchiveCandidate; clip: Clip; file: string; no: number }[] = [];
        for (const [i, clip] of clips.entries()) {
          const file = join(workDir, `in${i}.${clip.path.split(".").pop() ?? "mp4"}`);
          await download(service, clip.path, file);
          const shot = cuts.find((c) => c.no === clip.cut)?.shot ?? "";
          const r = await findArchiveCut(file, { productName, shot }, workDir, `c${i}`);
          tokens += r.tokens.input + r.tokens.output;
          console.log(`  컷 ${clip.cut}: ${r.cut ? `${r.cut.start.toFixed(1)}초부터 ${r.cut.seconds.toFixed(1)}초 · ${r.cut.quality}점 · ${r.cut.what}` : "남길 구간 없음"}`);
          if (r.cut) found.push({ cut: r.cut, clip, file, no: i });
        }
        found.sort((a, b) => b.cut.quality - a.cut.quality);
        let kept = 0;
        for (const f of found) {
          if (kept >= MAX_PER_SHOOT) break;
          const v = await verifyArchiveCut(f.file, f.cut, workDir, `keep${f.no}`);
          tokens += v.tokens.input + v.tokens.output;
          if (!v.file) {
            console.log(`  컷 ${f.clip.cut} 제외: ${v.reason}`);
            continue;
          }
          kept++;
          if (!dryRun) {
            await saveArchiveCut(
              service,
              { organizationId: req.organization_id, productId: plan.product_id, shootRequestId: req.id, sourcePath: f.clip.path, start: f.cut.start, seconds: f.cut.seconds, what: f.cut.what },
              v.file,
            );
          }
        }
        console.log(`[archive-shoots] ${req.id}: ${kept}컷 ${dryRun ? "통과" : "저장"} · 토큰 ${tokens}`);
      }
      if (!dryRun) {
        // 컷은 이미 저장했다 — 여기서 throw하면 다음 실행이 같은 촬영본을 다시 분석해 컷이 두 번 남으니 기록만 크게 남긴다
        const { error: doneErr } = await service.from("shoot_requests").update({ archived_at: new Date().toISOString() }).eq("id", req.id);
        if (doneErr) console.error(`[archive-shoots] ${req.id} 아카이브 완료 표시 실패 — 다음 실행이 다시 처리해 컷이 중복될 수 있음: ${doneErr.message}`);
      }
    } catch (err) {
      process.exitCode = 1;
      console.error(`[archive-shoots] ${req.id} 실패: ${err instanceof Error ? err.message : err}`);
      if (!dryRun) warnIfError(await service.from("shoot_requests").update({ archive_attempts: req.archive_attempts + 1 }).eq("id", req.id), `아카이브 시도 횟수 기록 (id=${req.id})`);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
