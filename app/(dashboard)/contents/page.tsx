import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { RelativeTime } from "@/components/ui/relative-time";
import { ScrollArea } from "@/components/ui/scroll-area";
import { captionsSchema } from "@/lib/ai/caption-generator";
import { createClient } from "@/lib/supabase/server";

const THUMB_TTL_SECONDS = 3600;
const PAGE_LIMIT = 50;

export default async function ContentsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("organization_id")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile?.organization_id) redirect("/onboarding");

  const { data: contents } = await supabase
    .from("contents")
    .select("id, media_urls, ai_captions, created_at, updated_at, created_by")
    .order("created_at", { ascending: false })
    .limit(PAGE_LIMIT);

  const list = contents ?? [];
  const firstPaths = list
    .map((c) => c.media_urls[0])
    .filter((p): p is string => Boolean(p));

  const thumbsByPath = new Map<string, string>();
  if (firstPaths.length > 0) {
    const { data: signed } = await supabase.storage
      .from("media")
      .createSignedUrls(firstPaths, THUMB_TTL_SECONDS);
    signed?.forEach((s) => {
      if (s.path && s.signedUrl) thumbsByPath.set(s.path, s.signedUrl);
    });
  }

  return (
    <main className="container mx-auto max-w-4xl px-6 py-10 space-y-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">콘텐츠 보관함</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            워크스페이스에서 만든 모든 콘텐츠 ({list.length}개
            {list.length === PAGE_LIMIT ? "+" : ""})
          </p>
        </div>
        <Link
          href="/upload"
          className={buttonVariants({ variant: "outline" })}
        >
          <Plus className="size-4" /> 새 콘텐츠
        </Link>
      </header>

      {list.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            아직 만든 콘텐츠가 없어요.
            <br />
            대시보드에서 첫 콘텐츠를 만들어보세요.
          </CardContent>
        </Card>
      ) : (
        <ScrollArea className="h-[calc(100vh-220px)] rounded-md">
          <ul className="space-y-3 pr-3">
            {list.map((c) => {
              const captionsResult = captionsSchema.safeParse(c.ai_captions);
              const preview = captionsResult.success
                ? captionsResult.data.instagram.caption
                : "";
              const thumbUrl = c.media_urls[0]
                ? thumbsByPath.get(c.media_urls[0])
                : undefined;
              const isMine = c.created_by === user.id;

              return (
                <li key={c.id}>
                  <Link href={`/?content=${c.id}`} className="block">
                    <Card className="transition hover:bg-accent/40">
                      <CardContent className="flex gap-4 p-4">
                        <div className="relative size-24 shrink-0 overflow-hidden rounded-md border bg-muted">
                          {thumbUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={thumbUrl}
                              alt=""
                              className="size-full object-cover"
                            />
                          ) : null}
                          {c.media_urls.length > 1 && (
                            <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1.5 py-0.5 text-xs font-medium text-white">
                              +{c.media_urls.length - 1}
                            </span>
                          )}
                        </div>
                        <div className="flex min-w-0 flex-1 flex-col justify-between">
                          <p className="line-clamp-2 text-sm">
                            {preview || (
                              <span className="text-muted-foreground">
                                (캡션 없음)
                              </span>
                            )}
                          </p>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <RelativeTime iso={c.updated_at} />
                            {!isMine && (
                              <Badge variant="outline" className="font-normal">
                                다른 멤버
                              </Badge>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      )}
    </main>
  );
}
