// .env.local 로드는 다른 어떤 import보다 먼저 (dev 전용 — GitHub Actions에선 no-op).
import "./load-env";

import { POSTED_KEEP_DAYS, shootFilesDeleteAt, UNPOSTED_KEEP_DAYS } from "@/lib/shoot/retention";
import { AUTO_VIDEO_KEEP_DAYS } from "@/lib/auto-video/retention";
import { createServiceClient } from "@/lib/supabase/service";

// ─────────────────────────────────────────────────────────────────────────────
// 버려진 작업 정리 — 콘텐츠 생성 중 '임시 저장' 없이 나간 것을 지운다.
// 0033부터 보관함은 임시 저장한 콘텐츠만 보여서, 저장 안 하고 나간 건 사람이 화면에서 지울 수 없다
// (개인정보처리방침 · 데이터 삭제 페이지의 "언제든 삭제" 약속과 맞추려고 자동으로 지운다).
//
// 대상 1. contents — 임시 저장 안 함(draft_saved_at 없음) + 발행 잡 0개 + 만든 지 7일 넘음
//         → 행을 지우고, 그 행의 파일(media_urls · metadata.thumbnail_path · cover_path)도 지운다.
//         단, 남는 다른 콘텐츠가 같은 파일을 쓰면(이어서 하기 → 새 콘텐츠) 그 파일은 남긴다.
// 대상 2. media 버킷의 콘텐츠 생성 업로드 — `조직/사용자/파일` 자리(하위 폴더 제외)에 있고
//         7일 넘었고 어떤 contents에도 안 쓰인 파일(2단계에서 올리고 캡션 전에 나간 것).
//         직접 촬영(`조직/사용자/shoot/…`)은 하위 폴더라 보지 않는다.
//
// 대상 3. 직접 촬영 — 보관 기간(lib/shoot/retention.ts: 올린 뒤 14일 · 안 올리면 편집 뒤 30일)이 지난 촬영 원본과 완성본 · 표지.
//         예전 자동 예약 기록의 완성본은 발행 콘텐츠가 쓰므로 남긴다.
//
// 발행 잡이 하나라도 있는 콘텐츠와 그 파일은 건드리지 않는다(발행 이력 보존 — 실패 · 취소 포함).
//
// ⚠️ CLEANUP_SINCE(임시 저장 기능 배포) 전에 만든 콘텐츠 · 파일은 보지 않는다. 그 전에는 발행 기록이
// 사라진 실제 게시물(0016 전 계정 해제 때 publish_jobs가 cascade로 지워진 것)이 "발행 잡 0개"로 섞여
// 있었다(2026-11-03 확인: 188개 중 172개가 캡션까지 다 쓴 실제 게시물). 버려진 작업과 구별할 수 없어 남긴다.
//
// 기본은 세기만 한다(아무것도 안 지움). `--apply`를 붙여야 지운다. `--days N`으로 기준(기본 7일).
// .github/workflows/cleanup-drafts.yml이 매일 깨운다.
// ─────────────────────────────────────────────────────────────────────────────

const BUCKET = "media";
// 임시 저장(0033) 배포 시점 — 이보다 먼저 만든 것은 정리하지 않는다(위 ⚠️).
const CLEANUP_SINCE = "2026-11-04T00:00:00+09:00";
const PAGE = 1000;
const REMOVE_BATCH = 100;

type Service = ReturnType<typeof createServiceClient>;

interface Args {
  apply: boolean;
  days: number;
}

function parseArgs(argv: string[]): Args {
  const apply = argv.includes("--apply");
  const i = argv.indexOf("--days");
  const days = i >= 0 ? Number(argv[i + 1]) : 7;
  if (!Number.isFinite(days) || days < 1) throw new Error("--days는 1 이상 숫자여야 해요");
  return { apply, days };
}

interface ContentRow {
  id: string;
  media_urls: string[] | null;
  metadata: unknown;
  created_at: string;
  draft_saved_at: string | null;
  publish_jobs: { id: string }[];
}

