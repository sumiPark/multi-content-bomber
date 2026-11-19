// .env.local 로드는 다른 어떤 import보다 먼저 (dev 전용 — GitHub Actions에선 no-op).
import "./load-env";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBenchmarkAccount, type BenchmarkMedia } from "@/lib/benchmark/discovery";
import { listSystemAccounts } from "@/lib/platforms/instagram-insights";
import { analyzeReferenceCover, analyzeReferenceVideo, emptyAnalyzeUsage, writeStyleCard, type AnalyzeUsage } from "@/lib/style-shorts/analyze";
import { MAX_REFERENCE_BYTES, parseInstagramUrl, type ReferenceAnalysis } from "@/lib/style-shorts/card";
import { warnIfError } from "@/lib/supabase/result";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";

// ─────────────────────────────────────────────────────────────────────────────
// 스타일 쇼츠 — 레퍼런스 분석 · 스타일 카드 워커. "한 번 실행하고 종료"하는 배치.
//
// .github/workflows/style-shorts.yml이 화면에서 레퍼런스를 넣거나 "카드 다시 만들기"를 누른 직후 깨운다.
//   1. 분석 대기(PENDING) 레퍼런스를 하나씩 분석한다 — 영상 파일은 media 버킷에서, 인스타 링크는 Business Discovery로
//      영상 주소를 받는다(못 받으면 표지 · 캡션만). 분석 값만 남기고 남의 영상은 저장하지 않는다
//   2. 카드 대기(PENDING) 폴더의 레퍼런스 분석이 다 끝났으면 스타일 카드를 쓴다
// 사람이 고친 카드(card_edited)는 레퍼런스가 바뀌어도 자동으로 덮어쓰지 않는다 — 화면에서 다시 만들기를 눌러야 한다.
// 옵션: --folder <id> (그 폴더만)
// ─────────────────────────────────────────────────────────────────────────────

const RUN_BUDGET_MS = 40 * 60_000;
// 이보다 오래 "분석 중"이면 실행이 끊긴 것으로 보고 다시 집는다
const STALE_MS = 30 * 60_000;
const REF_LIMIT = 30;

type Service = ReturnType<typeof createServiceClient>;

interface RefRow {
  id: string;
  folder_id: string;
  kind: string;
  storage_path: string | null;
  file_name: string | null;
  permalink: string | null;
  username: string | null;
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

async function download(url: string, file: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`영상 받기 실패 ${res.status}`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_REFERENCE_BYTES) throw new Error("영상이 너무 커요");
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

/** 인스타 계정의 최근 게시물 — 한 실행에서 같은 계정은 한 번만 조회한다. */
class Discovery {
  private token = process.env.IG_DISCOVERY_TOKEN?.trim() ?? "";
  private base: string | null | undefined;
  private cache = new Map<string, BenchmarkMedia[]>();

