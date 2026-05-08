"use client";

import { useEffect, useState } from "react";

interface RelativeTimeProps {
  iso: string;
  format?: "datetime" | "date";
}

// Defer locale-formatted time to client mount. Server's Node ICU may fall back
// to English ("PM 3:56") while the browser renders Korean ("오후 3:56"),
// causing a hydration mismatch.
export function RelativeTime({ iso, format = "datetime" }: RelativeTimeProps) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    const opts: Intl.DateTimeFormatOptions =
      format === "datetime"
        ? { dateStyle: "short", timeStyle: "short" }
        : { dateStyle: "short" };
    setText(new Intl.DateTimeFormat("ko-KR", opts).format(new Date(iso)));
  }, [iso, format]);
  return <>{text ?? ""}</>;
}
