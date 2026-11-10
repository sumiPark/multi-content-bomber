import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AiUsage } from "@/lib/lemo/contract";
import { UsageLedger } from "@/lib/lemo/usage";

// Claude Code 세션 기록(jsonl)에서 모델별 토큰을 집계한다. lemo 제작에 든 Claude 사용량을 usage.ts 형식으로 남길 때 쓴다.
// - 같은 응답이 스트리밍 중 여러 줄로 기록되므로 message.id(+requestId)로 묶어 한 번만 센다. 줄마다 값이 다르면 칸별 최댓값(마지막 값)을 쓴다.
// - 사고 토큰은 output_tokens에 이미 들어 있어 따로 더하지 않는다(output_tokens_details.thinking_tokens는 참고로만 센다).
// - 하위 에이전트 기록(<세션>/subagents/agent-*.jsonl)도 기본으로 함께 센다(--no-subagents로 끔).
//
// 쓰는 법:
//   npx tsx scripts/claude-usage.ts --session <id> [--session <id> ...] [--file <jsonl> ...]
//        [--project <기록 폴더>] [--from 2026-11-10T00:00:00Z] [--to ...] [--no-subagents] [--out usage.json]
// 기록 폴더 기본값: ~/.claude/projects/<현재 폴더 이름을 바꾼 것>

interface Args {
  sessions: string[];
  files: string[];
  project: string;
  from: number | null;
  to: number | null;
  subagents: boolean;
  out: string | null;
}

function defaultProjectDir(): string {
  // Claude Code는 경로의 :, \, / , _ 를 -로 바꾼 폴더에 기록한다(예: d--project-program-multi-content-bomber)
  return join(homedir(), ".claude", "projects", process.cwd().replace(/[:\\/_.]/g, "-"));
}

function parseArgs(argv: string[]): Args {
  const a: Args = { sessions: [], files: [], project: defaultProjectDir(), from: null, to: null, subagents: true, out: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case "--session":
        a.sessions.push(v);
        i++;
        break;
      case "--file":
        a.files.push(v);
        i++;
        break;
      case "--project":
        a.project = v;
        i++;
        break;
      case "--from":
        a.from = Date.parse(v);
        i++;
        break;
      case "--to":
        a.to = Date.parse(v);
        i++;
        break;
      case "--no-subagents":
        a.subagents = false;
        break;
      case "--out":
        a.out = v;
        i++;
        break;
      default:
        throw new Error(`모르는 인자: ${argv[i]}`);
    }
  }
  if (a.from != null && Number.isNaN(a.from)) throw new Error("--from 시각을 읽지 못했어요");
  if (a.to != null && Number.isNaN(a.to)) throw new Error("--to 시각을 읽지 못했어요");
  if (!a.sessions.length && !a.files.length) throw new Error("--session 또는 --file을 하나 이상 주세요");
  return a;
}

/** 세션 id → 본 기록 + 하위 에이전트 기록 파일. */
function sessionFiles(project: string, id: string, subagents: boolean): string[] {
  const main = join(project, `${id}.jsonl`);
  if (!existsSync(main)) throw new Error(`세션 기록이 없어요: ${main}`);
  const out = [main];
  const sub = join(project, id, "subagents");
  if (subagents && existsSync(sub) && statSync(sub).isDirectory()) {
    for (const f of readdirSync(sub).sort()) if (f.endsWith(".jsonl")) out.push(join(sub, f));
  }
  return out;
}

interface RawUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

interface Entry {
  model: string;
  file: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
  thinking: number;
}

export interface ClaudeUsageReport {
  files: { file: string; lines: number; usage_lines: number; unique: number }[];
  range: { from: string | null; to: string | null };
  dedupe: { usage_lines: number; unique_responses: number };
  by_model: Record<string, { responses: number; input: number; cache_write: number; cache_write_1h: number; cache_read: number; output: number; thinking_in_output: number }>;
  // usage.ts 형식(AiUsage[])과 그 환산
  usage: AiUsage[];
  summary: ReturnType<UsageLedger["summarize"]>;
}

