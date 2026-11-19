"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentProfile, getSessionUser } from "@/lib/auth";
import { triggerStyleEditRun, triggerStyleRefsRun } from "@/lib/github-dispatch";
import { cardEditSchema, MAX_REFERENCES, parseInstagramUrl, type StyleCard } from "@/lib/style-shorts/card";
import { CONCEPT_MAX, MAX_CLIP_BYTES, MAX_CLIPS, SCRIPT_MAX, type JobClip, type VersionRequest } from "@/lib/style-shorts/jobs";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";

// 스타일 쇼츠(/style-shorts, 메뉴 없는 시험 페이지) — 스타일 폴더 · 레퍼런스 · 스타일 카드.
// 레퍼런스 영상 파일은 화면이 media 버킷({org}/{user}/style-shorts/refs/…)에 직접 올리고, 여기서는 기록만 남긴다.
// 분석은 워커(style-shorts 워크플로)가 한다. 쓰기는 service_role, 조직 누구나 쓸 수 있다(개인 시험 도구).

export type StyleResult = { ok: true; id?: string; warning?: string } | { ok: false; error: string };
type Service = ReturnType<typeof createServiceClient>;

async function authorize(): Promise<{ ok: true; userId: string; orgId: string } | { ok: false; error: string }> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "로그인이 필요합니다." };
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) return { ok: false, error: "소속된 조직이 없습니다." };
  return { ok: true, userId: user.id, orgId: profile.organization_id };
}

function revalidate(folderId?: string) {
  revalidatePath("/style-shorts");
  if (folderId) revalidatePath(`/style-shorts/folders/${folderId}`);
}

/**
 * 워커를 깨운다. 실패해도 저장은 끝났으니 경고로만 알린다(하루 두 번 백업 실행이 집어 간다).
 * 폴더를 지정하지 않는다 — GitHub은 대기 중인 실행을 마지막 하나만 남기므로, 폴더를 지정하면 앞서 넣은 다른 폴더가 밀린다.
 */
async function wake(reason: string, folderId: string): Promise<string | undefined> {
  try {
    await triggerStyleRefsRun(`${reason} (folder=${folderId})`);
    return undefined;
  } catch (err) {
    console.error("[style-shorts] 워커 깨우기 실패:", err);
    return "저장했지만 분석을 바로 시작하지 못했어요. 몇 시간 안에 자동으로 분석해요.";
  }
}

async function loadFolder(service: Service, folderId: string, orgId: string) {
  const { data } = await service.from("style_folders").select("id, card, card_edited, card_status").eq("id", folderId).eq("organization_id", orgId).maybeSingle();
  return data;
}

/** 레퍼런스가 바뀌었다 — 사람이 고치지 않은 카드면 다시 만들게 표시하고, 레퍼런스가 없으면 비운다. */
async function refreshCardState(service: Service, folderId: string): Promise<boolean> {
  const { count } = await service.from("style_references").select("id", { count: "exact", head: true }).eq("folder_id", folderId);
  const now = new Date().toISOString();
  if (!count) {
    await service.from("style_folders").update({ card_status: "EMPTY", card: null, card_edited: false, card_built_from: [], card_error: null, updated_at: now }).eq("id", folderId);
    return false;
  }
  const { data } = await service.from("style_folders").update({ card_status: "PENDING", card_error: null, updated_at: now }).eq("id", folderId).eq("card_edited", false).neq("card_status", "ANALYZING").select("id");
  return !!data?.length;
}

// ─── 폴더 ─────────────────────────────────────────────────────────────────────

const folderSchema = z.object({ name: z.string().trim().min(1).max(40), memo: z.string().trim().max(300).optional() });

export async function createFolderAction(input: z.infer<typeof folderSchema>): Promise<StyleResult> {
  const parsed = folderSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "폴더 이름은 1~40자로 적어 주세요." };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const { data, error } = await createServiceClient()
    .from("style_folders")
    .insert({ organization_id: auth.orgId, name: parsed.data.name, memo: parsed.data.memo || null, created_by: auth.userId })
    .select("id")
    .single();
  if (error) return { ok: false, error: `폴더를 만들지 못했어요: ${error.message}` };
  revalidate();
  return { ok: true, id: data.id };
}

const renameSchema = folderSchema.extend({ folderId: z.string().uuid() });

