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
      <body className="min-h-full flex flex-col">
        <div className="flex-1">{children}</div>
        {/* Google OAuth Verification / Meta App Review 자동 크롤러가 홈페이지에서
            Privacy Policy / Terms of Service / Data Deletion 링크의 존재를 확인한다.
            한·영 병기로 키워드 인식률을 높이고, 모든 페이지에 동일 노출. */}
        <footer className="border-t border-border bg-background py-6 text-center text-xs text-muted-foreground">
          <nav className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 px-4">
            <a href="/privacy" className="hover:underline">
              개인정보처리방침 / Privacy Policy
            </a>
            <span aria-hidden>·</span>
            <a href="/terms" className="hover:underline">
              이용약관 / Terms of Service
            </a>
            <span aria-hidden>·</span>
            <a href="/data-deletion" className="hover:underline">
              데이터 삭제 요청 / Data Deletion
            </a>
          </nav>
          <p className="mt-2">© 2026 MCB · Multi-Content Bomber</p>
        </footer>
      </body>
    </html>
  );
}
