import { serverClient } from "@/lib/supabase/server";
import { canSeeAdminArea } from "@/lib/roles";
import EventBoard, { type EventRow, type Registration, type Saved } from "@/components/EventBoard";
import { PAGE_SIZE } from "@/lib/config";
import SignOutButton from "@/components/SignOutButton";
import SiteHeader from "@/components/SiteHeader";
import SectionNav from "@/components/SectionNav";

export const dynamic = "force-dynamic"; // always show the latest nightly refresh

export default async function DashboardPage() {
  const supabase = serverClient();

  const [{ data: user }, eventsResult, runResult] = await Promise.all([
    supabase.auth.getUser(),
    // Only the first page, best scored first. The board pages through the rest on
    // demand - sending all 400+ on every visit was the biggest draw on the egress
    // allowance. This ordering has to match the board's default sort, or page one
    // would change the moment the browser took over.
    supabase
      .from("upcoming_events")
      .select("*", { count: "exact" })
      .order("recommended", { ascending: false })
      .order("score", { ascending: false })
      .order("deadline", { ascending: true, nullsFirst: false })
      .range(0, (Number(PAGE_SIZE) || 12) - 1),
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

  // Only entries still within their 30 days. An expired save vanishes the moment
  // it lapses, whether or not the purge has run yet.
  const { data: savedRows } = await supabase
    .from("saved_events")
    .select("event_id, expires_at")
    .gt("expires_at", new Date().toISOString());
  const savedEvents = (savedRows ?? []) as Saved[];

  // What "My registrations" will show: confirmed entries whose event finished less
  // than 15 days ago. Counting every confirmed row instead would promise a longer
  // list than the filter delivers.
  const { count: myCount } = await supabase
    .from("my_registrations")
    .select("id", { count: "exact", head: true });

  // Counted across every open event, not just the page that was sent.
  const [hiringCount, freshCount] = await Promise.all([
    supabase.from("upcoming_events").select("id", { count: "exact", head: true }).eq("kind", "hiring"),
    supabase.from("upcoming_events").select("id", { count: "exact", head: true }).eq("tracker_status", "NEW"),
  ]).then((results) => results.map((r) => r.count ?? 0));

  return (
    <>
      <SiteHeader
        name="KLU Hackathon Portal"
        eyebrow="KL Deemed to be University · Student opportunities"
        who={profile?.full_name || profile?.roll_no || user.user?.email}
        crumb={
          <>
            <span className="crumb">Portal</span>
            <span className="crumbsep">&rsaquo;</span>
            <SectionNav />
          </>
        }
        actions={
          <>
            {canSeeAdminArea(profile?.role) && (
              <a className="doclink" href="/admin">
                Admin
              </a>
            )}
            <a className="doclink secondary" href="/change-password">
              Change password
            </a>
            <SignOutButton />
          </>
        }
      />

      <div className="hero">
        <h1>
          Hackathons &amp; competitions <em>across India</em>
        </h1>
        <p className="sub">
          Refreshed daily at 2:00 AM; closed events drop off by themselves. Always confirm the
          details on the official page before you apply.
        </p>
        <div className="mastmeta">
          <span className="metaitem"><strong>{totalEvents - hiringCount}</strong><span>hackathons</span></span>
          <span className="metadot">&middot;</span>
          <span className="metaitem"><strong>{hiringCount}</strong><span>hiring challenges</span></span>
          <span className="metadot">&middot;</span>
          <span className="metaitem"><strong>{freshCount}</strong><span>found this week</span></span>
          <span className="metadot">&middot;</span>
          <span className="metaitem"><strong>{totalEvents}</strong><span>open now</span></span>
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

      <EventBoard
        initialEvents={events}
        total={totalEvents}
        registrations={registrations}
        savedEvents={savedEvents}
        myCount={myCount ?? 0}
        canRecommend={canSeeAdminArea(profile?.role)}
      />

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

