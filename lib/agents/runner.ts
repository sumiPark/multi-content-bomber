import type OpenAI from "openai";
import { zodFunction, zodResponseFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { loadActivePlaybook, playbookBlock, resolveOrgId } from "@/lib/agents/playbook";
import { getOpenAI } from "@/lib/openai";
import { callOptions, isReasoningModel } from "@/lib/products/analysis/analyze";
import type { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/types/database";

// 에이전트 실행기 — 지시문 + 스킬(함수 호출) + 구조화된 최종 답.
// 에이전트는 스킬을 몇 번 불러 근거를 모은 뒤 정해진 형식(outputSchema)으로 답한다.
// 실행마다 agent_runs(0028)에 어떤 스킬을 어떤 입력으로 불렀는지 · 토큰 · 결과를 남긴다.
// 스킬은 코드라 피드백으로 바뀌지 않고, 바뀌는 건 지시문 끝에 붙는 플레이북(0032, 사람이 정한 추가 지침)뿐이다.
// 플레이북이 비어 있으면 지시문은 코드 그대로다. 쓴 플레이북 버전은 agent_runs.playbook_version에 남는다.

export type AgentName = "select" | "plan" | "edit" | "check" | "upload" | "analyze";
type Service = ReturnType<typeof createServiceClient>;

export interface AgentSkill<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  input: S;
  run: (args: z.infer<S>) => Promise<unknown>;
}

export interface SkillCall {
  skill: string;
  args: unknown;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface AgentResult<T> {
  output: T;
  skillCalls: SkillCall[];
  tokens: { input: number; output: number };
  model: string;
  runId: string | null;
}

export function agentModel(): string {
  return process.env.AGENT_MODEL || "gpt-6.1-terra";
}

const MAX_RESULT_CHARS = 12_000;

export async function runAgent<T>(opts: {
  agent: AgentName;
  system: string;
  user: string;
  // 처음 메시지에 함께 보낼 그림(data URL) — 편집 에이전트의 프레임 묶음
  userImages?: string[];
  skills: AgentSkill[];
  outputSchema: z.ZodType<T>;
  outputName: string;
  maxSteps?: number;
  // null이면 기록하지 않음(--dry-run)
  service: Service | null;
  // 플레이북 읽기용 — 기록을 안 하는 dry-run에서도 플레이북은 읽는다
  readService?: Service;
  planId?: string | null;
  // 플레이북을 찾을 조직 — planId가 없을 때 계정으로
  accountId?: string;
  input?: Record<string, unknown>;
}): Promise<AgentResult<T>> {
  const model = agentModel();
  const maxSteps = opts.maxSteps ?? 8;
  const skillCalls: SkillCall[] = [];
  const tokens = { input: 0, output: 0 };

  const reader = opts.readService ?? opts.service;
  // 조직 — 플레이북을 고르고, 실행 기록을 같은 조직에만 보이게(0036) 남긴다
  const orgId = reader ? await resolveOrgId(reader, { planId: opts.planId, accountId: opts.accountId }) : null;
  const playbook = reader ? await loadActivePlaybook(reader, opts.agent, orgId) : null;

  let runId: string | null = null;
  if (opts.service) {
    const { data } = await opts.service
      .from("agent_runs")
      .insert({
        organization_id: orgId,
        agent: opts.agent,
        plan_id: opts.planId ?? null,
        model,
        playbook_version: playbook?.version ?? null,
        input: (opts.input ?? {}) as Json,
      })
      .select("id")
      .single();
    runId = data?.id ?? null;
  }

  const finish = async (patch: { status: "success" | "failed"; output?: unknown; error?: string }) => {
    if (!opts.service || !runId) return;
    await opts.service
      .from("agent_runs")
      .update({
        status: patch.status,
        output: (patch.output ?? null) as Json,
        error: patch.error ?? null,
        skill_calls: skillCalls as unknown as Json,
        tokens_input: tokens.input,
        tokens_output: tokens.output,
        finished_at: new Date().toISOString(),
      })
      .eq("id", runId);
  };

  const tools = opts.skills.map((s) =>
    zodFunction({ name: s.name, description: s.description, parameters: s.input }),
  );
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: opts.system + playbookBlock(playbook) },
    {
      role: "user",
      content: opts.userImages?.length
        ? [{ type: "text", text: opts.user }, ...opts.userImages.map((url) => ({ type: "image_url" as const, image_url: { url, detail: "high" as const } }))]
        : opts.user,
    },
  ];

  try {
    for (let step = 0; step < maxSteps; step++) {
      const completion = await getOpenAI().chat.completions.parse({
        model,
        ...callOptions(model, 6000),
        // chat completions에서는 추론 모델이 함수 호출(스킬)과 reasoning_effort를 같이 못 쓴다(400) —
        // 스킬을 쓰는 에이전트는 'none'으로 둔다. 판단 근거는 스킬 결과로 충분히 준다.
        ...(isReasoningModel(model) ? { reasoning_effort: "none" as const } : {}),
        messages,
        tools,
        response_format: zodResponseFormat(opts.outputSchema as z.ZodType, opts.outputName),
      });
      tokens.input += completion.usage?.prompt_tokens ?? 0;
      tokens.output += completion.usage?.completion_tokens ?? 0;
      const msg = completion.choices[0]?.message;
      if (!msg) throw new Error("에이전트 응답이 비어 있음");

      const calls = msg.tool_calls ?? [];
      if (calls.length === 0) {
        if (!msg.parsed) throw new Error("에이전트가 정해진 형식으로 답하지 않음");
        const output = msg.parsed as T;
        await finish({ status: "success", output });
        return { output, skillCalls, tokens, model, runId };
      }

      messages.push(msg as OpenAI.Chat.Completions.ChatCompletionMessageParam);
      // 스킬이 돌려준 그림 — tool 메시지에는 그림을 못 넣어 호출을 모두 답한 뒤 user 메시지로 붙인다
      const pendingImages: string[] = [];
      for (const call of calls) {
        if (call.type !== "function") continue;
        const skill = opts.skills.find((s) => s.name === call.function.name);
        const started = Date.now();
        let content: string;
        try {
          if (!skill) throw new Error(`없는 스킬: ${call.function.name}`);
          const args = skill.input.parse(JSON.parse(call.function.arguments || "{}"));
          const raw = await skill.run(args);
          let result = raw;
          if (raw && typeof raw === "object" && Array.isArray((raw as { __images?: unknown }).__images)) {
            const { __images, ...rest } = raw as { __images: string[] };
            pendingImages.push(...__images);
            result = rest;
          }
          content = JSON.stringify(result).slice(0, MAX_RESULT_CHARS);
          skillCalls.push({ skill: call.function.name, args, ok: true, ms: Date.now() - started });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          content = JSON.stringify({ error });
          skillCalls.push({ skill: call.function.name, args: call.function.arguments, ok: false, ms: Date.now() - started, error });
        }
        messages.push({ role: "tool", tool_call_id: call.id, content });
      }
      if (pendingImages.length) {
        messages.push({
          role: "user",
          content: [{ type: "text", text: "방금 요청한 프레임이다." }, ...pendingImages.map((url) => ({ type: "image_url" as const, image_url: { url, detail: "high" as const } }))],
        });
      }
    }
    throw new Error(`스킬 호출이 ${maxSteps}번을 넘음 — 답을 정하지 못함`);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await finish({ status: "failed", error });
    throw err;
  }
}
