"use server";

import { revalidatePath, updateTag } from "next/cache";
import { z } from "zod";
import { MOA_CACHE_TAG } from "@/lib/moa/public";
import { normalizeSlug, slugProblem } from "@/lib/moa/slug";
import { isShopCode, refreshProductStatuses, type ProductRef } from "@/lib/moa/stock";
import { DEFAULT_THEME, themeSchema } from "@/lib/moa/theme";
import { blockDataSchema, socialItemSchema, type MoaBlockKind } from "@/lib/moa/types";
import { parseProductUrl } from "@/lib/products/landing-check";
import { fetchLandingProduct, ShopApiError } from "@/lib/products/shop-api";
import { SHOPS, SHOP_CODES, type ShopCode } from "@/lib/products/shops";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import type { Database, Json } from "@/types/database";

// 모아링크 서버 액션 (0063). 새 테이블은 authenticated에 쓰기 정책이 없어 모든 쓰기는 service_role로 하고,
// 권한(ADMIN · MANAGER)과 조직 범위는 여기서 직접 확인한다. 바꾼 뒤에는 공개 페이지 캐시를 바로 비운다.

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

type Service = ReturnType<typeof createServiceClient>;
type BlockInsert = Database["public"]["Tables"]["moa_blocks"]["Insert"];

interface Auth {
  userId: string;
  organizationId: string;
}

async function authorize(): Promise<Auth | { error: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "로그인이 필요해요." };
  const { data: profile } = await supabase.from("profiles").select("organization_id, role").eq("id", user.id).maybeSingle();
  if (!profile?.organization_id) return { error: "소속된 조직이 없어요." };
  if (profile.role !== "ADMIN" && profile.role !== "MANAGER") return { error: "모아링크는 관리자 · 매니저만 바꿀 수 있어요." };
  return { userId: user.id, organizationId: profile.organization_id };
}

function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

/** 바뀐 내용을 공개 페이지 · 관리 화면에 바로 반영 */
function refreshViews(pageId?: string) {
  updateTag(MOA_CACHE_TAG);
  revalidatePath("/moa");
  if (pageId) revalidatePath(`/moa/${pageId}`);
}

async function ownPage(service: Service, auth: Auth, pageId: string) {
  const { data } = await service.from("moa_pages").select("*").eq("id", pageId).maybeSingle();
  if (!data || data.organization_id !== auth.organizationId) throw new Error("페이지를 찾을 수 없어요.");
  return data;
}

async function ownBlock(service: Service, auth: Auth, blockId: string) {
  const { data } = await service.from("moa_blocks").select("*").eq("id", blockId).maybeSingle();
  if (!data || data.organization_id !== auth.organizationId || data.deleted_at) throw new Error("블록을 찾을 수 없어요.");
  return data;
}

const uuid = z.string().uuid();
const httpUrl = z
  .string()
  .trim()
  .max(1000)
  .refine((v) => /^https?:\/\/[^\s]+$/i.test(v), "주소는 http:// 또는 https://로 시작해야 해요.");

// ---------------------------------------------------------------------
// 페이지
// ---------------------------------------------------------------------

async function slugTaken(service: Service, slug: string, exceptPageId?: string): Promise<boolean> {
  const { data: page } = await service.from("moa_pages").select("id").eq("slug", slug).maybeSingle();
  if (page && page.id !== exceptPageId) return true;
  const { data: moved } = await service.from("moa_slug_redirects").select("page_id").eq("old_slug", slug).maybeSingle();
  return !!moved && moved.page_id !== exceptPageId;
}

async function freeSlug(service: Service, base: string): Promise<string> {
  let root = normalizeSlug(base);
  if (slugProblem(root)) root = `page-${crypto.randomUUID().slice(0, 6)}`;
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? root : `${root.slice(0, 36)}-${i + 1}`;
    if (!slugProblem(candidate) && !(await slugTaken(service, candidate))) return candidate;
  }
  return `page-${crypto.randomUUID().slice(0, 8)}`;
}

