import type { AgentName } from "@/lib/agents/runner";
import type { createServiceClient } from "@/lib/supabase/service";

// 플레이북(0032) — 에이전트 지시문에 덧붙는 "사람이 정한 추가 지침". 가장 큰 version이 지금 쓰는 것.
// 코드에 있는 기본 규칙(근거 · 금지 표현 · 형식)은 바뀌지 않고, 바뀌는 건 이 추가 지침뿐이다.
// 피드백 제안(agent_feedback)을 반영하면 새 버전이 생기고, 되돌리기도 새 버전(ROLLBACK)으로 남는다.

type Service = ReturnType<typeof createServiceClient>;

export type LearningAgent = "select" | "plan" | "edit";
export const LEARNING_AGENTS: LearningAgent[] = ["select", "plan", "edit"];

export interface AgentInfo {
  key: AgentName;
  no: number;
  name: string;
  kind: string;
  does: string;
  // learn: 플레이북 · 반영 방식이 있음 / locked: 사람만 수정 / none: 학습 없음 / sender: 제안을 보내는 쪽
  learning: "learn" | "locked" | "none" | "sender";
  // 지금 실제로 지시문에 플레이북을 붙이는지 (편집은 아직 코드 규칙만)
  usesPlaybook: boolean;
  note?: string;
}

export const AGENTS: AgentInfo[] = [
  { key: "select", no: 1, name: "상품 선정", kind: "AI", does: "칸마다 어떤 상품으로 만들지 고르고 이유를 남겨요", learning: "learn", usesPlaybook: true },
  {
    key: "plan",
    no: 2,
    name: "기획 · 글",
    kind: "AI",
    does: "촬영 기획안 후보 · 컷 리스트 · 대본 · 캡션을 써요",
    learning: "learn",
    usesPlaybook: true,
  },
  {
    key: "edit",
    no: 3,
    name: "편집",
    kind: "코드",
    does: "촬영본을 보고 후킹 · 표지 · 컷 · 음성 · 자막 · 그래픽 · 효과음을 정해요",
    learning: "learn",
    usesPlaybook: false,
    note: "지금은 정해진 코드 규칙으로만 편집해서 플레이북이 아직 쓰이지 않아요 (AI 영상 · 음악이 정해지면 씀)",
  },
  {
    key: "check",
    no: 4,
    name: "점검",
    kind: "규칙 + AI",
    does: "올려도 되는지 보고 통과 / 멈춤 + 이유만 내놓아요",
    learning: "locked",
    usesPlaybook: false,
    note: "점검 기준은 피드백으로 바뀌지 않아요. 금지 표현 · 심의 문구는 광고 문구 규칙에서 사람이 고쳐요",
  },
  { key: "upload", no: 5, name: "업로드", kind: "코드", does: "통과한 영상을 정해진 시각에 올려요", learning: "none", usesPlaybook: false, note: "판단할 게 없어 배우지 않아요 (시각은 편성표)" },
  {
    key: "analyze",
    no: 6,
    name: "성과 분석",
    kind: "수집 + AI",
    does: "성과를 모아 무엇이 잘 됐는지 찾고 플레이북 고치기를 제안해요",
    learning: "sender",
    usesPlaybook: false,
    note: "첫 리포트(운영 시작 뒤)부터 제안을 올려요",
  },
];

export const SOURCE_LABEL: Record<string, string> = {
  HUMAN: "사람이 고침",
  AUTO: "자동 반영",
  FEEDBACK: "제안 반영",
  ROLLBACK: "되돌림",
};

export interface ActivePlaybook {
  version: number;
  body: string;
}

/** 칸(planId)이나 계정(accountId)으로 조직을 찾는다 — 플레이북 · 실행 기록(0036 organization_id)에 쓴다. */
export async function resolveOrgId(service: Service, where: { planId?: string | null; accountId?: string | null }): Promise<string | null> {
  if (where.planId) {
    const { data } = await service.from("content_plans").select("organization_id").eq("id", where.planId).maybeSingle();
    return data?.organization_id ?? null;
  }
  if (where.accountId) {
    const { data } = await service.from("social_accounts").select("organization_id").eq("id", where.accountId).maybeSingle();
    return data?.organization_id ?? null;
  }
  return null;
}