export async function updateFolderAction(input: z.infer<typeof renameSchema>): Promise<StyleResult> {
  const parsed = renameSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "폴더 이름은 1~40자로 적어 주세요." };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const { error } = await createServiceClient()
    .from("style_folders")
    .update({ name: parsed.data.name, memo: parsed.data.memo || null, updated_at: new Date().toISOString() })
    .eq("id", parsed.data.folderId)
    .eq("organization_id", auth.orgId);
  if (error) return { ok: false, error: `저장하지 못했어요: ${error.message}` };
  revalidate(parsed.data.folderId);
  return { ok: true };
}

const idSchema = z.object({ id: z.string().uuid() });

/** 폴더 지우기 — 레퍼런스 기록과 올린 레퍼런스 영상 파일도 함께 지운다. */
export async function deleteFolderAction(input: z.infer<typeof idSchema>): Promise<StyleResult> {
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const { data: refs } = await service.from("style_references").select("storage_path").eq("folder_id", parsed.data.id).eq("organization_id", auth.orgId);
  const paths = (refs ?? []).map((r) => r.storage_path).filter((p): p is string => !!p);
  const { error } = await service.from("style_folders").delete().eq("id", parsed.data.id).eq("organization_id", auth.orgId);
  if (error) return { ok: false, error: `지우지 못했어요: ${error.message}` };
  if (paths.length) {
    const { error: rmError } = await service.storage.from("media").remove(paths);
    if (rmError) console.error("[style-shorts] 레퍼런스 파일 지우기 실패:", rmError.message);
  }
  revalidate();
  return { ok: true };
}

// ─── 레퍼런스 ─────────────────────────────────────────────────────────────────

async function roomLeft(service: Service, folderId: string): Promise<number> {
  const { count } = await service.from("style_references").select("id", { count: "exact", head: true }).eq("folder_id", folderId);
  return MAX_REFERENCES - (count ?? 0);
}

const uploadsSchema = z.object({
  folderId: z.string().uuid(),
  files: z.array(z.object({ path: z.string().min(1).max(300), name: z.string().trim().max(200) })).min(1).max(MAX_REFERENCES),
});

/** 화면이 올린 레퍼런스 영상 파일을 기록하고 분석을 시작한다. */
export async function addUploadReferencesAction(input: z.infer<typeof uploadsSchema>): Promise<StyleResult> {
  const parsed = uploadsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const { folderId, files } = parsed.data;
  const prefix = `${auth.orgId}/${auth.userId}/style-shorts/refs/`;
  if (files.some((f) => !f.path.startsWith(prefix) || f.path.includes(".."))) return { ok: false, error: "올린 파일 경로가 올바르지 않아요." };
  const service = createServiceClient();
  if (!(await loadFolder(service, folderId, auth.orgId))) return { ok: false, error: "폴더를 찾지 못했어요." };
  if ((await roomLeft(service, folderId)) < files.length) return { ok: false, error: `레퍼런스는 폴더마다 ${MAX_REFERENCES}개까지예요.` };

  const { error } = await service.from("style_references").insert(
    files.map((f) => ({ organization_id: auth.orgId, folder_id: folderId, kind: "UPLOAD", storage_path: f.path, file_name: f.name || null, created_by: auth.userId })),
  );
  if (error) return { ok: false, error: `기록하지 못했어요: ${error.message}` };
  await refreshCardState(service, folderId);
  const warning = await wake("레퍼런스 영상 추가", folderId);
  revalidate(folderId);
  return { ok: true, warning };
}

const instagramSchema = z.object({
  folderId: z.string().uuid(),
  url: z.string().trim().min(1).max(300),
  username: z.string().trim().max(31).optional(),
});

