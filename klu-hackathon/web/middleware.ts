/**
 * Runs before every page. Two jobs:
 *   1. refresh the Supabase auth cookie so sessions do not expire mid-browse
 *   2. gate the app - signed out users go to /login, and anyone still on the
 *      shared default password is sent to /change-password and kept there
 */
import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { canSeeAdminArea } from "@/lib/roles";

const PUBLIC_PATHS = ["/login", "/signup", "/auth", "/_next", "/favicon.ico"];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const { response, user, supabase } = await updateSession(request);

  const isPublic = PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));

  if (!user) {
    if (isPublic) return response;
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // Signed in and sitting on the login page - send them onward.
  if (pathname === "/login" || pathname === "/signup") {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  const needsProfile = pathname !== "/change-password" || pathname.startsWith("/admin");
  if (needsProfile) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("must_change_password, role")
      .eq("id", user.id)
      .maybeSingle();

    // Accounts created with the shared password may not browse anywhere until they
    // have set one of their own.
    if (profile?.must_change_password && pathname !== "/change-password") {
      const url = request.nextUrl.clone();
      url.pathname = "/change-password";
      url.search = "";
      return NextResponse.redirect(url);
    }

    // The admin area is checked here AND by RLS in the database. Middleware alone is
    // not a security boundary - it only decides what to render.
    if (pathname.startsWith("/admin") && !canSeeAdminArea(profile?.role)) {
      const url = request.nextUrl.clone();
      url.pathname = "/dashboard";
      url.search = "";
      return NextResponse.redirect(url);
    }
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};