function contentPaths(c: ContentRow): string[] {
  const meta = (c.metadata && typeof c.metadata === "object" ? c.metadata : {}) as Record<string, unknown>;
  const extra = [meta.thumbnail_path, meta.cover_path].filter((p): p is string => typeof p === "string");
  return [...(c.media_urls ?? []), ...extra];
}

async function loadContents(service: Service): Promise<ContentRow[]> {
  const rows: ContentRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = (await service
      .from("contents")
      .select("id, media_urls, metadata, created_at, draft_saved_at, publish_jobs(id)")
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1)) as unknown as { data: ContentRow[] | null; error: { message: string } | null };
    if (error) {
      if (error.message.includes("draft_saved_at")) {
        throw new Error("contents.draft_saved_at이 없어요 — 0033_content_drafts.sql을 먼저 적용하세요.");
      }
      throw new Error(`contents 조회 실패: ${error.message}`);
    }
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

interface StorageItem {
  name: string;
  id: string | null;
  created_at: string | null;
  metadata: { size?: number } | null;
}

async function listAll(service: Service, prefix: string): Promise<StorageItem[]> {
  const out: StorageItem[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await service.storage.from(BUCKET).list(prefix, { limit: PAGE, offset });
    if (error) throw new Error(`저장소 목록 실패(${prefix || "/"}): ${error.message}`);
    out.push(...((data ?? []) as StorageItem[]));
    if (!data || data.length < PAGE) return out;
  }
}