/** 인스타 릴스 링크를 레퍼런스로 넣는다. 주소에 계정 아이디가 없으면 따로 받는다(조회에 필요). */
export async function addInstagramReferenceAction(input: z.infer<typeof instagramSchema>): Promise<StyleResult> {
  const parsed = instagramSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const link = parseInstagramUrl(parsed.data.url);
  if (!link) return { ok: false, error: "인스타 릴스 주소가 아니에요. instagram.com/reel/… 주소를 넣어 주세요." };
  const typed = parsed.data.username?.replace(/^@/, "").toLowerCase() || null;
  if (typed && !/^[a-z0-9._]{1,30}$/.test(typed)) return { ok: false, error: "계정 아이디는 영문 · 숫자 · 마침표 · 밑줄만 써요." };
  const username = typed ?? link.username;
  if (!username) return { ok: false, error: "이 주소에는 계정 아이디가 없어요. 릴스를 올린 계정 아이디를 함께 적어 주세요." };

  const service = createServiceClient();
  if (!(await loadFolder(service, parsed.data.folderId, auth.orgId))) return { ok: false, error: "폴더를 찾지 못했어요." };
  if ((await roomLeft(service, parsed.data.folderId)) < 1) return { ok: false, error: `레퍼런스는 폴더마다 ${MAX_REFERENCES}개까지예요.` };
  const { count } = await service.from("style_references").select("id", { count: "exact", head: true }).eq("folder_id", parsed.data.folderId).eq("permalink", link.permalink);
  if (count) return { ok: false, error: "이미 넣은 릴스예요." };

  const { error } = await service
    .from("style_references")
    .insert({ organization_id: auth.orgId, folder_id: parsed.data.folderId, kind: "INSTAGRAM", permalink: link.permalink, username, created_by: auth.userId });
  if (error) return { ok: false, error: `기록하지 못했어요: ${error.message}` };
  await refreshCardState(service, parsed.data.folderId);
  const warning = await wake("레퍼런스 링크 추가", parsed.data.folderId);
  revalidate(parsed.data.folderId);
  return { ok: true, warning };
}

/** 레퍼런스 빼기 — 올린 파일도 지운다. 사람이 고치지 않은 카드는 남은 레퍼런스로 다시 만든다. */
export async function removeReferenceAction(input: z.infer<typeof idSchema>): Promise<StyleResult> {
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const { data: ref } = await service.from("style_references").select("id, folder_id, storage_path").eq("id", parsed.data.id).eq("organization_id", auth.orgId).maybeSingle();
  if (!ref) return { ok: false, error: "레퍼런스를 찾지 못했어요." };
  const { error } = await service.from("style_references").delete().eq("id", ref.id);
  if (error) return { ok: false, error: `지우지 못했어요: ${error.message}` };
  if (ref.storage_path) {
    const { error: rmError } = await service.storage.from("media").remove([ref.storage_path]);
    if (rmError) console.error("[style-shorts] 레퍼런스 파일 지우기 실패:", rmError.message);
  }
  const pending = await refreshCardState(service, ref.folder_id);
  const warning = pending ? await wake("레퍼런스 제외", ref.folder_id) : undefined;
  revalidate(ref.folder_id);
  return { ok: true, warning };
}

/** 실패한 레퍼런스 다시 분석 */
export async function retryReferenceAction(input: z.infer<typeof idSchema>): Promise<StyleResult> {
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const { data } = await service
    .from("style_references")
    .update({ status: "PENDING", error: null, analyzing_since: null, updated_at: new Date().toISOString() })
    .eq("id", parsed.data.id)
    .eq("organization_id", auth.orgId)
    .eq("status", "FAILED")
    .select("folder_id");
  const folderId = data?.[0]?.folder_id;
  if (!folderId) return { ok: false, error: "다시 분석할 수 있는 레퍼런스가 아니에요." };
  await refreshCardState(service, folderId);
  const warning = await wake("레퍼런스 다시 분석", folderId);
  revalidate(folderId);
  return { ok: true, warning };
}

// ─── 스타일 카드 ──────────────────────────────────────────────────────────────

/** 카드를 지금 레퍼런스로 다시 만든다 — 사람이 고친 내용은 사라진다(화면이 먼저 확인받는다). */
export async function rebuildCardAction(input: z.infer<typeof idSchema>): Promise<StyleResult> {
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const { count } = await service.from("style_references").select("id", { count: "exact", head: true }).eq("folder_id", parsed.data.id).eq("organization_id", auth.orgId);
  if (!count) return { ok: false, error: "레퍼런스를 먼저 넣어 주세요." };
  const { data, error } = await service
    .from("style_folders")
    .update({ card_status: "PENDING", card_edited: false, card_error: null, updated_at: new Date().toISOString() })
    .eq("id", parsed.data.id)
    .eq("organization_id", auth.orgId)
    .neq("card_status", "ANALYZING")
    .select("id");
  if (error) return { ok: false, error: `요청하지 못했어요: ${error.message}` };
  if (!data?.length) return { ok: false, error: "카드를 만드는 중이에요. 끝난 뒤 다시 눌러 주세요." };
  const warning = await wake("카드 다시 만들기", parsed.data.id);
  revalidate(parsed.data.id);
  return { ok: true, warning };
}

const saveCardSchema = z.object({ folderId: z.string().uuid(), edit: cardEditSchema });

