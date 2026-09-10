import { NextResponse, type NextRequest } from "next/server";

export function isAdminPath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

// Phase011 replaces this temporary deny-all gate with the authentication boundary.
export function middleware(_request: NextRequest) {
  return new NextResponse(null, { status: 404 });
}

export const config = {
  matcher: ["/admin", "/admin/:path*"],
};
