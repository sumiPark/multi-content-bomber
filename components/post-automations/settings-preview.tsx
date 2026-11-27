"use client";

import { ExternalLink, ImageIcon, MessageCircle, RefreshCw, Send, ShoppingBag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { effectiveReplyWhen, isTriggerRelevant, renderText, withUtm, type AutomationConfig } from "@/lib/post-automations/config";
import { cn } from "@/lib/utils";
import type { ProductView } from "./types";

// 고객이 보는 댓글 · DM 미리보기 — 실제 보낼 문구(renderText)로 채운다. 휴대폰 화면을 줄인 그림.

const SAMPLE_USER = "jiwoo.daily";

export function SettingsPreview({
  c,
  product,
  accountName,
  mediaUrl,
  tab,
  onTab,
  replyIdx,
  onNextReply,
}: {
  c: AutomationConfig;
  product: ProductView | null;
  accountName: string;
  mediaUrl: string | null;
  tab: "comment" | "dm";
  onTab: (t: "comment" | "dm") => void;
  replyIdx: number;
  onNextReply: () => void;
}) {
  const ctx = {
    productName: product?.name ?? null,
    productUrl: product ? withUtm(product.url, "INSTAGRAM", "dm") : null,
    username: SAMPLE_USER,
  };
  const R = (t: string) => renderText(c, t, ctx);
  const sample =
    c.trig.mode === "all" ? "와 진짜 맛있어 보여요" : c.trig.keywords[0] ? (c.trig.match === "exact" ? c.trig.keywords[0] : `${c.trig.keywords[0]} 주세요!`) : "(키워드)";
  const texts = c.reply.texts.filter((t) => t.trim());
  const reply = texts.length ? texts[replyIdx % texts.length] : "";
  const showReply = c.reply.on && (effectiveReplyWhen(c) === "all" || c.dm.on) && !!reply;
  const me = accountName.replace(/^@/, "") || "내 계정";
  const soldoutNow = !!product?.soldOut && !!c.dm.soldout.trim();
  const f = c.dm.format;

  const tmpl = (
    <div className="w-[86%] self-end overflow-hidden rounded-2xl border bg-card">
      <div className="px-3 py-2.5 break-all whitespace-pre-line">{R(c.dm.btnText)}</div>
      {c.dm.buttons.map((b, i) => (
        <div key={i} className="flex items-center justify-center gap-1 border-t px-3 py-2 font-semibold text-primary">
          {b.link === "custom" ? <ExternalLink className="size-3.5" /> : <ShoppingBag className="size-3.5" />}
          {b.label.trim() || "버튼 이름"}
        </div>
      ))}
    </div>
  );

  const note = soldoutNow
    ? "상품이 품절인 동안에는 품절 안내 문구를 글자로 보내요."
    : f === "button"
      ? "버튼을 누르면 MCB 주소를 거쳐 상품 페이지가 인스타 안에서 열려요. 첫 DM 버튼이 거절되면 글자 + 링크로 다시 보내요."
      : f === "twostep"
        ? `'${c.dm.quick}' 버튼을 누른 사람에게만 두 번째 DM이 가요. 빠른 답장은 PC 인스타에서 보이지 않아요.`
        : "상품 링크에는 클릭을 집계하는 표시(utm)가 붙어요.";

  return (
    <div className="flex w-[280px] max-w-full flex-col items-center gap-3">
      <Segmented
        ariaLabel="미리보기"
        value={tab}
        onChange={onTab}
        className="w-full [&>button]:flex-1 [&>button]:justify-center"
        options={[
          { value: "comment", label: (<><MessageCircle />댓글</>) },
          { value: "dm", label: (<><Send />DM</>) },
        ]}
      />

      {tab === "comment" ? (
        <>
          <Phone>
            <div className="flex items-center gap-2 border-b px-3 py-2.5">
              <Avatar me name={me} />
              <b>{me}</b>
            </div>
            <div className="grid h-[150px] place-items-center overflow-hidden bg-surface-3 text-muted-foreground">
              {mediaUrl || product?.image ? (
                // 인스타 · 상품 CDN 이미지라 next/image 대신 img
                // eslint-disable-next-line @next/next/no-img-element
                <img src={(mediaUrl || product?.image) ?? ""} alt="" className="size-full object-cover" />
              ) : (
                <ImageIcon className="size-10" />
              )}
            </div>
            <div className="flex min-h-[170px] flex-col gap-2.5 px-3 pt-2.5 pb-3.5">
              <div className="border-b pb-1.5 text-center font-bold">댓글</div>
              {c.first.on && <Comment me name={me} text={R(c.first.text)} />}
              {isTriggerRelevant(c) && (
                <>
                  <Comment name={SAMPLE_USER} text={sample} />
                  {showReply && <Comment me reply name={me} text={R(reply)} />}
                </>
              )}
              {!c.first.on && !isTriggerRelevant(c) && <div className="py-10 text-center text-muted-foreground">켜진 기능이 없어요</div>}
            </div>
          </Phone>
          {showReply && texts.length > 1 && (
            <Button variant="ghost" size="sm" onClick={onNextReply}>
              <RefreshCw />
              다른 답글 보기 ({(replyIdx % texts.length) + 1}/{texts.length})
            </Button>
          )}
        </>
      ) : !c.dm.on ? (
        <Phone>
          <div className="px-4 py-10 text-center text-muted-foreground">DM 보내기가 꺼져 있어요</div>
        </Phone>
      ) : (
        <>
          <Phone>
            <div className="flex items-center gap-2 border-b px-3 py-2.5">
              <Avatar name={SAMPLE_USER} />
              <b>{SAMPLE_USER}</b>
            </div>
            <div className="flex min-h-[320px] flex-col gap-2.5 p-3">
              <div className="self-center text-center text-muted-foreground">
                {SAMPLE_USER}님의 댓글에 답장했어요
                <br />“{sample}”
              </div>
              {soldoutNow ? (
                <Bubble out text={R(c.dm.soldout)} />
              ) : f === "text" ? (
                <Bubble out text={R(c.dm.text)} />
              ) : f === "button" ? (
                tmpl
              ) : (
                <>
                  <Bubble out text={R(c.dm.step1)} />
                  <div className="flex justify-end">
                    <span className="rounded-full border border-primary bg-card px-3 py-0.5 font-semibold text-primary">{c.dm.quick || "버튼 이름"}</span>
                  </div>
                  <div className="flex items-center gap-2 text-muted-foreground before:flex-1 before:border-t before:border-dashed after:flex-1 after:border-t after:border-dashed">
                    누르면
                  </div>
                  <Bubble text={c.dm.quick || "버튼 이름"} />
                  {tmpl}
                </>
              )}
            </div>
          </Phone>
          <p className="text-xs text-muted-foreground">
            {note} 팔로우하지 않은 사람에게는 메시지 요청함으로 가요.
          </p>
        </>
      )}
    </div>
  );
}

function Phone({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-full overflow-hidden rounded-[28px] border-8 border-foreground bg-card text-xs shadow-[0_8px_24px_rgb(16_24_40/.12),0_2px_6px_rgb(16_24_40/.08)]">
      {children}
    </div>
  );
}

function Avatar({ name, me }: { name: string; me?: boolean }) {
  return (
    <span className={cn("grid size-[26px] shrink-0 place-items-center rounded-full font-bold", me ? "bg-primary text-primary-foreground" : "bg-surface-3 text-ink-2")}>
      {name[0]?.toUpperCase()}
    </span>
  );
}

function Comment({ name, text, me, reply }: { name: string; text: string; me?: boolean; reply?: boolean }) {
  return (
    <div className={cn("flex items-start gap-2", reply && "ml-[34px]")}>
      <Avatar name={name} me={me} />
      <div className="min-w-0">
        <span className="font-bold">{name}</span> {me && <span className="text-muted-foreground">작성자</span>}
        <p className="break-all whitespace-pre-line">{text}</p>
      </div>
    </div>
  );
}

function Bubble({ text, out }: { text: string; out?: boolean }) {
  // 링크는 밑줄
  const parts = text.split(/(https:\/\/\S+)/g);
  return (
    <div
      className={cn(
        "max-w-[86%] rounded-2xl px-3 py-2 break-all whitespace-pre-line",
        out ? "self-end rounded-br-md bg-primary text-primary-foreground" : "self-start rounded-bl-md bg-surface-3 text-foreground",
      )}
    >
      {parts.map((p, i) => (/^https:\/\//.test(p) ? <span key={i} className="underline">{p}</span> : p))}
    </div>
  );
}