/** 화면에서 고친 카드 글을 저장한다. 숫자는 그대로 두고, 이후 레퍼런스가 바뀌어도 자동으로 덮어쓰지 않는다. */
export async function saveCardAction(input: z.infer<typeof saveCardSchema>): Promise<StyleResult> {
  const parsed = saveCardSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "카드 내용이 너무 길거나 비어 있어요." };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const folder = await loadFolder(service, parsed.data.folderId, auth.orgId);
  if (!folder?.card) return { ok: false, error: "카드가 아직 없어요." };
  if (folder.card_status === "ANALYZING") return { ok: false, error: "카드를 다시 만드는 중이에요. 끝난 뒤 고쳐 주세요." };
  const now = new Date().toISOString();
  const card: StyleCard = { ...(folder.card as unknown as StyleCard), ...parsed.data.edit, editedAt: now };
  const { error } = await service
    .from("style_folders")
    .update({ card: card as unknown as Json, card_edited: true, card_status: "READY", updated_at: now })
    .eq("id", parsed.data.folderId);
  if (error) return { ok: false, error: `저장하지 못했어요: ${error.message}` };
  revalidate(parsed.data.folderId);
  return { ok: true };
}

// ─── 쇼츠 만들기 · 버전 ───────────────────────────────────────────────────────

function revalidateJob(jobId?: string) {
  revalidatePath("/style-shorts");
  if (jobId) revalidatePath(`/style-shorts/jobs/${jobId}`);
}

/** 편집 워커를 깨운다. 실패해도 저장은 끝났으니 경고로만 알린다(하루 두 번 백업 실행이 집어 간다). */
async function wakeEdit(reason: string): Promise<string | undefined> {
  try {
    await triggerStyleEditRun(reason);
    return undefined;
  } catch (err) {
    console.error("[style-shorts] 편집 워커 깨우기 실패:", err);
    return "저장했지만 편집을 바로 시작하지 못했어요. 몇 시간 안에 자동으로 편집해요.";
  }
}

const createJobSchema = z.object({
  folderId: z.string().uuid(),
  draftId: z.string().uuid(),
  title: z.string().trim().max(60).optional(),
  voiceMode: z.enum(["AI", "LIVE"]),
  script: z.string().trim().max(SCRIPT_MAX).optional(),
  concept: z.string().trim().max(CONCEPT_MAX).optional(),
  clips: z
    .array(z.object({ path: z.string().min(1).max(300), name: z.string().trim().max(200), size: z.number().int().min(1).max(MAX_CLIP_BYTES) }))
    .min(1)
    .max(MAX_CLIPS),
});

/** 쇼츠 만들기 — 카드는 지금 것을 그대로 저장하고(폴더를 고쳐도 이 영상은 그대로), v1 편집을 시작한다. */
export async function createJobAction(input: z.infer<typeof createJobSchema>): Promise<StyleResult> {
  const parsed = createJobSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "입력을 확인해 주세요. 대본은 3,000자, 컨셉은 1,000자까지예요." };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const d = parsed.data;
  const prefix = `${auth.orgId}/${auth.userId}/style-shorts/clips/${d.draftId}/`;
  if (d.clips.some((c) => !c.path.startsWith(prefix) || c.path.includes(".."))) return { ok: false, error: "올린 파일 경로가 올바르지 않아요." };
  const service = createServiceClient();
  const { data: folder } = await service.from("style_folders").select("id, name, card, card_status").eq("id", d.folderId).eq("organization_id", auth.orgId).maybeSingle();
  if (!folder) return { ok: false, error: "스타일 폴더를 찾지 못했어요." };
  if (!folder.card || folder.card_status !== "READY") return { ok: false, error: "이 폴더의 스타일 카드가 아직 없어요. 카드가 완성된 뒤 만들어 주세요." };

  const { data: job, error } = await service
    .from("style_short_jobs")
    .insert({
      organization_id: auth.orgId,
      folder_id: folder.id,
      folder_name: folder.name,
      card: folder.card,
      title: d.title || null,
      voice_mode: d.voiceMode,
      script: d.script || null,
      concept: d.concept || null,
      clips: d.clips as unknown as Json,
      created_by: auth.userId,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: `만들기 요청을 저장하지 못했어요: ${error.message}` };
  const { error: vErr } = await service.from("style_short_versions").insert({ organization_id: auth.orgId, job_id: job.id, version: 1, created_by: auth.userId });
  if (vErr) {
    await service.from("style_short_jobs").delete().eq("id", job.id);
    return { ok: false, error: `편집을 시작하지 못했어요: ${vErr.message}` };
  }
  const warning = await wakeEdit("스타일 쇼츠 만들기");
  revalidateJob(job.id);
  return { ok: true, id: job.id, warning };
}

