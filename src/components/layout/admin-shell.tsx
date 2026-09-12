"use client";

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen, Users } from "lucide-react";

import { activeAdminHref, ADMIN_NAV } from "@/components/admin/admin-nav";
import { LogoutButton } from "@/components/auth/logout-button";
import { Button } from "@/components/ui/button";

type AdminShellProps = {
  children: ReactNode;
  currentUser: { readonly id: string; readonly email: string };
};

export function AdminShell({ children, currentUser }: AdminShellProps) {
  const pathname = usePathname();
  const activeHref = activeAdminHref(pathname);
  const [expanded, setExpanded] = useState(true);
  const toggleRef = useRef<HTMLButtonElement>(null);

  function navigateWithKeyboard(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setExpanded(false);
      toggleRef.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const controls = Array.from(
      event.currentTarget.querySelectorAll<HTMLAnchorElement | HTMLButtonElement>(
        "a[href], button:not([disabled])",
      ),
    );
    const current = controls.indexOf(event.target as HTMLAnchorElement | HTMLButtonElement);
    if (current < 0 || controls.length === 0) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? controls.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + controls.length) % controls.length;
    controls[next]?.focus();
  }

  return (
    <>
      <a
        href="#admin-main-content"
        className="sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:w-auto focus:rounded-md focus:bg-surface focus:p-3 focus:not-sr-only"
      >
        跳到主要内容
      </a>
      <div
        data-admin-shell="true"
        className="mx-auto flex min-h-screen w-full min-w-0 max-w-[90rem] flex-col bg-surface-muted text-foreground md:flex-row"
      >
        <aside
          className={`w-full shrink-0 border-b border-border-subtle bg-surface p-gutter md:border-r md:border-b-0 ${expanded ? "md:w-56" : "md:w-20"}`}
        >
          <div className="flex items-center justify-between gap-2 md:flex-col md:items-stretch">
            <h2 className={expanded ? "text-lg leading-7 font-semibold" : "sr-only"}>管理后台</h2>
            <Button
              ref={toggleRef}
              type="button"
              variant="ghost"
              className="min-h-11 min-w-11 shrink-0 px-2"
              aria-expanded={expanded}
              aria-controls="admin-navigation-panel"
              aria-label={expanded ? "收起后台导航" : "展开后台导航"}
              title={expanded ? "收起后台导航" : "展开后台导航"}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? (
                <PanelLeftClose aria-hidden="true" />
              ) : (
                <PanelLeftOpen aria-hidden="true" />
              )}
              <span className={expanded ? "md:inline" : "sr-only"}>收起导航</span>
            </Button>
          </div>
          <nav
            id="admin-navigation-panel"
            aria-label="后台导航"
            hidden={!expanded}
            onKeyDown={navigateWithKeyboard}
            className="mt-4"
          >
            <ul className="flex flex-wrap items-start gap-2 text-sm md:flex-col md:items-stretch">
              {ADMIN_NAV.map((item) => (
                <li key={item.kind === "link" ? item.href : item.action}>
                  {item.kind === "link" ? (
                    <Link
                      href={item.href}
                      aria-current={activeHref === item.href ? "page" : undefined}
                      className={`flex min-h-11 items-center gap-2 rounded-md px-3 py-2 font-medium no-underline ${activeHref === item.href ? "bg-emerald-50 text-emerald-800" : "text-zinc-700 hover:bg-zinc-100"}`}
                    >
                      <Users aria-hidden="true" className="size-4 shrink-0" />
                      {item.label}
                    </Link>
                  ) : (
                    <div className="[&_button]:min-h-11 [&_button]:w-full [&_button]:border-input">
                      <LogoutButton />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        </aside>
        <div className="min-w-0 flex-1">
          <header className="flex min-h-20 flex-wrap items-center justify-between gap-2 border-b bg-surface px-gutter py-3 sm:px-6">
            <p className="text-sm font-medium">Serendipity · 际遇</p>
            <div className="min-w-0 text-sm">
              <p className="text-zinc-600">当前管理员</p>
              <p className="break-words font-medium">{currentUser.email}</p>
            </div>
          </header>
          <main id="admin-main-content" tabIndex={-1} className="min-w-0 p-gutter sm:p-6">
            {children}
          </main>
        </div>
      </div>
    </>
  );
}
