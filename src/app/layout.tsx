import type { Metadata } from "next";
import { Toaster } from "@/components/ui/sonner";
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
      <body>
        {children}
        <Toaster
          theme="light"
          position="top-right"
          duration={4000}
          visibleToasts={3}
          closeButton
          offset={16}
          mobileOffset={16}
        />
      </body>
    </html>
  );
}