async function loadJob(service: Service, jobId: string, orgId: string) {
  const { data } = await service.from("style_short_jobs").select("id, clips, clips_deleted_at").eq("id", jobId).eq("organization_id", orgId).maybeSingle();
  return data;
}

async function busyOrLatest(service: Service, jobId: string): Promise<{ busy: boolean; latest: number }> {
  const { data } = await service.from("style_short_versions").select("version, status").eq("job_id", jobId).order("version", { ascending: false });
  const rows = data ?? [];
  return { busy: rows.some((r) => r.status === "PENDING" || r.status === "EDITING"), latest: rows[0]?.version ?? 0 };
}

/** 같은 촬영본 · 카드 · 대본으로 처음부터 다시 만든다 — 새 버전으로 누적된다. */
export async function remakeJobAction(input: z.infer<typeof idSchema>): Promise<StyleResult> {
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const job = await loadJob(service, parsed.data.id, auth.orgId);
  if (!job) return { ok: false, error: "요청을 찾지 못했어요." };
  if (job.clips_deleted_at) return { ok: false, error: "촬영본 보관 기간이 지나 다시 만들 수 없어요. 새로 만들어 주세요." };
  const { busy, latest } = await busyOrLatest(service, job.id);
  if (busy) return { ok: false, error: "지금 편집 중이에요. 끝난 뒤 다시 눌러 주세요." };
  const request: VersionRequest = { kind: "remake", from: latest };
  const { error } = await service
    .from("style_short_versions")
    .insert({ organization_id: auth.orgId, job_id: job.id, version: latest + 1, request: request as unknown as Json, created_by: auth.userId });
  if (error) return { ok: false, error: `다시 만들기를 시작하지 못했어요: ${error.message}` };
  const warning = await wakeEdit("스타일 쇼츠 다시 만들기");
  revalidateJob(job.id);
  return { ok: true, warning };
}

/** 실패한 버전을 같은 번호로 다시 편집한다. */
export async function retryVersionAction(input: z.infer<typeof idSchema>): Promise<StyleResult> {
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const { data } = await service
    .from("style_short_versions")
    .update({ status: "PENDING", error: null, editing_since: null, finished_at: null })
    .eq("id", parsed.data.id)
    .eq("organization_id", auth.orgId)
    .eq("status", "FAILED")
    .select("job_id");
  const jobId = data?.[0]?.job_id;
  if (!jobId) return { ok: false, error: "다시 편집할 수 있는 버전이 아니에요." };
  const warning = await wakeEdit("스타일 쇼츠 다시 편집");
  revalidateJob(jobId);
  return { ok: true, warning };
}

/** 만든 쇼츠 지우기 — 촬영본 · 모든 버전의 완성본 · 주석까지 지운다. */
export async function deleteJobAction(input: z.infer<typeof idSchema>): Promise<StyleResult> {
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "잘못된 입력" };
  const auth = await authorize();
  if (!auth.ok) return auth;
  const service = createServiceClient();
  const job = await loadJob(service, parsed.data.id, auth.orgId);
  if (!job) return { ok: false, error: "요청을 찾지 못했어요." };
  const { busy } = await busyOrLatest(service, job.id);
  if (busy) return { ok: false, error: "편집 중에는 지울 수 없어요. 끝난 뒤 지워 주세요." };
  const { data: versions } = await service.from("style_short_versions").select("video_path, cover_path").eq("job_id", job.id);
  const paths = [
    ...(job.clips_deleted_at ? [] : ((job.clips ?? []) as unknown as JobClip[]).map((c) => c.path)),
    ...(versions ?? []).flatMap((v) => [v.video_path, v.cover_path]).filter((p): p is string => !!p),
  ];
  const { error } = await service.from("style_short_jobs").delete().eq("id", job.id);
  if (error) return { ok: false, error: `지우지 못했어요: ${error.message}` };
  if (paths.length) {
    const { error: rmError } = await service.storage.from("media").remove(paths);
    if (rmError) console.error("[style-shorts] 파일 지우기 실패:", rmError.message);
  }
  revalidateJob();
  return { ok: true };
}