/** 인스타 프로필 사진 주소는 시간이 지나면 막힌다 — 처음 만들 때 모아링크 저장소로 복사해 둔다 */
async function copyAvatar(service: Service, organizationId: string, src: string | null): Promise<string | null> {
  if (!src) return null;
  try {
    const res = await fetch(src, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const type = res.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
    const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
    const path = `${organizationId}/${crypto.randomUUID()}.${ext}`;
    const { error } = await service.storage
      .from("moa")
      .upload(path, Buffer.from(await res.arrayBuffer()), { contentType: ext === "jpg" ? "image/jpeg" : type });
    if (error) return null;
    return service.storage.from("moa").getPublicUrl(path).data.publicUrl;
  } catch {
    return null;
  }
}

export async function createPage(input: { socialAccountId: string }): Promise<ActionResult<{ pageId: string }>> {
  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };
  const parsed = z.object({ socialAccountId: uuid }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "계정을 다시 골라 주세요." };
  try {
    const service = createServiceClient();
    const { data: account } = await service
      .from("social_accounts")
      .select("id, organization_id, platform, display_name, avatar_url")
      .eq("id", parsed.data.socialAccountId)
      .maybeSingle();
    if (!account || account.organization_id !== auth.organizationId) return { ok: false, error: "계정을 찾을 수 없어요." };
    const { data: existing } = await service.from("moa_pages").select("id").eq("social_account_id", account.id).maybeSingle();
    if (existing) return { ok: true, pageId: existing.id };

    const name = account.display_name ?? "";
    const slug = await freeSlug(service, name);
    const avatar = await copyAvatar(service, auth.organizationId, account.avatar_url);
    const { data: page, error } = await service
      .from("moa_pages")
      .insert({
        organization_id: auth.organizationId,
        social_account_id: account.id,
        slug,
        title: name,
        avatar_url: avatar,
        theme: DEFAULT_THEME as unknown as Json,
        created_by: auth.userId,
      })
      .select("id")
      .single();
    if (error || !page) return { ok: false, error: `페이지를 만들지 못했어요: ${error?.message ?? ""}` };

    // 기본 구성: 최근 소개한 상품 구역 + (인스타 계정이면) 인스타 버튼
    const blocks: BlockInsert[] = [
      { page_id: page.id, organization_id: auth.organizationId, kind: "AUTO_SECTION", position: 10, title: "최근 소개한 상품", data: { layout: "list" } },
    ];
    if (account.platform === "INSTAGRAM" && name) {
      blocks.push({
        page_id: page.id,
        organization_id: auth.organizationId,
        kind: "SOCIAL",
        position: 20,
        data: { items: [{ type: "instagram", url: `https://www.instagram.com/${name}/` }] },
      });
    }
    const { error: blockError } = await service.from("moa_blocks").insert(blocks, { defaultToNull: false });
    if (blockError) console.error("[moa] 기본 블록 실패:", blockError.message);

    refreshViews(page.id);
    return { ok: true, pageId: page.id };
  } catch (err) {
    return fail(err);
  }
}

const pageSettingsSchema = z.object({
  pageId: uuid,
  slug: z.string().trim().max(60),
  title: z.string().trim().max(60),
  bio: z.string().trim().max(300),
  hideSoldOut: z.boolean(),
  autoLimit: z.number().int().min(1).max(100),
});

export async function updatePageSettings(input: z.input<typeof pageSettingsSchema>): Promise<ActionResult<{ slug: string }>> {
  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };
  const parsed = pageSettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "입력을 확인해 주세요." };
  try {
    const service = createServiceClient();
    const page = await ownPage(service, auth, parsed.data.pageId);
    const slug = normalizeSlug(parsed.data.slug);
    if (slug !== page.slug) {
      const problem = slugProblem(slug);
      if (problem) return { ok: false, error: problem };
      if (await slugTaken(service, slug, page.id)) return { ok: false, error: "이미 쓰고 있는 주소예요." };
    }
    const { error } = await service
      .from("moa_pages")
      .update({
        slug,
        title: parsed.data.title,
        bio: parsed.data.bio,
        hide_sold_out: parsed.data.hideSoldOut,
        auto_limit: parsed.data.autoLimit,
      })
      .eq("id", page.id);
    if (error) return { ok: false, error: `저장하지 못했어요: ${error.message}` };
    if (slug !== page.slug) {
      // 옛 주소 → 이 페이지. 새 주소가 예전 이 페이지의 옛 주소였다면 그 연결은 지운다.
      await service.from("moa_slug_redirects").delete().eq("old_slug", slug);
      await service.from("moa_slug_redirects").upsert({ old_slug: page.slug, page_id: page.id }, { onConflict: "old_slug" });
    }
    refreshViews(page.id);
    return { ok: true, slug };
  } catch (err) {
    return fail(err);
  }
}

