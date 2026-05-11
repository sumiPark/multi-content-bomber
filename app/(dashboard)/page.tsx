import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CaptionResult } from "@/components/ai/caption-result";
import { RelativeTime } from "@/components/ui/relative-time";
import { captionsSchema } from "@/lib/ai/caption-generator";
import { createClient } from "@/lib/supabase/server";

const THUMBNAIL_TTL_SECONDS = 3600;

interface DashboardPageProps {
  searchParams: Promise<{ content?: string }>;
}

export default async function DashboardPage({
  searchParams,
}: DashboardPageProps) {
  const { content: targetContentId } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("organization_id, role")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile?.organization_id) redirect("/onboarding");

  const { data: organization } = await supabase
    .from("organizations")
    .select("name")
    .eq("id", profile.organization_id)
    .single();

  // -- Single-content view --
  if (targetContentId) {
    const { data: latest } = await supabase
      .from("contents")
      .select("id, media_urls, ai_captions, updated_at")
      .eq("id", targetContentId)
      .maybeSingle();

    let savedContent: {
      id: string;
      captions: ReturnType<typeof captionsSchema.parse>;
      savedAt: string;
      thumbnails: string[];
    } | null = null;

    if (latest?.ai_captions) {
      const parsed = captionsSchema.safeParse(latest.ai_captions);
      if (parsed.success) {
        const { data: signed } = await supabase.storage
          .from("media")
          .createSignedUrls(latest.media_urls, THUMBNAIL_TTL_SECONDS);
        const thumbnails =
          signed
            ?.map((s) => s.signedUrl)
            .filter((u): u is string => Boolean(u)) ?? [];
        savedContent = {
          id: latest.id,
          captions: parsed.data,
          savedAt: latest.updated_at,
          thumbnails,
        };
      }
    }

    return (
      <main className="container mx-auto max-w-5xl px-6 py-10 space-y-6">
        <PageHeader
          title="콘텐츠 보기"
          subtitle="저장된 콘텐츠를 보거나 수정하세요."
          orgName={organization?.name ?? null}
          role={profile.role}
        />
        {savedContent ? (
          <CaptionResult
            key={savedContent.id}
            contentId={savedContent.id}
            captions={savedContent.captions}
            savedAt={savedContent.savedAt}
            thumbnails={savedContent.thumbnails}
          />
        ) : (
          <p className="text-muted-foreground">콘텐츠를 찾을 수 없습니다.</p>
        )}
      </main>
    );
  }

  // -- Dashboard overview --
  const [contentsCountRes, recentRes, accountsRes, jobsRes] = await Promise.all([
    supabase.from("contents").select("id", { count: "exact", head: true }),
    supabase
      .from("contents")
      .select("id, media_type, ai_captions, updated_at")
      .order("created_at", { ascending: false })
      .limit(5),
    supabase
      .from("social_accounts")
      .select("id, is_active, token_expires_at, platform"),
    supabase.from("publish_jobs").select("status"),
  ]);

  const totalContents = contentsCountRes.count ?? 0;
  const recent = recentRes.data ?? [];
  const accounts = accountsRes.data ?? [];
  const jobs = jobsRes.data ?? [];

  const now = Date.now();
  const activeAccounts = accounts.filter(
    (a) =>
      a.is_active &&
      (!a.token_expires_at || new Date(a.token_expires_at).getTime() > now),
  ).length;
  const expiredAccounts = accounts.filter(
    (a) =>
      a.token_expires_at &&
      new Date(a.token_expires_at).getTime() <= now,
  ).length;

  const jobsByStatus = jobs.reduce<Record<string, number>>((acc, j) => {
    acc[j.status] = (acc[j.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <main className="container mx-auto max-w-5xl px-6 py-10 space-y-6">
      <PageHeader
        title="대시보드"
        subtitle="워크스페이스 현황을 한눈에 확인하세요."
        orgName={organization?.name ?? null}
        role={profile.role}
        action={
          <Link
            href="/upload"
            className={buttonVariants({ variant: "default" })}
          >
            <Plus className="size-4" /> 새 콘텐츠
          </Link>
        }
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatCard
          title="전체 콘텐츠"
          value={String(totalContents)}
          hint={`최근 5개 표시 중`}
        />
        <StatCard
          title="연동 계정"
          value={`${activeAccounts}`}
          unit={`/ ${accounts.length}`}
          hint={
            expiredAccounts > 0
              ? `${expiredAccounts}개 토큰 만료`
              : accounts.length === 0
                ? "아직 연동 안 됨"
                : "모두 활성"
          }
          hintVariant={expiredAccounts > 0 ? "destructive" : "muted"}
        />
        <StatCard
          title="대기 중 업로드"
          value={String(jobsByStatus.PENDING ?? 0)}
          hint={`성공 ${jobsByStatus.SUCCESS ?? 0} · 실패 ${jobsByStatus.FAILED ?? 0}`}
        />
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>최근 콘텐츠</CardTitle>
            <Link
              href="/contents"
              className="text-sm text-muted-foreground transition hover:text-foreground"
            >
              모두 보기 →
            </Link>
          </div>
          <CardDescription>최근 만든 콘텐츠 5개</CardDescription>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              아직 만든 콘텐츠가 없어요.{" "}
              <Link
                href="/upload"
                className="text-foreground underline-offset-4 hover:underline"
              >
                첫 콘텐츠 만들기 →
              </Link>
            </p>
          ) : (
            <ul className="space-y-2">
              {recent.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/?content=${c.id}`}
                    className="block rounded-md border p-3 transition hover:bg-accent/40"
                  >
                    <p className="line-clamp-1 text-sm">
                      {captionPreview(c.ai_captions)}
                    </p>
                    <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="outline" className="font-normal">
                        {c.media_type}
                      </Badge>
                      <RelativeTime iso={c.updated_at} />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function PageHeader({
  title,
  subtitle,
  orgName,
  role,
  action,
}: {
  title: string;
  subtitle: string;
  orgName: string | null;
  role: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="flex items-end justify-between gap-4">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
      </div>
      <div className="flex items-center gap-3">
        {orgName && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>{orgName}</span>
            <Badge variant="outline">{role}</Badge>
          </div>
        )}
        {action}
      </div>
    </header>
  );
}

function StatCard({
  title,
  value,
  unit,
  hint,
  hintVariant = "muted",
}: {
  title: string;
  value: string;
  unit?: string;
  hint?: string;
  hintVariant?: "muted" | "destructive";
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{title}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-3xl font-bold tracking-tight">
          {value}
          {unit && (
            <span className="ml-1 text-base font-normal text-muted-foreground">
              {unit}
            </span>
          )}
        </p>
        {hint && (
          <p
            className={
              hintVariant === "destructive"
                ? "mt-1 text-xs text-destructive"
                : "mt-1 text-xs text-muted-foreground"
            }
          >
            {hint}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function captionPreview(captions: unknown): string {
  if (!captions || typeof captions !== "object") return "(캡션 없음)";
  const ig = (captions as { instagram?: { caption?: unknown } }).instagram
    ?.caption;
  if (typeof ig === "string" && ig.trim().length > 0) {
    return ig.slice(0, 120);
  }
  return "(캡션 없음)";
}
