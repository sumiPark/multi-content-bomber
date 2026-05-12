import Link from "next/link";
import type { ComponentType } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface ComingSoonProps {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  highlights?: string[];
  primaryHref?: string;
  primaryLabel?: string;
}

// 자동화 그룹의 추후 구현 메뉴(/auto-reply, /schedule-rules)가 공유하는 안내 화면.
export function ComingSoon({
  icon: Icon,
  title,
  description,
  highlights = [],
  primaryHref = "/",
  primaryLabel = "대시보드로",
}: ComingSoonProps) {
  return (
    <main className="container mx-auto max-w-2xl px-6 py-16">
      <Card>
        <CardContent className="flex flex-col items-center gap-5 px-8 py-12 text-center">
          <div className="grid size-14 place-items-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-300">
            <Icon className="size-7" aria-hidden />
          </div>
          <div className="flex flex-col items-center gap-2">
            <Badge className="border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
              soon
            </Badge>
            <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
            <p className="max-w-md text-sm text-muted-foreground">
              {description}
            </p>
          </div>

          {highlights.length > 0 && (
            <ul className="w-full max-w-md space-y-2 rounded-lg border bg-muted/30 p-4 text-left text-sm text-muted-foreground">
              {highlights.map((line) => (
                <li key={line} className="flex gap-2">
                  <span aria-hidden className="mt-1 size-1.5 shrink-0 rounded-full bg-emerald-500" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          )}

          <Link
            href={primaryHref}
            className="mt-2 inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            {primaryLabel}
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}