export function collectClaudeUsage(files: string[], range: { from: number | null; to: number | null }): ClaudeUsageReport {
  const seen = new Map<string, Entry>();
  const fileStats: ClaudeUsageReport["files"] = [];
  let usageLines = 0;
  for (const file of files) {
    let lines = 0;
    let withUsage = 0;
    const keys = new Set<string>();
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      lines++;
      let o: { type?: string; timestamp?: string; requestId?: string; message?: { id?: string; model?: string; usage?: RawUsage } };
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const m = o.message;
      if (o.type !== "assistant" || !m?.usage || !m.model || m.model === "<synthetic>") continue;
      const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
      if (range.from != null && !(ts >= range.from)) continue;
      if (range.to != null && !(ts <= range.to)) continue;
      withUsage++;
      const u = m.usage;
      const key = `${m.id ?? `line${lines}`}|${o.requestId ?? ""}`;
      keys.add(key);
      const next: Entry = {
        model: m.model,
        file,
        input: u.input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        thinking: u.output_tokens_details?.thinking_tokens ?? 0,
      };
      const prev = seen.get(key);
      // 스트리밍 중간 줄은 값이 작을 수 있어 칸마다 큰 값(최종)을 쓴다
      seen.set(
        key,
        prev
          ? { ...prev, input: Math.max(prev.input, next.input), cacheRead: Math.max(prev.cacheRead, next.cacheRead), cacheWrite: Math.max(prev.cacheWrite, next.cacheWrite), cacheWrite1h: Math.max(prev.cacheWrite1h, next.cacheWrite1h), output: Math.max(prev.output, next.output), thinking: Math.max(prev.thinking, next.thinking) }
          : next,
      );
    }
    usageLines += withUsage;
    fileStats.push({ file, lines, usage_lines: withUsage, unique: keys.size });
  }

  const byModel: ClaudeUsageReport["by_model"] = {};
  for (const e of seen.values()) {
    const t = (byModel[e.model] ??= { responses: 0, input: 0, cache_write: 0, cache_write_1h: 0, cache_read: 0, output: 0, thinking_in_output: 0 });
    t.responses++;
    t.input += e.input;
    t.cache_write += e.cacheWrite;
    t.cache_write_1h += e.cacheWrite1h;
    t.cache_read += e.cacheRead;
    t.output += e.output;
    t.thinking_in_output += e.thinking;
  }
  const usage: AiUsage[] = Object.entries(byModel).map(([model, t]) => ({
    stage: "claude-code",
    provider: "anthropic",
    model,
    calls: t.responses,
    input: t.input,
    cached_input: t.cache_read,
    cache_write: t.cache_write,
    output: t.output,
    units: { cache_write_1h: t.cache_write_1h },
  }));
  const ledger = new UsageLedger();
  ledger.add(usage);
  return {
    files: fileStats,
    range: { from: range.from != null ? new Date(range.from).toISOString() : null, to: range.to != null ? new Date(range.to).toISOString() : null },
    dedupe: { usage_lines: usageLines, unique_responses: seen.size },
    by_model: byModel,
    usage,
    summary: ledger.summarize(),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = [...args.sessions.flatMap((s) => sessionFiles(args.project, s, args.subagents)), ...args.files];
  const report = collectClaudeUsage(files, { from: args.from, to: args.to });
  const text = JSON.stringify(report, null, 2);
  if (args.out) {
    writeFileSync(args.out, text);
    console.log(`[claude-usage] ${basename(args.out)} 저장`);
  }
  console.log(`[claude-usage] 파일 ${files.length}개 · 사용량 줄 ${report.dedupe.usage_lines} → 응답 ${report.dedupe.unique_responses}개(중복 제거)`);
  for (const [model, t] of Object.entries(report.by_model)) {
    console.log(`  ${model}: 응답 ${t.responses} · 입력 ${t.input} · 캐시 쓰기 ${t.cache_write}(1시간 ${t.cache_write_1h}) · 캐시 읽기 ${t.cache_read} · 출력 ${t.output}(사고 포함, 사고 ${t.thinking_in_output})`);
  }
  const c = report.summary.cost.api_rate;
  console.log(`  API 단가 환산 $${c.usd.toFixed(4)}${c.complete ? "" : ` (단가 미상 항목 제외: ${c.unknown.join(", ")})`}`);
  if (!args.out) console.log(text);
}

if (process.argv[1] && basename(process.argv[1]).startsWith("claude-usage")) {
  try {
    main();
  } catch (e) {
    console.error("[claude-usage] 실패:", e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
