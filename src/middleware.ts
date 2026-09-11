import { NextResponse, type NextRequest } from "next/server";
import { readAuthOrigin } from "@/lib/env-schema";

export function isAdminPath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

// This is only a cheap routing filter. Every protected server consumer calls requireAdmin.
export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (!isAdminPath(pathname) || pathname === "/admin/login" || pathname === "/admin/login/") {
    return NextResponse.next();
  }
  const hasSessionCookie = request.cookies
    .getAll()
    .some(
      ({ name, value }) =>
        Boolean(value) && /^(?:__Secure-)?authjs\.session-token(?:\.[0-9]+)?$/.test(name),
    );
  if (hasSessionCookie) return NextResponse.next();
  const origin = readAuthOrigin({ AUTH_URL: process.env.AUTH_URL });
  return NextResponse.redirect(new URL("/admin/login", origin));
}

export const config = {
  matcher: ["/admin", "/admin/:path*"],
};
