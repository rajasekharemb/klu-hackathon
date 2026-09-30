import { NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/roles";

/**
 * Resets a student's password to the shared temporary one and flags the account
 * so the app forces a change at next sign-in.
 *
 * Changing an auth password needs the service_role key, which bypasses every
 * policy in the database. It is read here, on the server, from a variable with no
 * NEXT_PUBLIC_ prefix, so Next will not inline it into the browser bundle. Nothing
 * in this file returns it, and nothing in web/ may import it anywhere else.
 *
 * Owner only, checked against the database rather than trusted from the request.
 */

const TEMP_PASSWORD = process.env.RESET_TEMP_PASSWORD || "klu123";

export async function POST(request: Request) {
  const supabase = serverClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { data: me } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (!canManage(me?.role)) {
    return NextResponse.json({ error: "Only the owner can reset passwords" }, { status: 403 });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!serviceKey || !projectUrl) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is not set on the server. Add it in Vercel and redeploy." },
      { status: 500 },
    );
  }

  const body = await request.json().catch(() => ({}));
  const studentId = String(body.studentId ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(studentId)) {
    return NextResponse.json({ error: "No account given." }, { status: 400 });
  }
  if (studentId === user.id) {
    return NextResponse.json(
      { error: "Use Change password for your own account - this would lock you out of the admin page." },
      { status: 400 },
    );
  }

  // Look the target up rather than trusting what the page sent, so an owner
  // account cannot be reset by editing the request.
  const { data: target } = await supabase
    .from("profiles")
    .select("email, role, full_name")
    .eq("id", studentId)
    .maybeSingle();
  if (!target) return NextResponse.json({ error: "No such account." }, { status: 404 });
  if (target.role === "owner") {
    return NextResponse.json({ error: "An owner account cannot be reset here." }, { status: 400 });
  }

  const response = await fetch(`${projectUrl}/auth/v1/admin/users/${studentId}`, {
    method: "PUT",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ password: TEMP_PASSWORD }),
  });

  if (!response.ok) {
    const detail = await response.text();
    return NextResponse.json(
      { error: `Supabase refused the reset (HTTP ${response.status}). ${detail.slice(0, 200)}` },
      { status: 502 },
    );
  }

  // Middleware keeps them on /change-password until this is cleared, which is what
  // limits how long the shared temporary password is usable.
  const { error: flagError } = await supabase
    .from("profiles")
    .update({ must_change_password: true })
    .eq("id", studentId);

  return NextResponse.json({
    ok: true,
    email: target.email,
    name: target.full_name,
    password: TEMP_PASSWORD,
    warning: flagError
      ? "Password changed, but the force-change flag could not be set: " + flagError.message
      : undefined,
  });
}
