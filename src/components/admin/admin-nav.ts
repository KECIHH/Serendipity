export type AdminNavItem =
  | { readonly kind: "link"; readonly href: string; readonly label: string }
  | { readonly kind: "action"; readonly action: "logout"; readonly label: string };

/** Add an entry only in the same change that creates its reachable page. */
export const ADMIN_NAV = [
  { kind: "link", href: "/admin/users", label: "用户管理" },
  { kind: "action", action: "logout", label: "退出登录" },
] as const satisfies readonly AdminNavItem[];

export function activeAdminHref(
  pathname: string,
  items: readonly AdminNavItem[] = ADMIN_NAV,
): string | null {
  let active: string | null = null;
  for (const item of items) {
    if (
      item.kind === "link" &&
      (pathname === item.href || pathname.startsWith(`${item.href}/`)) &&
      (active === null || item.href.length > active.length)
    ) {
      active = item.href;
    }
  }
  return active;
}
