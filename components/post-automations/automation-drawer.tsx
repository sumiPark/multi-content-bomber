"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  CircleCheck,
  CircleHelp,
  CircleMinus,
  CircleX,
  ExternalLink,
  LoaderCircle,
  Pause,
  Pencil,
  Play,
  Send,
  Trash2,
  XIcon,
} from "lucide-react";
import {
  deleteAutomation,
  listAutomationEvents,
  resolveUnknownEvent,
  type EventView,
} from "@/app/(dashboard)/post-automations/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PlatformIcon } from "@/components/ui/platform-icon";
import { RelativeTime } from "@/components/ui/relative-time";
import { Segmented } from "@/components/ui/segmented";
import { toast } from "@/components/ui/toast";
import { renderText, withUtm, type AutomationConfig } from "@/lib/post-automations/config";
import { cn } from "@/lib/utils";
import { DAY_MS, FORMAT_LABEL, MonthDay, StatusBadge, Thumb, captionTitle, replyText, triggerText } from "./shared";
import type { AutomationView, ProductView } from "./types";

export type EventFilter = "all" | "check" | "fail" | "skip";

// 반응하지 않은 이유 — 쉬운 말로
const SKIP_REASON: Record<string, string> = {
  OWN: "우리 계정 댓글이라 제외했어요.",
  EXCLUDED: "제외 단어가 들어 있어 제외했어요.",
  ALREADY_SENT: "이 게시물에서 이미 DM을 받은 사람이라 제외했어요.",
  EXPIRED: "댓글이 달리고 7일이 지나 DM을 보낼 수 없었어요.",
  PAUSED: "자동화가 꺼진 동안 기간이 끝나 보내지 않았어요.",
  NO_MATCH: "키워드가 없는 댓글이라 제외했어요.",
  EMOJI_ONLY: "이모지만 있는 댓글이라 제외했어요.",
  REPLY_OF_REPLY: "답글(대댓글)이라 제외했어요.",
};

const isCheck = (e: EventView) => e.dmStatus === "UNKNOWN";
const isFail = (e: EventView) => e.dmStatus === "FAILED" || e.replyStatus === "FAILED" || e.step2Status === "FAILED";
const isSkip = (e: EventView) => !!e.skipReason || e.dmStatus === "SKIPPED";
const FILTERS: Record<EventFilter, (e: EventView) => boolean> = { all: () => true, check: isCheck, fail: isFail, skip: isSkip };

