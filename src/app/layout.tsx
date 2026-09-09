import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Serendipity · 际遇",
  description: "中文旅行规划工具",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