export async function updateTheme(input: { pageId: string; theme: unknown }): Promise<ActionResult> {
  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };
  const theme = themeSchema.safeParse(input.theme);
  if (!uuid.safeParse(input.pageId).success || !theme.success) return { ok: false, error: "디자인 값을 확인해 주세요." };
  try {
    const service = createServiceClient();
    const page = await ownPage(service, auth, input.pageId);
    const { error } = await service.from("moa_pages").update({ theme: theme.data as unknown as Json }).eq("id", page.id);
    if (error) return { ok: false, error: `저장하지 못했어요: ${error.message}` };
    refreshViews(page.id);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/** 프로필 사진 — 화면이 moa 저장소에 올린 뒤 주소를 넘긴다(null이면 지움) */
export async function updateAvatar(input: { pageId: string; url: string | null }): Promise<ActionResult> {
  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };
  if (input.url !== null && !isOwnStorageUrl(input.url, auth.organizationId)) return { ok: false, error: "사진 주소가 올바르지 않아요." };
  try {
    const service = createServiceClient();
    const page = await ownPage(service, auth, input.pageId);
    const { error } = await service.from("moa_pages").update({ avatar_url: input.url }).eq("id", page.id);
    if (error) return { ok: false, error: `저장하지 못했어요: ${error.message}` };
    refreshViews(page.id);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

function isOwnStorageUrl(url: string, organizationId: string): boolean {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  return !!base && url.startsWith(`${base}/storage/v1/object/public/moa/${organizationId}/`);
}

export async function setPageStatus(input: { pageId: string; status: "PUBLISHED" | "PAUSED" | "DRAFT" }): Promise<ActionResult> {
  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };
  if (!["PUBLISHED", "PAUSED", "DRAFT"].includes(input.status)) return { ok: false, error: "상태 값이 올바르지 않아요." };
  try {
    const service = createServiceClient();
    const page = await ownPage(service, auth, input.pageId);
    const { error } = await service
      .from("moa_pages")
      .update({
        status: input.status,
        ...(input.status === "PUBLISHED" && !page.published_at ? { published_at: new Date().toISOString() } : {}),
      })
      .eq("id", page.id);
    if (error) return { ok: false, error: `바꾸지 못했어요: ${error.message}` };
    refreshViews(page.id);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------------
// 블록
// ---------------------------------------------------------------------

const isoOrNull = z
  .string()
  .nullable()
  .refine((v) => v === null || !Number.isNaN(Date.parse(v)), "날짜를 확인해 주세요.");

const blockFieldsSchema = z.object({
  title: z.string().trim().max(80).default(""),
  subtitle: z.string().trim().max(300).default(""),
  url: z.union([httpUrl, z.literal(""), z.null()]).default(null),
  imageUrl: z.union([httpUrl, z.literal(""), z.null()]).default(null),
  shop: z.enum(SHOP_CODES as [ShopCode, ...ShopCode[]]).nullable().default(null),
  productId: z.number().int().positive().nullable().default(null),
  startsAt: isoOrNull.default(null),
  endsAt: isoOrNull.default(null),
  enabled: z.boolean().default(true),
  inAutoSection: z.boolean().default(false),
  pinned: z.boolean().default(false),
  data: blockDataSchema.default({}),
});
export type BlockFieldsInput = z.input<typeof blockFieldsSchema>;

/** 종류별 필수 값 확인 → DB 값 */
function blockColumns(kind: MoaBlockKind, f: z.output<typeof blockFieldsSchema>): { error: string } | Partial<BlockInsert> {
  const url = f.url || null;
  const imageUrl = f.imageUrl || null;
  if (f.startsAt && f.endsAt && Date.parse(f.startsAt) >= Date.parse(f.endsAt)) return { error: "종료 시각은 시작 시각보다 뒤여야 해요." };
  const product = f.shop && f.productId ? { shop_code: f.shop, shop_product_id: f.productId } : { shop_code: null, shop_product_id: null };
  let data = f.data;
  switch (kind) {
    case "PRODUCT":
      if (!f.shop || !f.productId) return { error: "상품을 골라 주세요." };
      break;
    case "LINK":
      if (!url) return { error: "링크 주소를 넣어 주세요." };
      if (!f.title) return { error: "버튼에 보일 이름을 넣어 주세요." };
      break;
    case "BANNER":
      if (!imageUrl) return { error: "배너 이미지를 올려 주세요." };
      if (!url && !f.productId) return { error: "배너를 누르면 갈 주소나 상품을 넣어 주세요." };
      break;
    case "HEADING":
      if (!f.title && !f.subtitle) return { error: "제목이나 설명을 넣어 주세요." };
      break;
    case "SOCIAL": {
      const items = (f.data.items ?? []).filter((i) => i.url);
      if (items.length === 0) return { error: "버튼을 하나 이상 넣어 주세요." };
      for (const item of items) {
        const ok = socialItemSchema.safeParse(item).success && (item.type === "email" || item.type === "phone" || /^https?:\/\//i.test(item.url));
        if (!ok) return { error: "SNS 버튼 주소는 http:// 또는 https://로 시작해야 해요(이메일 · 전화 제외)." };
      }
      data = { ...f.data, items };
      break;
    }
    case "AUTO_SECTION":
      break;
  }
  return {
    title: f.title,
    subtitle: f.subtitle,
    url: kind === "PRODUCT" ? null : url,
    image_url: imageUrl,
    ...(kind === "PRODUCT" || kind === "BANNER" ? product : { shop_code: null, shop_product_id: null }),
    starts_at: f.startsAt,
    ends_at: f.endsAt,
    enabled: f.enabled,
    in_auto_section: kind === "PRODUCT" ? f.inAutoSection : false,
    pinned: kind === "PRODUCT" && f.inAutoSection ? f.pinned : false,
    data: data as Json,
  };
}

async function checkProductSoon(service: Service, shop: string | null | undefined, id: number | null | undefined) {
  if (!isShopCode(shop) || !id) return;
  await refreshProductStatuses(service, [{ shop, id }], Date.now() + 10_000).catch((err) => console.error("[moa] 상품 조회 실패:", err));
}

export async function addBlock(input: { pageId: string; kind: MoaBlockKind; fields: BlockFieldsInput }): Promise<ActionResult<{ blockId: string }>> {
  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };
  if (!uuid.safeParse(input.pageId).success || input.kind === "AUTO_SECTION") return { ok: false, error: "블록 종류를 확인해 주세요." };
  const fields = blockFieldsSchema.safeParse(input.fields);
  if (!fields.success) return { ok: false, error: fields.error.issues[0]?.message ?? "입력을 확인해 주세요." };
  const cols = blockColumns(input.kind, fields.data);
  if ("error" in cols) return { ok: false, error: cols.error as string };
  try {
    const service = createServiceClient();
    const page = await ownPage(service, auth, input.pageId);

    // 자동 구역의 같은 상품은 하나만 — 이미 있으면 맨 위로 올리고 켠다
    if (input.kind === "PRODUCT" && cols.in_auto_section) {
      const { data: dup } = await service
        .from("moa_blocks")
        .select("id")
        .eq("page_id", page.id)
        .eq("in_auto_section", true)
        .eq("shop_code", cols.shop_code!)
        .eq("shop_product_id", cols.shop_product_id!)
        .is("deleted_at", null)
        .maybeSingle();
      if (dup) {
        await service.from("moa_blocks").update({ surfaced_at: new Date().toISOString(), enabled: true }).eq("id", dup.id);
        refreshViews(page.id);
        return { ok: true, blockId: dup.id };
      }
    }

    const { data: last } = await service
      .from("moa_blocks")
      .select("position")
      .eq("page_id", page.id)
      .is("deleted_at", null)
      .order("position", { ascending: false })
      .limit(1)
      .maybeSingle();
    const { data: block, error } = await service
      .from("moa_blocks")
      .insert({
        page_id: page.id,
        organization_id: auth.organizationId,
        kind: input.kind,
        position: (last?.position ?? 0) + 10,
        ...cols,
      })
      .select("id")
      .single();
    if (error || !block) return { ok: false, error: `추가하지 못했어요: ${error?.message ?? ""}` };
    await checkProductSoon(service, cols.shop_code, cols.shop_product_id);
    refreshViews(page.id);
    return { ok: true, blockId: block.id };
  } catch (err) {
    return fail(err);
  }
}

export async function updateBlock(input: { blockId: string; fields: BlockFieldsInput }): Promise<ActionResult> {
  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };
  const fields = blockFieldsSchema.safeParse(input.fields);
  if (!uuid.safeParse(input.blockId).success || !fields.success) {
    return { ok: false, error: fields.success ? "블록을 다시 골라 주세요." : (fields.error.issues[0]?.message ?? "입력을 확인해 주세요.") };
  }
  try {
    const service = createServiceClient();
    const block = await ownBlock(service, auth, input.blockId);
    const cols = blockColumns(block.kind, fields.data);
    if ("error" in cols) return { ok: false, error: cols.error as string };
    // 자동 구역 상품은 구역을 옮기지 않는다(같은 상품 중복 방지 규칙 유지)
    if (block.kind === "PRODUCT" && block.in_auto_section !== cols.in_auto_section && cols.in_auto_section) {
      const { data: dup } = await service
        .from("moa_blocks")
        .select("id")
        .eq("page_id", block.page_id)
        .eq("in_auto_section", true)
        .eq("shop_code", cols.shop_code!)
        .eq("shop_product_id", cols.shop_product_id!)
        .is("deleted_at", null)
        .neq("id", block.id)
        .maybeSingle();
      if (dup) return { ok: false, error: "이 상품은 이미 최근 소개한 상품 구역에 있어요." };
    }
    const { error } = await service.from("moa_blocks").update(cols).eq("id", block.id);
    if (error) return { ok: false, error: `저장하지 못했어요: ${error.message}` };
    if (cols.shop_code !== block.shop_code || cols.shop_product_id !== block.shop_product_id) {
      await checkProductSoon(service, cols.shop_code, cols.shop_product_id);
    }
    refreshViews(block.page_id);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/** 켜기 · 끄기 · 고정 (관리자 값 — 판매 상태와 따로 저장) */
export async function toggleBlock(input: { blockId: string; enabled?: boolean; pinned?: boolean }): Promise<ActionResult> {
  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };
  try {
    const service = createServiceClient();
    const block = await ownBlock(service, auth, input.blockId);
    const patch: Partial<BlockInsert> = {};
    if (typeof input.enabled === "boolean") patch.enabled = input.enabled;
    if (typeof input.pinned === "boolean" && block.in_auto_section) patch.pinned = input.pinned;
    if (Object.keys(patch).length === 0) return { ok: true };
    const { error } = await service.from("moa_blocks").update(patch).eq("id", block.id);
    if (error) return { ok: false, error: `바꾸지 못했어요: ${error.message}` };
    refreshViews(block.page_id);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/** 지우기 — 지난 통계를 남기려고 표시만 한다 */
export async function deleteBlock(input: { blockId: string }): Promise<ActionResult> {
  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };
  try {
    const service = createServiceClient();
    const block = await ownBlock(service, auth, input.blockId);
    if (block.kind === "AUTO_SECTION") return { ok: false, error: "최근 소개한 상품 구역은 지울 수 없어요. 끄기로 숨겨 주세요." };
    const { error } = await service.from("moa_blocks").update({ deleted_at: new Date().toISOString() }).eq("id", block.id);
    if (error) return { ok: false, error: `지우지 못했어요: ${error.message}` };
    refreshViews(block.page_id);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/** 메인 목록 순서 저장 (자동 구역 안의 카드는 최근 소개 순이라 제외) */
export async function reorderBlocks(input: { pageId: string; blockIds: string[] }): Promise<ActionResult> {
  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };
  const parsed = z.object({ pageId: uuid, blockIds: z.array(uuid).max(200) }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "순서를 다시 정해 주세요." };
  try {
    const service = createServiceClient();
    const page = await ownPage(service, auth, parsed.data.pageId);
    const { data: blocks } = await service.from("moa_blocks").select("id").eq("page_id", page.id).is("deleted_at", null);
    const mine = new Set((blocks ?? []).map((b) => b.id));
    const ids = parsed.data.blockIds.filter((id) => mine.has(id));
    const results = await Promise.all(
      ids.map((id, i) => service.from("moa_blocks").update({ position: (i + 1) * 10 }).eq("id", id)),
    );
    const failed = results.find((r) => r.error);
    if (failed?.error) return { ok: false, error: `순서를 저장하지 못했어요: ${failed.error.message}` };
    refreshViews(page.id);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/** 판매 상태 지금 확인 (페이지의 상품 전부) */
export async function refreshPageProducts(input: { pageId: string }): Promise<ActionResult<{ checked: number; failed: number }>> {
  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };
  try {
    const service = createServiceClient();
    const page = await ownPage(service, auth, input.pageId);
    const { data: blocks } = await service
      .from("moa_blocks")
      .select("shop_code, shop_product_id")
      .eq("page_id", page.id)
      .is("deleted_at", null)
      .not("shop_code", "is", null);
    const refs: ProductRef[] = [];
    for (const b of blocks ?? []) if (isShopCode(b.shop_code) && b.shop_product_id != null) refs.push({ shop: b.shop_code, id: b.shop_product_id });
    const result = await refreshProductStatuses(service, refs, Date.now() + 40_000);
    refreshViews(page.id);
    return { ok: true, checked: result.checked, failed: result.failed };
  } catch (err) {
    return fail(err);
  }
}

/** 다른 페이지 디자인 복사 */
export async function copyTheme(input: { pageId: string; fromPageId: string }): Promise<ActionResult> {
  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };
  try {
    const service = createServiceClient();
    const page = await ownPage(service, auth, input.pageId);
    const from = await ownPage(service, auth, input.fromPageId);
    const { error } = await service.from("moa_pages").update({ theme: from.theme }).eq("id", page.id);
    if (error) return { ok: false, error: `복사하지 못했어요: ${error.message}` };
    refreshViews(page.id);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------------
// 상품 찾기 — 이름 검색(수집한 상품) 또는 몰 상품 주소(광고 전용 상품 포함)
// ---------------------------------------------------------------------

export interface ProductHit {
  shop: ShopCode;
  shopName: string;
  productId: number;
  name: string;
  price: number | null;
  image: string | null;
  /** 판매 중 · 품절 등 (관리 화면 표시용) */
  statusLabel: string;
  onSale: boolean;
}

const STOCK_LABEL: Record<string, string> = {
  available: "판매 중",
  temporarily_out: "일시 품절",
  discontinued: "판매 중지",
  unavailable: "목록 비노출",
};

export async function searchMoaProducts(input: { query: string }): Promise<ActionResult<{ hits: ProductHit[] }>> {
  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };
  const query = (input.query ?? "").trim().slice(0, 300);
  if (query.length < 1) return { ok: true, hits: [] };
  try {
    const byUrl = parseProductUrl(query);
    if (byUrl) {
      try {
        const p = await fetchLandingProduct(byUrl.shop, byUrl.productId);
        const onSale = p.landingStatus === "on_sale";
        return {
          ok: true,
          hits: [
            {
              shop: byUrl.shop,
              shopName: SHOPS[byUrl.shop].name,
              productId: byUrl.productId,
              name: p.name,
              price: p.price,
              image: p.representImageUrl,
              statusLabel: onSale ? (p.hiddenInList ? "판매 중 · 목록 비노출" : "판매 중") : landingLabel(p.landingStatus),
              onSale,
            },
          ],
        };
      } catch (err) {
        if (err instanceof ShopApiError && (err.status === 400 || err.status === 404)) return { ok: false, error: "몰에 없는 상품 주소예요." };
        throw err;
      }
    }
    if (/^https?:\/\//i.test(query)) return { ok: false, error: "오늘과일 · 쿠마마켓 · 리유코스메틱 상품 주소(…/product/번호)만 넣을 수 있어요." };

    const service = createServiceClient();
    const words = query.split(/\s+/).filter(Boolean).slice(0, 4);
    let q = service
      .from("products")
      .select("shop_code, shop_product_id, name, price, represent_image_url, stock_status")
      .neq("stock_status", "unavailable")
      .limit(30);
    for (const w of words) q = q.ilike("name", `%${w.replace(/[%_]/g, "")}%`);
    const { data, error } = await q.order("stock_status", { ascending: true }).order("name", { ascending: true });
    if (error) return { ok: false, error: `상품을 찾지 못했어요: ${error.message}` };
    return {
      ok: true,
      hits: (data ?? [])
        .filter((p) => isShopCode(p.shop_code))
        .map((p) => ({
          shop: p.shop_code as ShopCode,
          shopName: SHOPS[p.shop_code as ShopCode].name,
          productId: Number(p.shop_product_id),
          name: p.name,
          price: p.price,
          image: p.represent_image_url,
          statusLabel: STOCK_LABEL[p.stock_status] ?? p.stock_status,
          onSale: p.stock_status === "available",
        })),
    };
  } catch (err) {
    return fail(err);
  }
}

function landingLabel(s: string): string {
  return (
    { sold_out: "품절", suspended: "판매 중지", deleted: "삭제됨", not_open: "오픈 전", sale_ended: "판매 기간 끝", restricted: "등급 · 선물 전용", unknown: "확인 필요" } as Record<string, string>
  )[s] ?? s;
}
