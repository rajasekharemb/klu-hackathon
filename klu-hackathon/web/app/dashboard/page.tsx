import { serverClient } from "@/lib/supabase/server";
import { canSeeAdminArea } from "@/lib/roles";
import EventBoard, { type EventRow, type Registration } from "@/components/EventBoard";
import { PAGE_SIZE } from "@/lib/config";
import SignOutButton from "@/components/SignOutButton";

export const dynamic = "force-dynamic"; // always show the latest nightly refresh

export default async function DashboardPage() {
  const supabase = serverClient();

  const [{ data: user }, eventsResult, runResult] = await Promise.all([
    supabase.auth.getUser(),
    // Only the first page, best scored first. The board fetches more on demand -
    // sending all 400+ on every visit was the biggest draw on the egress allowance.
    supabase
      .from("upcoming_events")
      .select("*", { count: "exact" })
      .order("score", { ascending: false })
      .order("deadline", { ascending: true })
      .range(0, (Number(PAGE_SIZE) || 40) - 1),
    supabase.from("refresh_runs").select("*").order("ran_at", { ascending: false }).limit(1),
  ]);

  const events = (eventsResult.data ?? []) as EventRow[];
  const totalEvents = eventsResult.count ?? events.length;
  const lastRun = runResult.data?.[0];

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, roll_no, role")
    .eq("id", user.user?.id ?? "")
    .maybeSingle();

  // RLS restricts this to the signed-in student's own rows.
  const { data: registrationRows } = await supabase
    .from("event_registrations")
    .select("event_id, confirmed");
  const registrations = (registrationRows ?? []) as Registration[];

  // Counted across every open event, not just the page that was sent.
  const [hiringCount, freshCount] = await Promise.all([
    supabase.from("upcoming_events").select("id", { count: "exact", head: true }).eq("kind", "hiring"),
    supabase.from("upcoming_events").select("id", { count: "exact", head: true }).eq("tracker_status", "NEW"),
  ]).then((results) => results.map((r) => r.count ?? 0));

  return (
    <>
      <div className="topbar">
        <div className="topinner">
          <div className="brand">
            <span className="mark">K</span> KLU Hackathon Portal
          </div>
          <nav className="navlinks">
            <a href="#hackathons">Hackathons</a>
            <a href="#hiring">Hiring challenges</a>
            {canSeeAdminArea(profile?.role) && (
              <a className="adminlink" href="/admin">
                Admin
              </a>
            )}
            <span className="who">{profile?.full_name || profile?.roll_no || user.user?.email}</span>
            <a href="/change-password">Change password</a>
            <SignOutButton />
          </nav>
        </div>
      </div>

      <div className="hero">
        <h1>Hackathons &amp; competitions in India</h1>
        <p className="sub">
          Refreshed automatically at 2:00 AM every day. Only events you can still register for are
          shown - anything past its registration deadline drops off automatically. Newly found
          events appear at the top of each section. Always confirm dates and eligibility on the
          official page before applying.
        </p>
        <div className="stats">
          <div className="stat"><b>{totalEvents - hiringCount}</b><span>Hackathons</span></div>
          <div className="stat"><b>{hiringCount}</b><span>Hiring challenges</span></div>
          <div className="stat"><b>{freshCount}</b><span>New</span></div>
          <div className="stat"><b>{totalEvents}</b><span>Open now</span></div>
        </div>
      </div>

      {eventsResult.error && (
        <div className="hero">
          <div className="msg error">
            Could not load events: {eventsResult.error.message}. If this is a fresh install, run
            the schema and let the nightly job populate the table.
          </div>
        </div>
      )}

      <EventBoard initialEvents={events} total={totalEvents} registrations={registrations} />

      <footer>
        {lastRun
          ? `Last refreshed ${new Date(lastRun.ran_at).toLocaleString("en-IN")} - ${lastRun.events_total} events, ${lastRun.events_new} new${lastRun.ok ? "" : " (with errors)"}.`
          : "No refresh has run yet."}{" "}
        Posters are fetched and checked before being shown. Verify details on the official page
        before applying or paying.
      </footer>
    </>
  );
}