export function AutomationDrawer({
  automation: a,
  accountName,
  product,
  initialFilter,
  canManage,
  togglePending,
  onClose,
  onEdit,
  onToggle,
  onDeleted,
}: {
  automation: AutomationView;
  accountName: string | null;
  product: ProductView | null;
  initialFilter: EventFilter;
  canManage: boolean;
  togglePending: boolean;
  onClose: () => void;
  onEdit: () => void;
  onToggle: (on: boolean) => void;
  onDeleted: () => void;
}) {
  const router = useRouter();
  const c = a.config;
  const [filter, setFilter] = useState<EventFilter>(initialFilter);
  const [events, setEvents] = useState<EventView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [resendTarget, setResendTarget] = useState<EventView | null>(null);
  const [busyEvent, setBusyEvent] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // 활동 기록 — 열 때 · 처리한 뒤 다시 읽는다
  useEffect(() => {
    let cancelled = false;
    listAutomationEvents(a.id).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setEvents(r.events);
        setLoadError(null);
      } else setLoadError(r.error);
    });
    return () => {
      cancelled = true;
    };
  }, [a.id, reload]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 확인 창이 떠 있으면 그 창이 Esc를 받는다
      if (e.key === "Escape" && !confirmDelete && !resendTarget) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, confirmDelete, resendTarget]);

  const ctx = {
    productName: product?.name ?? null,
    productUrl: product ? withUtm(product.url, "INSTAGRAM", "dm") : null,
    username: null,
  };
  const R = (t: string) => renderText(c, t, ctx);
  const start = a.startsAt ? new Date(a.startsAt) : null;
  const end = a.endsAt ? new Date(a.endsAt) : start ? new Date(start.getTime() + c.period.days * DAY_MS) : null;

  function resolve(e: EventView, how: "MARKED_SENT" | "RESENT") {
    setBusyEvent(e.id);
    startTransition(async () => {
      const r = await resolveUnknownEvent(e.id, how);
      setBusyEvent(null);
      setResendTarget(null);
      if (!r.ok) {
        toast(r.error, "risk");
        return;
      }
      if (how === "MARKED_SENT") toast("보낸 것으로 처리했어요.");
      else if (r.result === "보냄") toast("다시 보냈어요.");
      else toast(`다시 보내지 못했어요: ${r.result}`, "risk");
      setReload((n) => n + 1);
      router.refresh();
    });
  }

  function remove() {
    startTransition(async () => {
      const r = await deleteAutomation(a.id);
      setConfirmDelete(false);
      if (!r.ok) {
        toast(r.error, "risk");
        return;
      }
      toast("지웠어요. 보낸 기록은 남아 있어요.");
      onDeleted();
    });
  }

  const list = events ?? [];
  const shown = list.filter(FILTERS[filter]);
  const count = (k: EventFilter) => list.filter(FILTERS[k]).length;
  const triggerOn = c.dm.on || c.reply.on;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/25" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="게시물 자동화 자세히"
        className="fixed inset-y-0 right-0 z-50 flex w-[540px] max-w-full flex-col rounded-l-xl bg-card shadow-[0_8px_24px_rgb(16_24_40/.12),0_2px_6px_rgb(16_24_40/.08)]"
      >
        <div className="flex items-start gap-3 border-b px-5 py-4">
          <Thumb src={product?.image} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <PlatformIcon platform="INSTAGRAM" size={16} />
              <span className="truncate">
                @{(accountName ?? "").replace(/^@/, "")}
                {a.postedAt && (
                  <>
                    {" "}
                    · <MonthDay iso={a.postedAt} /> 게시
                  </>
                )}
              </span>
            </div>
            <div className="mt-0.5 line-clamp-2 text-base font-semibold">{captionTitle(a.caption)}</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <StatusBadge a={a} />
              <span className="text-xs text-muted-foreground tabular-nums">
                {start && end ? (
                  <>
                    <MonthDay iso={start} /> ~ <MonthDay iso={end} />
                  </>
                ) : (
                  `발행되면 ${c.period.days}일 동안`
                )}
              </span>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="닫기" autoFocus>
            <XIcon />
          </Button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            {canManage && (
              <Button variant="outline" size="sm" onClick={onEdit}>
                <Pencil />
                설정 수정
              </Button>
            )}
            {canManage && (a.status === "ACTIVE" || a.status === "PAUSED") && (
              <Button variant="outline" size="sm" disabled={togglePending} onClick={() => onToggle(a.status !== "ACTIVE")}>
                {a.status === "ACTIVE" ? (
                  <>
                    <Pause />
                    끄기
                  </>
                ) : (
                  <>
                    <Play />
                    다시 켜기
                  </>
                )}
              </Button>
            )}
            {a.permalink && (
              <a
                href={a.permalink}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 items-center gap-1 rounded-md px-3 text-xs font-medium hover:bg-muted [&_svg]:size-3.5"
              >
                <ExternalLink />
                게시물 보기
              </a>
            )}
            {canManage && (
              <Button variant="destructive" size="sm" className="ml-auto" onClick={() => setConfirmDelete(true)}>
                <Trash2 />
                지우기
              </Button>
            )}
          </div>

          <div className="rounded-lg border px-4 py-3.5">
            <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
              <dt className="text-muted-foreground">상품</dt>
              <dd className="flex flex-wrap items-center gap-1.5">
                {product ? (
                  <>
                    {product.name}
                    <Badge variant={product.soldOut ? "destructive" : "ok"}>{product.soldOut ? "품절" : "판매 중"}</Badge>
                  </>
                ) : (
                  <span className="text-muted-foreground">연결 안 함</span>
                )}
              </dd>

              <dt className="text-muted-foreground">첫 댓글</dt>
              <dd>
                {c.first.on ? (
                  <>
                    <p className="whitespace-pre-line">{R(c.first.text)}</p>
                    <FirstStatus a={a} />
                  </>
                ) : (
                  <span className="text-muted-foreground">꺼짐</span>
                )}
              </dd>

              <dt className="text-muted-foreground">반응할 댓글</dt>
              <dd className={cn(!triggerOn && "text-muted-foreground")}>{triggerText(c)}</dd>

              <dt className="text-muted-foreground">DM</dt>
              <dd>{c.dm.on ? <DmSummary c={c} R={R} soldOut={!!product?.soldOut} /> : <span className="text-muted-foreground">꺼짐</span>}</dd>

              <dt className="text-muted-foreground">답글</dt>
              <dd className={cn(!c.reply.on && "text-muted-foreground")}>{replyText(c)}</dd>

              {c.dm.on && c.dm.format !== "text" && (
                <>
                  <dt className="text-muted-foreground">버튼 클릭</dt>
                  <dd className="tabular-nums">
                    {a.stats.clicks.toLocaleString("ko-KR")}회 <span className="text-xs text-muted-foreground">· MCB 주소로 집계</span>
                  </dd>
                </>
              )}
            </dl>
          </div>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-base font-semibold">활동 기록</h3>
              <span className="text-xs text-muted-foreground">최근 순</span>
            </div>
            {!triggerOn ? (
              <p className="text-xs text-muted-foreground">답글 · DM이 꺼져 있어 댓글 기록이 없어요.</p>
            ) : loadError ? (
              <p className="text-xs text-risk">기록을 불러오지 못했어요: {loadError}</p>
            ) : events === null ? (
              <p className="flex items-center gap-1.5 py-4 text-xs text-muted-foreground">
                <LoaderCircle className="size-3.5 animate-spin" />
                기록을 불러오고 있어요
              </p>
            ) : (
              <>
                <Segmented
                  ariaLabel="기록 거르기"
                  value={filter}
                  onChange={setFilter}
                  className="mb-1"
                  options={[
                    { value: "all", label: `전체 ${count("all")}` },
                    { value: "check", label: `확인 필요 ${count("check")}` },
                    { value: "fail", label: `실패 ${count("fail")}` },
                    { value: "skip", label: `건너뜀 ${count("skip")}` },
                  ]}
                />
                {shown.length === 0 ? (
                  <p className="py-4 text-xs text-muted-foreground">{list.length === 0 ? "아직 반응한 댓글이 없어요." : "이 조건의 기록이 없어요."}</p>
                ) : (
                  <ul>
                    {shown.map((e) => (
                      <EventRow
                        key={e.id}
                        e={e}
                        canManage={canManage}
                        busy={isPending && busyEvent === e.id}
                        onMarkSent={() => resolve(e, "MARKED_SENT")}
                        onResend={() => setResendTarget(e)}
                      />
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>
        </div>
      </aside>

      <ConfirmDialog
        open={confirmDelete}
        title="이 게시물의 자동화를 지울까요?"
        confirmLabel="지우기"
        danger
        pending={isPending}
        onConfirm={remove}
        onClose={() => setConfirmDelete(false)}
      >
        <p>지우면 이 게시물의 댓글에 더 이상 반응하지 않고, 보낼 차례였던 DM · 답글도 보내지 않아요.</p>
        <p>보낸 기록은 남아요. 같은 게시물에 다시 켜려면 게시물에 켜기에서 새로 설정해요.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={!!resendTarget}
        title="DM을 다시 보낼까요?"
        confirmLabel="다시 보내기"
        danger
        pending={isPending}
        onConfirm={() => resendTarget && resolve(resendTarget, "RESENT")}
        onClose={() => setResendTarget(null)}
      >
        <p>
          처음 보낸 DM이 실제로 갔다면 <b>@{resendTarget?.username ?? "고객"}</b>님이 같은 DM을 두 번 받을 수 있어요.
        </p>
        <p>인스타 메시지함에서 먼저 확인하고, 보이지 않을 때만 다시 보내 주세요.</p>
      </ConfirmDialog>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function FirstStatus({ a }: { a: AutomationView }) {
  if (a.firstStatus === "SENT") {
    return (
      <p className="text-xs text-muted-foreground">
        {a.firstAt ? (
          <>
            <RelativeTime iso={a.firstAt} /> 등록
          </>
        ) : (
          "등록함"
        )}
      </p>
    );
  }
  if (a.firstStatus === "FAILED") return <p className="text-xs text-risk">등록하지 못했어요{a.firstError ? `: ${a.firstError}` : ""}</p>;
  if (a.firstStatus === "PENDING") return <p className="text-xs text-muted-foreground">등록 대기</p>;
  return <p className="text-xs text-muted-foreground">{a.status === "WAITING" ? "발행되면 등록" : "등록하지 않음"}</p>;
}

function DmSummary({ c, R, soldOut }: { c: AutomationConfig; R: (t: string) => string; soldOut: boolean }) {
  const f = c.dm.format;
  const buttons = c.dm.buttons.map((b) => `[${b.label}]`).join(" ");
  return (
    <div className="space-y-1">
      <Badge variant="default">{FORMAT_LABEL[f]}</Badge>
      {f === "text" && <p className="whitespace-pre-line">{R(c.dm.text)}</p>}
      {f === "button" && (
        <p className="whitespace-pre-line">
          {R(c.dm.btnText)}
          {"\n"}
          {buttons}
        </p>
      )}
      {f === "twostep" && (
        <p className="whitespace-pre-line">
          {R(c.dm.step1)} [{c.dm.quick}]{"\n"}→ 누르면: {R(c.dm.btnText)} {buttons}
        </p>
      )}
      {soldOut && (
        <p className="text-xs text-muted-foreground">{c.dm.soldout.trim() ? `품절인 동안: ${R(c.dm.soldout)}` : "품절 안내 문구가 없어 품절인 동안 멈춰요."}</p>
      )}
    </div>
  );
}

const DM_BADGE: Record<string, { label: string; variant: "ok" | "warn" | "destructive" | "secondary"; Icon: typeof Send }> = {
  SENT: { label: "DM 보냄", variant: "ok", Icon: Send },
  UNKNOWN: { label: "확인 필요", variant: "warn", Icon: CircleHelp },
  FAILED: { label: "실패", variant: "destructive", Icon: CircleX },
  SKIPPED: { label: "건너뜀", variant: "secondary", Icon: CircleMinus },
  PENDING: { label: "보낼 차례", variant: "secondary", Icon: LoaderCircle },
  SENDING: { label: "보내는 중", variant: "secondary", Icon: LoaderCircle },
};

const REPLY_BADGE: Record<string, { label: string; variant: "ok" | "destructive" | "secondary" }> = {
  SENT: { label: "답글 보냄", variant: "ok" },
  PENDING: { label: "답글 대기", variant: "secondary" },
  SENDING: { label: "답글 다는 중", variant: "secondary" },
  FAILED: { label: "답글 실패", variant: "destructive" },
  SKIPPED: { label: "답글 건너뜀", variant: "secondary" },
};

const STEP2_BADGE: Record<string, { label: string; variant: "ok" | "destructive" | "secondary" }> = {
  WAITING: { label: "버튼 누르기 기다림", variant: "secondary" },
  SENT: { label: "링크 보냄", variant: "ok" },
  FAILED: { label: "링크 DM 실패", variant: "destructive" },
};

function EventRow({
  e,
  canManage,
  busy,
  onMarkSent,
  onResend,
}: {
  e: EventView;
  canManage: boolean;
  busy: boolean;
  onMarkSent: () => void;
  onResend: () => void;
}) {
  const name = e.username ?? "알 수 없는 사용자";
  const dmKey = e.dmStatus === "NONE" && e.skipReason ? "SKIPPED" : e.dmStatus;
  const dm = DM_BADGE[dmKey];
  const reply = e.replyStatus === "NONE" ? (e.dmStatus === "UNKNOWN" ? { label: "답글 보류", variant: "secondary" as const } : null) : REPLY_BADGE[e.replyStatus];
  const step2 = STEP2_BADGE[e.step2Status];

  // 이유 · 경고 줄
  const notes: Array<{ text: string; tone: "risk" | "warn" | "muted" }> = [];
  if (e.skipReason) notes.push({ text: SKIP_REASON[e.skipReason] ?? "조건에 맞지 않아 제외했어요.", tone: "muted" });
  if (e.dmStatus === "UNKNOWN") notes.push({ text: e.dmError ?? "인스타에서 응답이 끊겨 DM이 갔는지 확인되지 않았어요. 답글은 보류했어요.", tone: "warn" });
  else if (e.dmFallback) notes.push({ text: "버튼이 거절돼 글자 + 링크로 보냈어요.", tone: "warn" });
  else if (e.dmError) notes.push({ text: e.dmError, tone: e.dmStatus === "FAILED" || e.step2Status === "FAILED" ? "risk" : "muted" });
  if (e.replyError) notes.push({ text: e.replyError, tone: e.replyStatus === "FAILED" ? "risk" : "muted" });
  if (e.resolution === "MARKED_SENT") notes.push({ text: "사람이 확인해 보낸 것으로 처리했어요.", tone: "muted" });
  if (e.resolution === "RESENT") notes.push({ text: "사람이 확인해 다시 보냈어요.", tone: "muted" });

  return (
    <li className="flex gap-2.5 border-b py-3 last:border-b-0">
      <span className="grid size-[26px] shrink-0 place-items-center rounded-full bg-surface-3 text-xs font-bold text-ink-2">{name[0]?.toUpperCase()}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <b className="text-sm">{name}</b>
          {e.commentedAt && (
            <span className="text-xs text-muted-foreground">
              <RelativeTime iso={e.commentedAt} />
            </span>
          )}
          {e.source === "BACKFILL" && <span className="text-xs text-muted-foreground">· 이미 달린 댓글</span>}
        </div>
        {e.text && <p className="text-sm break-words text-ink-2">{e.text}</p>}
        {(dm || reply || step2) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {dm && (
              <Badge variant={dm.variant}>
                <dm.Icon />
                {dm.label}
              </Badge>
            )}
            {step2 && <Badge variant={step2.variant}>{step2.label}</Badge>}
            {reply && (
              <Badge variant={reply.variant}>
                {reply.variant === "ok" && <CircleCheck />}
                {reply.label}
              </Badge>
            )}
          </div>
        )}
        {notes.map((n, i) => (
          <p key={i} className={cn("text-xs", n.tone === "risk" ? "text-risk" : n.tone === "warn" ? "text-warn" : "text-muted-foreground")}>
            {n.text}
          </p>
        ))}
        {e.dmStatus === "UNKNOWN" && canManage && (
          <>
            <p className="text-xs text-muted-foreground">다시 보내면 같은 사람이 DM을 두 번 받을 수 있어요. 인스타 메시지함에서 먼저 확인해 주세요.</p>
            <div className="mt-0.5 flex gap-1.5">
              <Button variant="outline" size="sm" disabled={busy} onClick={onMarkSent}>
                보낸 것으로 처리
              </Button>
              <Button variant="outline" size="sm" disabled={busy} onClick={onResend}>
                다시 보내기
              </Button>
            </div>
          </>
        )}
      </div>
    </li>
  );
}
