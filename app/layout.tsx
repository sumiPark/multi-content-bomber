import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Multi-Content Bomber",
  description:
    "AI 멀티 채널 콘텐츠 배포 시스템 — 한 번의 업로드로 YouTube, Instagram, TikTok에 일괄 배포",
  icons: {
    icon: "/logos/favicon.svg",
    shortcut: "/logos/favicon.svg",
    apple: "/logos/favicon.svg",
  },
  // 플랫폼별 도메인 소유 verify 태그. Next.js가 <head>에 <meta name="..." content="...">로 자동 렌더링.
  // - facebook-domain-verification: Meta Business Verification (Instagram App Review 전제 조건)
  // ⚠️ Next.js 16의 verification.other는 값을 iterable로 처리하므로 string이 아닌 배열로 넘겨야 한다
  // (string을 그대로 넘기면 글자 단위로 iterate되어 깨짐 — node_modules/next/dist/lib/metadata/metadata.js:615).
  verification: {
    other: {
      "facebook-domain-verification": ["r1chnaigo6uwlsb5954foezifbc9qv"],
    },
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