/** 지금 쓰는 플레이북 — 조직별. 없으면 null(기본 규칙만). */
export async function loadActivePlaybook(service: Service, agent: AgentName, orgId: string | null): Promise<ActivePlaybook | null> {
  if (!LEARNING_AGENTS.includes(agent as LearningAgent)) return null;
  if (!orgId) return null;
  const { data } = await service
    .from("agent_playbooks")
    .select("version, body")
    .eq("organization_id", orgId)
    .eq("agent", agent)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data || !data.body.trim()) return data ? { version: data.version, body: "" } : null;
  return data;
}

/** 지시문 끝에 붙는 플레이북 묶음 — 비어 있으면 빈 문자열(지시문이 예전과 같다). */
export function playbookBlock(pb: ActivePlaybook | null): string {
  if (!pb?.body.trim()) return "";
  return `\n\n[플레이북 v${pb.version} — 사람이 정한 추가 지침. 위 규칙(근거 · 금지 표현 · 형식)과 부딪치면 위 규칙이 먼저다]\n${pb.body.trim()}`;
}

/** 새 버전 저장 — 지금 버전 + 1. 경쟁으로 같은 번호가 나면 한 번 다시 시도. */
export async function savePlaybookVersion(
  service: Service,
  row: { orgId: string; agent: LearningAgent; body: string; note: string | null; source: "HUMAN" | "AUTO" | "FEEDBACK" | "ROLLBACK"; feedbackId?: string | null; userId: string | null },
): Promise<{ ok: true; version: number } | { ok: false; error: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data: last } = await service
      .from("agent_playbooks")
      .select("version")
      .eq("organization_id", row.orgId)
      .eq("agent", row.agent)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    const version = (last?.version ?? 0) + 1;
    const { error } = await service.from("agent_playbooks").insert({
      organization_id: row.orgId,
      agent: row.agent,
      version,
      body: row.body,
      note: row.note,
      source: row.source,
      feedback_id: row.feedbackId ?? null,
      created_by: row.userId,
    });
    if (!error) return { ok: true, version };
    if (error.code !== "23505") return { ok: false, error: error.message };
  }
  return { ok: false, error: "다른 사람이 동시에 고쳤어요. 새로 고친 뒤 다시 해 주세요." };
}

/** 제안 반영(그대로 또는 고쳐서) — 새 버전을 만들고 제안을 APPLIED로. */
export async function applyFeedback(
  service: Service,
  args: { orgId: string; feedbackId: string; body?: string | null; userId: string | null; auto?: boolean },
): Promise<{ ok: true; version: number } | { ok: false; error: string }> {
  const { data: fb } = await service
    .from("agent_feedback")
    .select("id, agent, status, title, proposed_body")
    .eq("id", args.feedbackId)
    .eq("organization_id", args.orgId)
    .maybeSingle();
  if (!fb) return { ok: false, error: "제안을 찾지 못했어요." };
  if (fb.status !== "PENDING") return { ok: false, error: "이미 처리한 제안이에요." };
  const body = (args.body ?? fb.proposed_body).trim();
  const edited = args.body != null && args.body.trim() !== fb.proposed_body.trim();
  const saved = await savePlaybookVersion(service, {
    orgId: args.orgId,
    agent: fb.agent as LearningAgent,
    body,
    note: `${fb.title}${edited ? " (고쳐서 반영)" : ""}`.slice(0, 200),
    source: args.auto ? "AUTO" : "FEEDBACK",
    feedbackId: fb.id,
    userId: args.userId,
  });
  if (!saved.ok) return saved;
  await service
    .from("agent_feedback")
    .update({ status: "APPLIED", decided_by: args.userId, decided_at: new Date().toISOString(), applied_version: saved.version })
    .eq("id", fb.id);
  return saved;
}