  async find(username: string, shortcode: string): Promise<BenchmarkMedia | null> {
    if (!this.token) throw new Error("인스타 조회 키(IG_DISCOVERY_TOKEN)가 없어 링크를 분석할 수 없어요. 영상 파일로 올려 주세요.");
    if (this.base === undefined) this.base = (await listSystemAccounts(this.token)).values().next().value ?? null;
    if (!this.base) throw new Error("인스타 조회에 쓸 우리 계정을 찾지 못했어요. 영상 파일로 올려 주세요.");
    let media = this.cache.get(username);
    if (!media) {
      try {
        const profile = await readBenchmarkAccount(this.token, this.base, username);
        media = profile.media?.data ?? [];
      } catch (err) {
        throw new Error(`@${username} 계정을 조회하지 못했어요. 비즈니스 · 크리에이터 계정만 조회돼요. (${errorText(err).slice(0, 120)})`);
      }
      this.cache.set(username, media);
    }
    return media.find((m) => m.permalink?.includes(`/${shortcode}`)) ?? null;
  }
}

async function analyzeOne(service: Service, ref: RefRow, discovery: Discovery, usage: AnalyzeUsage): Promise<{ analysis: ReferenceAnalysis; from: "VIDEO" | "COVER" }> {
  const dir = mkdtempSync(join(tmpdir(), "style-ref-"));
  try {
    const file = join(dir, "ref.mp4");
    if (ref.kind === "UPLOAD") {
      const { data, error } = await service.storage.from("media").download(ref.storage_path as string);
      if (error || !data) throw new Error(`올린 영상을 받지 못했어요: ${error?.message ?? "없음"}`);
      writeFileSync(file, Buffer.from(await data.arrayBuffer()));
      return { analysis: await analyzeReferenceVideo(file, dir, null, usage), from: "VIDEO" };
    }

    const parsed = parseInstagramUrl(ref.permalink ?? "");
    if (!parsed) throw new Error("릴스 주소를 해석하지 못했어요.");
    const username = ref.username ?? parsed.username;
    if (!username) throw new Error("계정 아이디가 없어 조회할 수 없어요. 링크를 지우고 계정 아이디와 함께 다시 넣어 주세요.");
    const media = await discovery.find(username, parsed.shortcode);
    if (!media) throw new Error(`@${username}의 최근 게시물 50개 안에서 이 릴스를 찾지 못했어요. 영상 파일로 올려 주세요.`);
    if (media.media_url) {
      try {
        await download(media.media_url, file);
        return { analysis: await analyzeReferenceVideo(file, dir, media.caption ?? null, usage), from: "VIDEO" };
      } catch (err) {
        console.warn(`[style-refs] ${ref.id} 영상 분석 실패, 표지로 넘어감: ${errorText(err)}`);
      }
    }
    if (!media.thumbnail_url) throw new Error("영상 · 표지 주소를 받지 못했어요(저작권 음원이 든 릴스는 인스타가 주소를 주지 않아요). 영상 파일로 올려 주세요.");
    return { analysis: await analyzeReferenceCover(media.thumbnail_url, media.caption ?? null, usage), from: "COVER" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function recoverStale(service: Service): Promise<void> {
  const before = new Date(Date.now() - STALE_MS).toISOString();
  warnIfError(
    await service.from("style_references").update({ status: "PENDING", analyzing_since: null }).eq("status", "ANALYZING").lt("analyzing_since", before),
    "끊긴 레퍼런스 분석 되돌리기",
  );
  warnIfError(
    await service.from("style_folders").update({ card_status: "PENDING", card_started_at: null }).eq("card_status", "ANALYZING").lt("card_started_at", before),
    "끊긴 카드 만들기 되돌리기",
  );
}

/** 폴더 카드를 다시 만들어야 한다고 표시 — 사람이 고친 카드는 건드리지 않는다. */
async function markCardPending(service: Service, folderId: string): Promise<void> {
  warnIfError(
    await service.from("style_folders").update({ card_status: "PENDING", card_error: null, updated_at: new Date().toISOString() }).eq("id", folderId).eq("card_edited", false).neq("card_status", "ANALYZING"),
    `카드 대기 표시 (folder=${folderId})`,
  );
}

async function processReferences(service: Service, folder: string | undefined, started: number, usage: AnalyzeUsage): Promise<number> {
  let query = service.from("style_references").select("id, folder_id, kind, storage_path, file_name, permalink, username").eq("status", "PENDING").order("created_at").limit(REF_LIMIT);
  if (folder) query = query.eq("folder_id", folder);
  const { data, error } = await query;
  if (error) throw new Error(`레퍼런스 조회 실패: ${error.message}`);
  const discovery = new Discovery();
  let done = 0;
  for (const ref of (data ?? []) as RefRow[]) {
    if (Date.now() - started > RUN_BUDGET_MS) {
      console.log("[style-refs] 시간 예산을 넘어 남은 레퍼런스는 다음 실행에 넘겨요");
      break;
    }
    // 다른 실행이 먼저 집었으면 건너뛴다
    const { data: claimed } = await service
      .from("style_references")
      .update({ status: "ANALYZING", analyzing_since: new Date().toISOString(), error: null })
      .eq("id", ref.id)
      .eq("status", "PENDING")
      .select("id");
    if (!claimed?.length) continue;

    console.log(`[style-refs] 분석 시작 ${ref.id} (${ref.kind} ${ref.file_name ?? ref.permalink})`);
    try {
      const { analysis, from } = await analyzeOne(service, ref, discovery, usage);
      warnIfError(
        await service
          .from("style_references")
          .update({ status: "DONE", analysis: analysis as unknown as Json, analyzed_from: from, analyzing_since: null, updated_at: new Date().toISOString() })
          .eq("id", ref.id),
        `레퍼런스 저장 (${ref.id})`,
      );
      console.log(`[style-refs] 분석 완료 ${ref.id}: ${from}, ${analysis.durationSec}초, 컷 ${analysis.cuts.length}개, 효과음 10초당 ${analysis.sound?.sfxPer10s ?? "-"}개`);
      done += 1;
    } catch (err) {
      console.error(`[style-refs] 분석 실패 ${ref.id}:`, errorText(err));
      warnIfError(
        await service.from("style_references").update({ status: "FAILED", error: errorText(err), analyzing_since: null, updated_at: new Date().toISOString() }).eq("id", ref.id),
        `레퍼런스 실패 저장 (${ref.id})`,
      );
    }
    await markCardPending(service, ref.folder_id);
  }
  return done;
}

async function buildCards(service: Service, folder: string | undefined, usage: AnalyzeUsage): Promise<number> {
  let query = service.from("style_folders").select("id, name").eq("card_status", "PENDING");
  if (folder) query = query.eq("id", folder);
  const { data: folders, error } = await query;
  if (error) throw new Error(`폴더 조회 실패: ${error.message}`);
  let built = 0;
  for (const f of folders ?? []) {
    const { data: refs } = await service.from("style_references").select("id, kind, file_name, username, status, analysis, analyzed_from").eq("folder_id", f.id).order("created_at");
    const rows = refs ?? [];
    // 아직 분석 중인 레퍼런스가 있으면 다 끝난 뒤에
    if (rows.some((r) => r.status === "PENDING" || r.status === "ANALYZING")) continue;
    const ready = rows.filter((r) => r.status === "DONE" && r.analysis);
    const now = new Date().toISOString();
    if (!ready.length) {
      warnIfError(
        await service
          .from("style_folders")
          .update(rows.length ? { card_status: "FAILED", card_error: "분석을 마친 레퍼런스가 없어요. 실패한 레퍼런스의 이유를 확인해 주세요.", updated_at: now } : { card_status: "EMPTY", card: null, card_built_from: [], updated_at: now })
          .eq("id", f.id),
        `빈 카드 저장 (${f.id})`,
      );
      continue;
    }
    const { data: claimed } = await service.from("style_folders").update({ card_status: "ANALYZING", card_started_at: now }).eq("id", f.id).eq("card_status", "PENDING").select("id");
    if (!claimed?.length) continue;

    console.log(`[style-refs] 카드 만들기 ${f.id} (${f.name}, 레퍼런스 ${ready.length}개)`);
    try {
      const card = await writeStyleCard(
        ready.map((r) => ({
          label: r.kind === "UPLOAD" ? `영상 파일 ${r.file_name ?? ""}`.trim() : `인스타 @${r.username ?? ""}`,
          analysis: r.analysis as unknown as ReferenceAnalysis,
          video: r.analyzed_from === "VIDEO",
        })),
        usage,
      );
      warnIfError(
        await service
          .from("style_folders")
          .update({
            card: card as unknown as Json,
            card_status: "READY",
            card_error: null,
            card_edited: false,
            card_built_from: ready.map((r) => r.id),
            card_updated_at: new Date().toISOString(),
            card_started_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", f.id),
        `카드 저장 (${f.id})`,
      );
      built += 1;
    } catch (err) {
      console.error(`[style-refs] 카드 실패 ${f.id}:`, errorText(err));
      warnIfError(await service.from("style_folders").update({ card_status: "FAILED", card_error: errorText(err), card_started_at: null }).eq("id", f.id), `카드 실패 저장 (${f.id})`);
    }
  }
  return built;
}

async function main() {
  const started = Date.now();
  const folder = arg("--folder");
  const service = createServiceClient();
  const usage = emptyAnalyzeUsage();
  await recoverStale(service);
  const analyzed = await processReferences(service, folder, started, usage);
  const built = await buildCards(service, folder, usage);
  console.log(`[style-refs] 끝: 레퍼런스 ${analyzed}개 분석, 카드 ${built}개, 토큰 입력 ${usage.input} · 출력 ${usage.output}, 받아쓰기 ${Math.round(usage.audioSec)}초, ${Math.round((Date.now() - started) / 1000)}초`);
}

main().catch((err) => {
  console.error("[style-refs] 실패:", err);
  process.exitCode = 1;
});
