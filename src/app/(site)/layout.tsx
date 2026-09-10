import type { ReactNode } from "react";

import { SiteHeader } from "@/components/layout/site-header";

export default function SiteLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <>
      <SiteHeader />
      <div className="mx-auto w-full min-w-0 p-gutter sm:px-6 lg:px-8 wide:max-w-5xl">
        {children}
      </div>
    </>
  );
}
