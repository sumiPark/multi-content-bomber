import Link from "next/link";
import { redirect } from "next/navigation";
import { ApprovalSwitch, FeedbackCard, PlaybookEditor, type FeedbackData, type PlaybookVersion } from "@/components/agents/agent-controls";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AGENTS, LEARNING_AGENTS, SOURCE_LABEL, type LearningAgent } from "@/lib/agents/playbook";
import { getCurrentProfile, getServerSupabase, getSessionUser } from "@/lib/auth";
import { cn } from "@/lib/utils";

// 에이전트 · 학습(5-3) — 에이전트마다 하는 일 · 반영 방식(사람 승인 / 자동 승인) · 플레이북(추가 지침) 버전 ·
// 성과 피드백 제안(반영 / 고쳐서 반영 / 거절). 실행 기록(agent_runs)은 계속 쌓이지만 화면에는 카드의 횟수만 보인다.

export const metadata = { title: "에이전트 · 학습 | MCB" };

const STAT_DAYS = 7;

// 렌더 함수 밖에서 현재 시각을 읽는다(react-hooks/purity)
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function nameOf(agent: string): string {
  const a = AGENTS.find((x) => x.key === agent);
  return a ? `${a.no} ${a.name}` : agent;
}

export default async function AgentsPage({ searchParams }: { searchParams: Promise<{ agent?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const profile = await getCurrentProfile();
  if (!profile?.organization_id) redirect("/onboarding");
  const canManage = profile.role === "ADMIN" || profile.role === "MANAGER";
  const supabase = await getServerSupabase();

  const sp = await searchParams;
  const selected: LearningAgent = LEARNING_AGENTS.includes(sp.agent as LearningAgent) ? (sp.agent as LearningAgent) : "select";
  const since = daysAgoIso(STAT_DAYS);

  const [{ data: settings }, { data: playbooks }, { data: feedback }, { data: statRows }] = await Promise.all([
    supabase.from("agent_settings").select("agent, approval_mode"),
    supabase.from("agent_playbooks").select("agent, version, body, note, source, created_at, profiles(full_name, email)").order("version", { ascending: false }),
    supabase.from("agent_feedback").select("id, agent, status, title, proposed_body, evidence, reject_reason, created_at, decided_at").order("created_at", { ascending: false }).limit(30),
    supabase.from("agent_runs").select("agent, status, tokens_input, tokens_output").gte("started_at", since).limit(5000),
  ]);

  const modeOf = new Map((settings ?? []).map((s) => [s.agent, s.approval_mode as "HUMAN" | "AUTO"]));
  const versionsOf = (agent: string): PlaybookVersion[] =>
    (playbooks ?? [])
      .filter((p) => p.agent === agent)
      .map((p) => ({
        version: p.version,
        body: p.body,
        note: p.note,
        sourceLabel: SOURCE_LABEL[p.source] ?? p.source,
        who: p.profiles?.full_name ?? p.profiles?.email?.split("@")[0] ?? null,
        createdAt: p.created_at,
      }));
  const stats = new Map<string, { runs: number; failed: number; tokens: number }>();
  for (const r of statRows ?? []) {
    const s = stats.get(r.agent) ?? { runs: 0, failed: 0, tokens: 0 };
    s.runs += 1;
    if (r.status === "failed") s.failed += 1;
    s.tokens += (r.tokens_input ?? 0) + (r.tokens_output ?? 0);
    stats.set(r.agent, s);
  }

  const pending = (feedback ?? []).filter((f) => f.status === "PENDING");
  const decided = (feedback ?? []).filter((f) => f.status !== "PENDING").slice(0, 10);
  const selectedInfo = AGENTS.find((a) => a.key === selected)!;
  const selectedVersions = versionsOf(selected);

  return (
    <main className="space-y-6 p-4 sm:p-6">
      <header>
        <h1 className="text-xl font-bold tracking-[-0.01em]">에이전트 · 학습</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          콘텐츠를 만드는 AI 에이전트 6개가 어떻게 일하는지 보고, 성과 피드백을 어떻게 반영할지 정해요. 처음엔 모두 <b>사람 승인</b>으로 시작해요.
        </p>
      </header>

      {/* 에이전트 카드 */}
      <section aria-label="에이전트" className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {AGENTS.map((a) => {
          const s = stats.get(a.key);
          const v = versionsOf(a.key)[0];
          return (
            <Card key={a.key} className={cn(a.key === selected && "border-primary/50")}>
              <CardContent className="flex h-full flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="flex items-center gap-2 text-[15px] font-semibold">
                      <span className="grid size-6 place-items-center rounded-md bg-surface-2 text-xs tabular-nums">{a.no}</span>
                      {a.name}
                      <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted-foreground">{a.kind}</span>
                    </p>
                    <p className="mt-1.5 text-[13px] text-ink-2">{a.does}</p>
                  </div>
                  {a.learning === "learn" && (
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{v ? `플레이북 v${v.version}` : "기본 규칙만"}</span>
                  )}
                </div>
                <div className="mt-auto space-y-2">
                  {a.learning === "learn" ? (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <ApprovalSwitch agent={a.key} mode={modeOf.get(a.key) ?? "HUMAN"} canManage={canManage} />
                      <Link href={`/agents?agent=${a.key}#playbook`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                        플레이북 보기
                      </Link>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      <b className="text-ink-2">{a.learning === "locked" ? "잠김 · 사람만 수정" : a.learning === "none" ? "학습 없음" : "피드백 보내는 쪽"}</b>
                      {a.note && ` — ${a.note}`}
                    </p>
                  )}
                  {a.learning === "learn" && a.note && <p className="text-xs text-muted-foreground">{a.note}</p>}
                  {a.key === "check" && (
                    <Link href="/rules" className="text-xs text-primary underline-offset-2 hover:underline">
                      광고 문구 규칙으로 →
                    </Link>
                  )}
                  <p className="border-t pt-2 text-xs tabular-nums text-muted-foreground">
                    최근 {STAT_DAYS}일 실행 {s?.runs ?? 0}번{s?.failed ? <span className="text-risk"> · 실패 {s.failed}</span> : ""}
                    {s?.tokens ? ` · 토큰 ${s.tokens.toLocaleString("ko-KR")}` : ""}
                  </p>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </section>

      {/* 승인 대기 제안 */}
      <Card>
        <CardHeader>
          <CardTitle>승인 대기 제안 {pending.length > 0 && <span className="text-primary tabular-nums">{pending.length}</span>}</CardTitle>
          <CardDescription className="mt-1">
            성과 분석 에이전트가 “이렇게 바꾸면 반응이 더 좋다”는 제안을 근거(표본 수 · 비교 기준)와 함께 올려요. 반영하면 플레이북 새 버전이 생기고, 거절한 이유는 다음
            제안에 반영돼요.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {pending.length === 0 ? (
            <p className="rounded-md border border-dashed px-4 py-6 text-center text-[13px] text-muted-foreground">
              승인을 기다리는 제안이 없어요. 운영을 시작하고 첫 리포트가 나오면 여기에 올라와요.
            </p>
          ) : (
            pending.map((f) => {
              const data: FeedbackData = {
                id: f.id,
                agentName: nameOf(f.agent),
                title: f.title,
                proposedBody: f.proposed_body,
                currentBody: versionsOf(f.agent)[0]?.body ?? "",
                evidence: (f.evidence ?? {}) as FeedbackData["evidence"],
                createdAt: f.created_at,
              };
              return <FeedbackCard key={f.id} fb={data} canManage={canManage} />;
            })
          )}
          {decided.length > 0 && (
            <details className="text-[13px]">
              <summary className="cursor-pointer text-muted-foreground">처리한 제안 {decided.length}개</summary>
              <ul className="mt-2 divide-y rounded-md border">
                {decided.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-center gap-2 px-3.5 py-2.5">
                    <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", f.status === "APPLIED" ? "bg-ok-soft text-ok" : "bg-surface-2 text-muted-foreground")}>
                      {f.status === "APPLIED" ? "반영" : "거절"}
                    </span>
                    <span className="text-muted-foreground">{nameOf(f.agent)}</span>
                    <span>{f.title}</span>
                    {f.reject_reason && <span className="text-muted-foreground">— {f.reject_reason}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </CardContent>
      </Card>

      {/* 플레이북 */}
      <Card id="playbook" className="scroll-mt-20">
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>플레이북 · 추가 지침</CardTitle>
            <CardDescription className="mt-1">
              코드에 있는 기본 규칙 위에 덧붙는 지침이에요. 고치면 새 버전으로 남고, 언제든 예전 버전으로 되돌릴 수 있어요. 기본 규칙(근거 · 금지 표현 · 형식)과 부딪치면
              기본 규칙이 먼저예요.
            </CardDescription>
          </div>
          <nav className="inline-flex rounded-md border bg-surface-2 p-0.5" aria-label="에이전트 고르기">
            {LEARNING_AGENTS.map((k) => (
              <Link
                key={k}
                href={`/agents?agent=${k}#playbook`}
                aria-current={k === selected ? "page" : undefined}
                className={cn(
                  "h-8 rounded-[6px] px-3 text-[13px] leading-8",
                  k === selected ? "bg-card font-semibold shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {nameOf(k)}
              </Link>
            ))}
          </nav>
        </CardHeader>
        <CardContent className="space-y-3">
          {!selectedInfo.usesPlaybook && selectedInfo.note && (
            <p className="rounded-md bg-warn-soft px-3.5 py-2.5 text-[13px] text-warn">{selectedInfo.note}</p>
          )}
          <PlaybookEditor
            key={`${selected}-${selectedVersions[0]?.version ?? 0}`}
            agent={selected}
            current={selectedVersions[0] ?? null}
            history={selectedVersions}
            canManage={canManage}
            usesPlaybook={selectedInfo.usesPlaybook}
          />
        </CardContent>
      </Card>
    </main>
  );
}
