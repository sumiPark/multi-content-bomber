"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Bookmark,
  CircleHelp,
  CircleAlert,
  CirclePause,
  CornerDownRight,
  MessageCircleReply,
  Play,
  Plus,
  Send,
  Unplug,
} from "lucide-react";
import {
  deleteAutomationTemplate,
  getProductsForAutomation,
  retryFirstComment,
  setAutomationActive,
  type RecentPost,
} from "@/app/(dashboard)/post-automations/actions";
import { AccountTabs } from "@/components/shoot/account-tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { AutomationDrawer, type EventFilter } from "./automation-drawer";
import { AutomationTable } from "./automation-table";
import { PostPicker } from "./post-picker";
import { SettingsModal, type SettingsTarget } from "./settings-modal";
import { captionTitle, templateSummary } from "./shared";
import type { AccountView, AutomationView, ProductView, TemplateView } from "./types";

type Tab = "live" | "ended" | "tpl";

export function PostAutomationsPage({
  accounts,
  selectedAccountId,
  canManage,
  automations,
  templates,
  products,
}: {
  accounts: AccountView[];
  selectedAccountId: string | null;
  canManage: boolean;
  automations: AutomationView[];
  templates: TemplateView[];
  products: Record<string, ProductView>;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("live");
  const [drawer, setDrawer] = useState<{ id: string; filter: EventFilter } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [settings, setSettings] = useState<SettingsTarget | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [delTemplate, setDelTemplate] = useState<TemplateView | null>(null);
  const [isPending, startTransition] = useTransition();

  const account = accounts.find((a) => a.id === selectedAccountId) ?? null;
  const live = useMemo(() => automations.filter((a) => a.status !== "ENDED"), [automations]);
  const ended = useMemo(() => automations.filter((a) => a.status === "ENDED"), [automations]);

  const sum = (k: "dmSent" | "replySent") => live.reduce((n, a) => n + a.stats[k], 0);
  // 확인 필요는 끝난 게시물에도 남아 있으면 센다 — 사람이 처리해야 해서
  const unknownTotal = automations.reduce((n, a) => n + a.stats.unknown, 0);
  const firstUnknown = automations.find((a) => a.stats.unknown > 0) ?? null;
  const activeCount = live.filter((a) => a.status === "ACTIVE").length;
  const soldout = live.filter((a) => a.status === "PAUSED" && a.pausedReason === "SOLDOUT");
  const accountPaused = live.filter((a) => a.status === "PAUSED" && a.pausedReason === "ACCOUNT");
  const firstFailed = live.filter((a) => a.firstStatus === "FAILED");

  const drawerItem = drawer ? (automations.find((a) => a.id === drawer.id) ?? null) : null;
  const canAdd = canManage && !!account?.isActive;

  function openEdit(a: AutomationView) {
    setDrawer(null);
    setSettings({ mode: "edit", automation: a, product: a.productId ? (products[a.productId] ?? null) : null });
  }

  function toggle(a: AutomationView, on: boolean) {
    setBusyId(a.id);
    startTransition(async () => {
      const r = await setAutomationActive(a.id, on);
      setBusyId(null);
      if (!r.ok) {
        toast(r.error, "risk");
        return;
      }
      toast(on ? "켰어요. 꺼져 있던 동안 달린 댓글은 7일 안이면 이어서 처리해요." : "껐어요. 대기 중인 발송도 멈췄어요.");
      router.refresh();
    });
  }

  function retryFirst(a: AutomationView) {
    setBusyId(a.id);
    startTransition(async () => {
      const r = await retryFirstComment(a.id);
      setBusyId(null);
      if (!r.ok) {
        toast(`첫 댓글을 다시 달지 못했어요. ${r.error}`, "risk");
        return;
      }
      toast("첫 댓글을 달았어요.");
      router.refresh();
    });
  }

  async function pickPost(post: RecentPost) {
    if (post.automationId) {
      const a = automations.find((x) => x.id === post.automationId);
      setPickerOpen(false);
      if (a) openEdit(a);
      else toast("이 게시물의 설정을 찾지 못했어요. 새로 고친 뒤 다시 시도해 주세요.", "risk");
      return;
    }
    let product: ProductView | null = post.productId ? (products[post.productId] ?? null) : null;
    if (post.productId && !product) {
      const r = await getProductsForAutomation([post.productId]);
      if (r.ok) product = r.products[0] ?? null;
    }
    setPickerOpen(false);
    setSettings({ mode: "new", post, product });
  }

  function removeTemplate(t: TemplateView) {
    startTransition(async () => {
      const r = await deleteAutomationTemplate(t.id);
      setDelTemplate(null);
      if (!r.ok) {
        toast(r.error, "risk");
        return;
      }
      toast("템플릿을 지웠어요. 이미 켠 게시물에는 영향이 없어요.");
      router.refresh();
    });
  }

  return (
    <main className="space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-[-0.01em]">댓글 · DM 자동화</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">게시물마다 첫 댓글 · 키워드 답글 · DM을 자동으로 보내요.</p>
        </div>
        {canManage && (
          <Button onClick={() => setPickerOpen(true)} disabled={!canAdd}>
            <Plus />
            게시물에 켜기
          </Button>
        )}
      </header>

      {accounts.length === 0 ? (
        <div className="rounded-lg border bg-card">
          <EmptyState
            icon={<Unplug className="size-[18px]" />}
            title="연결된 인스타그램 계정이 없어요"
            body="계정 연동에서 인스타그램 비즈니스 · 크리에이터 계정을 연결하면 게시물에 켤 수 있어요."
            action={
              <Link href="/accounts" className="text-sm font-semibold text-primary hover:underline">
                계정 연동으로 가기
              </Link>
            }
          />
        </div>
      ) : (
        <>
          <AccountTabs
            label="인스타그램 계정"
            active={selectedAccountId ?? ""}
            tabs={accounts.map((a) => ({
              key: a.id,
              label: `@${(a.name ?? "이름 없음").replace(/^@/, "")}`,
              count: a.liveCount,
              href: `/post-automations?account=${a.id}`,
            }))}
          />

          {account && !account.isActive && (
            <Note tone="risk" icon={<Unplug className="size-[18px]" />}>
              <b className="text-foreground">계정 토큰이 만료됐어요.</b> 계정 연동에서 다시 연결하면 멈춘 자동화를 다시 켤 수 있어요.{" "}
              <Link href="/accounts" className="font-semibold text-primary hover:underline">
                계정 연동
              </Link>
            </Note>
          )}

          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Kpi icon={<Play className="size-3.5" />} label="진행 중 게시물" value={activeCount} foot={`꺼짐 · 멈춤 · 발행 기다림 ${live.length - activeCount}개`} />
            <Kpi icon={<Send className="size-3.5" />} label="DM 보냄" value={sum("dmSent")} foot="진행 중 탭 게시물 누적" />
            <Kpi icon={<CornerDownRight className="size-3.5" />} label="답글 등록" value={sum("replySent")} foot="진행 중 탭 게시물 누적" />
            <Kpi
              icon={<CircleHelp className="size-3.5" />}
              label="확인 필요"
              value={unknownTotal}
              warn={unknownTotal > 0}
              foot={unknownTotal > 0 ? "DM이 갔는지 확인해 주세요" : "없어요"}
            />
          </div>

          {firstUnknown && (
            <Note tone="warn" icon={<CircleHelp className="size-[18px]" />} action={<Button variant="outline" size="sm" onClick={() => setDrawer({ id: firstUnknown.id, filter: "check" })}>확인하기</Button>}>
              <b className="text-foreground">DM이 갔는지 확인되지 않은 댓글 {unknownTotal}건</b>이 있어요. 두 번 보내지 않도록 자동으로 다시 보내지 않아요.
            </Note>
          )}

          {soldout.map((a) => (
            <Note
              key={a.id}
              tone="risk"
              icon={<CirclePause className="size-[18px]" />}
              action={canManage ? <Button variant="outline" size="sm" onClick={() => openEdit(a)}>설정 고치기</Button> : null}
            >
              <b className="text-foreground">{(a.productId && products[a.productId]?.name) || "연결 상품"}</b> 상품이 품절되어 게시물 1개의 자동화를 멈췄어요. 품절 안내 문구를 넣거나 상품을 바꾸면 다시 켤 수 있어요.
            </Note>
          ))}

          {accountPaused.length > 0 && account?.isActive && (
            <Note tone="risk" icon={<Unplug className="size-[18px]" />}>
              계정 연결 문제로 게시물 {accountPaused.length}개의 자동화를 멈췄어요. 연결을 확인한 뒤 표에서 다시 켜 주세요.{" "}
              <Link href="/accounts" className="font-semibold text-primary hover:underline">
                계정 연동
              </Link>
            </Note>
          )}

          {firstFailed.map((a) => (
            <Note
              key={a.id}
              tone="risk"
              icon={<CircleAlert className="size-[18px]" />}
              action={
                canManage ? (
                  <Button variant="outline" size="sm" disabled={isPending && busyId === a.id} onClick={() => retryFirst(a)}>
                    다시 시도
                  </Button>
                ) : null
              }
            >
              <b className="text-foreground">첫 댓글을 달지 못했어요</b> · {captionTitle(a.caption)}
              {a.firstError && <span className="mt-0.5 block text-xs text-risk">{a.firstError}</span>}
            </Note>
          ))}

          <div className="overflow-hidden rounded-lg border bg-card">
            <div role="tablist" aria-label="목록" className="flex items-end gap-1.5 overflow-x-auto border-b bg-surface-2 px-4 pt-3">
              {(
                [
                  ["live", "진행 중", live.length],
                  ["ended", "끝남", ended.length],
                  ["tpl", "템플릿", templates.length],
                ] as const
              ).map(([key, label, count]) => {
                const on = tab === key;
                return (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => setTab(key)}
                    className={cn(
                      "relative -mb-px inline-flex h-11 shrink-0 items-center gap-2 rounded-t-[10px] border border-b-0 px-4 text-sm font-semibold whitespace-nowrap transition-colors sm:px-5",
                      on ? "bg-card text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {label}
                    <span
                      className={cn(
                        "rounded-full px-[7px] text-xs leading-5 font-semibold tabular-nums",
                        on ? "bg-brand-soft text-primary" : "bg-surface-3 text-muted-foreground",
                      )}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            {tab === "tpl" ? (
              <TemplateList templates={templates} canManage={canManage} onDelete={setDelTemplate} />
            ) : (tab === "live" ? live : ended).length === 0 ? (
              <EmptyState
                icon={<MessageCircleReply className="size-[18px]" />}
                title={tab === "live" ? "아직 켠 게시물이 없어요" : "끝난 게시물이 없어요"}
                body={tab === "live" ? "게시물을 고르면 첫 댓글 · 답글 · DM을 한 번에 설정할 수 있어요." : "기간이 끝나면 여기로 옮겨지고 기록은 그대로 남아요."}
                action={
                  tab === "live" && canManage ? (
                    <Button onClick={() => setPickerOpen(true)} disabled={!canAdd}>
                      <Plus />
                      게시물에 켜기
                    </Button>
                  ) : null
                }
              />
            ) : (
              <AutomationTable
                rows={tab === "live" ? live : ended}
                products={products}
                canManage={canManage}
                busyId={isPending ? busyId : null}
                onOpen={(a) => setDrawer({ id: a.id, filter: "all" })}
                onToggle={toggle}
              />
            )}
          </div>
        </>
      )}

      {drawerItem && account && (
        <AutomationDrawer
          key={drawerItem.id}
          automation={drawerItem}
          accountName={account.name}
          product={drawerItem.productId ? (products[drawerItem.productId] ?? null) : null}
          initialFilter={drawer?.filter ?? "all"}
          canManage={canManage}
          togglePending={isPending && busyId === drawerItem.id}
          onClose={() => setDrawer(null)}
          onEdit={() => openEdit(drawerItem)}
          onToggle={(on) => toggle(drawerItem, on)}
          onDeleted={() => {
            setDrawer(null);
            router.refresh();
          }}
        />
      )}

      {account && (
        <PostPicker open={pickerOpen} accountId={account.id} accountName={account.name} onClose={() => setPickerOpen(false)} onPick={pickPost} />
      )}

      {account && settings && (
        <SettingsModal
          key={settings.mode === "edit" ? settings.automation.id : settings.post.id}
          target={settings}
          accountId={account.id}
          accountName={account.name}
          templates={templates}
          onClose={() => setSettings(null)}
          onSaved={() => {
            setSettings(null);
            setTab("live");
            router.refresh();
          }}
        />
      )}

      <ConfirmDialog
        open={!!delTemplate}
        title="템플릿을 지울까요?"
        confirmLabel="지우기"
        danger
        pending={isPending}
        onConfirm={() => delTemplate && removeTemplate(delTemplate)}
        onClose={() => setDelTemplate(null)}
      >
        <p>
          <b>{delTemplate?.name}</b> 템플릿을 지워요. 이 템플릿으로 이미 켠 게시물에는 영향이 없어요.
        </p>
      </ConfirmDialog>
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function Kpi({ icon, label, value, foot, warn }: { icon: React.ReactNode; label: string; value: number; foot: string; warn?: boolean }) {
  return (
    <div className={cn("min-w-0 rounded-lg border bg-card px-[18px] py-4", warn && "border-warn/40")}>
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {icon}
        {label}
      </p>
      <p className={cn("mt-1.5 mb-1 text-2xl leading-tight font-bold tracking-[-0.02em] tabular-nums", warn && "text-warn")}>{value.toLocaleString("ko-KR")}</p>
      <p className={cn("truncate text-xs", warn ? "font-medium text-warn" : "text-muted-foreground")}>{foot}</p>
    </div>
  );
}

function Note({
  tone,
  icon,
  action,
  children,
}: {
  tone: "warn" | "risk" | "info";
  icon: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-sm text-ink-2",
        tone === "warn" && "border-warn/40 bg-warn-soft",
        tone === "risk" && "border-transparent bg-risk-soft",
        tone === "info" && "border-transparent bg-brand-soft",
      )}
    >
      <span className={cn("mt-0.5 shrink-0", tone === "warn" ? "text-warn" : tone === "risk" ? "text-risk" : "text-primary")}>{icon}</span>
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}

function EmptyState({ icon, title, body, action }: { icon: React.ReactNode; title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-5 py-12 text-center">
      <span className="grid size-12 place-items-center rounded-lg bg-surface-2 text-muted-foreground">{icon}</span>
      <h3 className="mt-1 text-base font-semibold">{title}</h3>
      <p className="max-w-[440px] text-sm text-muted-foreground">{body}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

function TemplateList({
  templates,
  canManage,
  onDelete,
}: {
  templates: TemplateView[];
  canManage: boolean;
  onDelete: (t: TemplateView) => void;
}) {
  const base: Array<[string, string]> = [
    ["상품 링크 보내기", "키워드 댓글 → 상품 링크 DM → 답글"],
    ["안내 댓글만", "올린 직후 첫 댓글만 달기"],
  ];
  return (
    <div className="flex flex-col gap-2 p-4 sm:px-5">
      <p className="text-xs text-muted-foreground">설정 창의 &quot;무엇을 할까요?&quot;에 나와요. 고르면 문구 · 키워드 · 기간이 한 번에 채워져요.</p>
      {base.map(([name, desc]) => (
        <div key={name} className="flex items-center gap-3 rounded-lg border px-3.5 py-3">
          <Bookmark className="size-[18px] shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <b className="text-sm">{name}</b>
              <Badge variant="secondary">기본</Badge>
            </div>
            <p className="text-xs text-muted-foreground">{desc}</p>
          </div>
        </div>
      ))}
      {templates.map((t) => (
        <div key={t.id} className="flex items-center gap-3 rounded-lg border px-3.5 py-3">
          <Bookmark className="size-[18px] shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <b className="text-sm">{t.name}</b>
            <p className="truncate text-xs text-muted-foreground">{templateSummary(t.config)}</p>
          </div>
          {canManage && (
            <Button variant="destructive" size="sm" onClick={() => onDelete(t)}>
              지우기
            </Button>
          )}
        </div>
      ))}
      {templates.length === 0 && <p className="py-2 text-xs text-muted-foreground">저장한 템플릿이 없어요. 설정 창 아래 &quot;템플릿으로 저장&quot;으로 만들 수 있어요.</p>}
    </div>
  );
}