// `조직/사용자/파일` 자리의 파일만 (폴더는 id가 null).
async function listWizardUploads(service: Service): Promise<{ path: string; createdAt: string | null; size: number }[]> {
  const files: { path: string; createdAt: string | null; size: number }[] = [];
  for (const org of await listAll(service, "")) {
    if (org.id !== null) continue;
    for (const user of await listAll(service, org.name)) {
      if (user.id !== null) continue;
      for (const f of await listAll(service, `${org.name}/${user.name}`)) {
        if (f.id === null) continue; // 하위 폴더(shoot 등)는 건드리지 않는다
        files.push({ path: `${org.name}/${user.name}/${f.name}`, createdAt: f.created_at, size: f.metadata?.size ?? 0 });
      }
    }
  }
  return files;
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

async function cleanupShootFiles(service: Service, apply: boolean): Promise<void> {
  const { data, error } = await service
    .from("shoot_requests")
    .select("id, clips, rendered_path, edit, updated_at, content_plans!inner(track, posted_at, content_id)")
    .eq("content_plans.track", "A");
  if (error) throw new Error(`촬영 요청 조회 실패: ${error.message}`);

  const now = Date.now();
  let requests = 0;
  let files = 0;
  let bytes = 0;
  for (const r of data ?? []) {
    const clips = (Array.isArray(r.clips) ? r.clips : []) as { path: string; size?: number }[];
    const edit = (r.edit ?? null) as { thumbnail?: string | null; editedAt?: string | null } | null;
    const plan = r.content_plans;
    if (now < shootFilesDeleteAt({ postedAt: plan.posted_at, editedAt: edit?.editedAt, updatedAt: r.updated_at })) continue;
    // 예전 자동 예약 기록(content_id 있음)의 완성본은 발행 콘텐츠가 쓰므로 두고, 그 밖의 완성본은 함께 지운다
    const unused = plan.content_id ? [] : [r.rendered_path, edit?.thumbnail].filter((p): p is string => !!p);
    const paths = [...clips.map((c) => c.path), ...unused];
    if (!paths.length) continue;
    requests++;
    files += paths.length;
    bytes += clips.reduce((sum, c) => sum + (c.size ?? 0), 0);
    if (!apply) continue;
    // 파일 먼저 — 파일만 지워지고 저장이 실패해도 다음 실행이 같은 경로를 다시 지우면 그만이다
    const { error: removeErr } = await service.storage.from(BUCKET).remove(paths);
    if (removeErr) {
      console.warn(`[cleanup-drafts] 촬영 파일 삭제 실패(${r.id}): ${removeErr.message}`);
      continue;
    }
    const { error: saveErr } = await service
      .from("shoot_requests")
      .update({
        clips: [],
        ...(unused.length ? { rendered_path: null, edit: edit ? { ...edit, thumbnail: null } : null } : {}),
      })
      .eq("id", r.id);
    if (saveErr) console.warn(`[cleanup-drafts] 촬영 요청 저장 실패(${r.id}): ${saveErr.message}`);
  }
  console.log(`  3) 보관 기간이 지난 직접 촬영(올린 뒤 ${POSTED_KEEP_DAYS}일 · 안 올리면 ${UNPOSTED_KEEP_DAYS}일): 요청 ${requests}개 · 파일 ${files}개 · 촬영 원본 약 ${mb(bytes)}${apply ? " 지움" : " (시험, 안 지움)"}`);
}

/** AI 자동 칸에서 올리지 않은 완성본만 지운다. 올린 영상은 발행 기록(contents)이 쓰므로 두고, 경로가 지워져도 기록은 남긴다. */
async function cleanupAutoVideos(service: Service, apply: boolean): Promise<void> {
  const { data, error } = await service
    .from("content_plans")
    .select("id, status, video")
    .eq("track", "B")
    .in("status", ["RENDERED", "BLOCKED", "SKIPPED", "FAILED"])
    .not("video", "is", null);
  if (error) {
    // 0046 적용 전이면 지울 것도 없다. 다른 정리를 막지 않는다
    console.warn(`  4) 자동 영상을 읽지 못해 건너뜀: ${error.message}`);
    return;
  }
  const cutoff = Date.now() - AUTO_VIDEO_KEEP_DAYS * 24 * 60 * 60 * 1000;
  let count = 0;
  for (const p of data ?? []) {
    const v = (p.video ?? {}) as { path?: string; thumbnail?: string; madeAt?: string };
    if (!v.path || !v.madeAt || Date.parse(v.madeAt) > cutoff) continue;
    count++;
    if (!apply) continue;
    const { error: removeErr } = await service.storage.from(BUCKET).remove([v.path, v.thumbnail].filter((x): x is string => !!x));
    if (removeErr) {
      console.warn(`[cleanup-drafts] 자동 영상 삭제 실패(${p.id}): ${removeErr.message}`);
      continue;
    }
    await service.from("content_plans").update({ video: { ...v, path: null, thumbnail: null } }).eq("id", p.id);
  }
  console.log(`  4) 올리지 않은 AI 자동 영상(${AUTO_VIDEO_KEEP_DAYS}일 지남): ${count}개`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const service = createServiceClient();
  const cutoffMs = Date.now() - args.days * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const sinceMs = new Date(CLEANUP_SINCE).getTime();
  const inWindow = (iso: string) => {
    const t = new Date(iso).getTime();
    return t >= sinceMs && t < cutoffMs;
  };

  const contents = await loadContents(service);
  const abandoned = contents.filter(
    (c) => c.publish_jobs.length === 0 && !c.draft_saved_at && inWindow(c.created_at),
  );
  const abandonedIds = new Set(abandoned.map((c) => c.id));

  // 남는 콘텐츠(발행 잡이 있거나 · 임시 저장했거나 · 아직 7일 안 된 것)가 쓰는 파일은 지우지 않는다.
  const keepRefs = new Set(contents.filter((c) => !abandonedIds.has(c.id)).flatMap(contentPaths));
  const allRefs = new Set(contents.flatMap(contentPaths));
  const abandonedFiles = Array.from(new Set(abandoned.flatMap(contentPaths))).filter((p) => !keepRefs.has(p));

  const uploads = await listWizardUploads(service);
  const sizeByPath = new Map(uploads.map((u) => [u.path, u.size]));
  const orphanFiles = uploads
    .filter((u) => !allRefs.has(u.path) && u.createdAt !== null && inWindow(u.createdAt))
    .map((u) => u.path);

  const bytes = [...abandonedFiles, ...orphanFiles].reduce((sum, p) => sum + (sizeByPath.get(p) ?? 0), 0);
  console.log(
    `[cleanup-drafts] 대상: ${CLEANUP_SINCE} ~ ${cutoffIso}(${args.days}일 전)에 만든 것 · ${args.apply ? "지우기" : "세기만"}`,
  );
  console.log(`  전체 콘텐츠 ${contents.length}개 · 콘텐츠 생성 업로드 파일 ${uploads.length}개`);
  console.log(`  1) 임시 저장 안 한 · 발행 안 한 콘텐츠: ${abandoned.length}개 (파일 ${abandonedFiles.length}개)`);
  console.log(`  2) 어떤 콘텐츠에도 안 쓰인 업로드 파일: ${orphanFiles.length}개`);
  console.log(`  지울 파일 용량 합계: 약 ${mb(bytes)}`);
  await cleanupShootFiles(service, args.apply);
  await cleanupAutoVideos(service, args.apply);

  if (!args.apply) {
    console.log("  (세기만 했어요. 지우려면 --apply)");
    return;
  }

  // 행 먼저 — 행만 지워지고 파일이 남으면 다음 실행의 2)가 치운다. 지우는 순간에도 조건을 다시 건다.
  let deletedRows = 0;
  const skipped = new Set<string>();
  const ids = abandoned.map((c) => c.id);
  for (let i = 0; i < ids.length; i += REMOVE_BATCH) {
    // 센 뒤 그 사이에 발행을 등록한 콘텐츠는 뺀다 — contents를 지우면 publish_jobs가 cascade로 같이 지워진다.
    const { data: withJobs, error: jobErr } = await service
      .from("publish_jobs")
      .select("content_id")
      .in("content_id", ids.slice(i, i + REMOVE_BATCH));
    if (jobErr) throw new Error(`발행 잡 확인 실패: ${jobErr.message}`);
    const busy = new Set((withJobs ?? []).map((j) => j.content_id));
    for (const id of busy) skipped.add(id);
    const batch = ids.slice(i, i + REMOVE_BATCH).filter((id) => !busy.has(id));
    if (batch.length === 0) continue;
    const { error, count } = await service
      .from("contents")
      .delete({ count: "exact" })
      .in("id", batch)
      .is("draft_saved_at", null)
      .gte("created_at", new Date(CLEANUP_SINCE).toISOString())
      .lt("created_at", cutoffIso);
    if (error) throw new Error(`콘텐츠 삭제 실패: ${error.message}`);
    deletedRows += count ?? 0;
  }

  // 건너뛴(그 사이 발행을 등록한) 콘텐츠의 파일은 남긴다.
  const skippedRefs = new Set(abandoned.filter((c) => skipped.has(c.id)).flatMap(contentPaths));
  let removedFiles = 0;
  const files = [...abandonedFiles.filter((f) => !skippedRefs.has(f)), ...orphanFiles];
  for (let i = 0; i < files.length; i += REMOVE_BATCH) {
    const batch = files.slice(i, i + REMOVE_BATCH);
    const { data, error } = await service.storage.from(BUCKET).remove(batch);
    if (error) console.warn(`[cleanup-drafts] 파일 삭제 일부 실패: ${error.message}`);
    removedFiles += data?.length ?? 0;
  }

  console.log(
    `  지웠어요: 콘텐츠 ${deletedRows}개 · 파일 ${removedFiles}개` +
      (skipped.size ? ` (그 사이 발행을 등록한 ${skipped.size}개는 건너뜀)` : ""),
  );
}

main().catch((err) => {
  console.error("[cleanup-drafts] 실패:", err instanceof Error ? err.message : err);
  process.exit(1);
});
