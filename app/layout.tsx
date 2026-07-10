import type { Metadata, Viewport } from "next";
import { ThemeProvider } from "next-themes";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

export const metadata: Metadata = {
  title: "전북소방 구조 AI",
  description:
    "전북소방 구조대원을 위한 교육자료 기반 RAG AI 챗봇 — 출처와 함께 답합니다.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // maximumScale 로 확대를 막지 않는다(WCAG 1.4.4 — 저시력 사용자 확대 허용)
  themeColor: "#111d31",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className="h-full" suppressHydrationWarning>
      <body className="min-h-full bg-background font-sans text-foreground antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {children}
          <Toaster position="top-center" richColors />
        </ThemeProvider>
      </body>
    </html>
  );
}
