import { redirect } from "next/navigation";
import Link from "next/link";
import { serverClient } from "@/lib/supabase/server";
import { canManage, canSeeAdminArea } from "@/lib/roles";
import SignOutButton from "@/components/SignOutButton";
import SiteHeader from "@/components/SiteHeader";
import AdminStudents, { type Profile } from "@/components/AdminStudents";
import AdminRegistrations, { type Registration } from "@/components/AdminRegistrations";
import AddEventByLink from "@/components/AddEventByLink";
import AdminEvents, { type ManagedEvent } from "@/components/AdminEvents";

export const dynamic = "force-dynamic";

type Run = {
  id: number;
  ran_at: string;
  events_total: number | null;
  events_new: number | null;
  events_hiring: number | null;
  errors: number | null;
  ok: boolean;
  note: string | null;
};

export default async function AdminPage() {
  const supabase = serverClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Middleware already gated this, but the page checks again: a redirect is a UI
  // decision, not a security boundary. RLS is what actually protects the rows.
  const { data: me } = await supabase.from("profiles").select("role, full_name").eq("id", user.id).maybeSingle();
  if (!canSeeAdminArea(me?.role)) redirect("/dashboard");

  // Only the owner manages accounts. The page hides that section, and the database
  // functions refuse it too - hiding a button is not a permission.
  const isOwner = canManage(me?.role);

  const [
    accountsCount,
    adminsCount,
    eventsCount,
    hiringCount,
    confirmedCount,
    runResult,
    regsResult,
    statsResult,
  ] = await Promise.all([
      // Counts only - the tables below are searched, not listed, so none of these
      // pull rows the page is never going to show.
      supabase.from("profiles").select("id", { count: "exact", head: true }),
      supabase.from("profiles").select("id", { count: "exact", head: true }).in("role", ["admin", "owner"]),
      supabase.from("events").select("id", { count: "exact", head: true }),
      supabase.from("events").select("id", { count: "exact", head: true }).eq("kind", "hiring"),
      // The real total, not the length of the page below it - the RPC caps at 200.
      supabase
        .from("event_registrations")
        .select("id", { count: "exact", head: true })
        .eq("confirmed", true),
      // Only the most recent run. The older rows were a scrolling log nobody read;
      // what matters is whether last night worked.
      supabase.from("refresh_runs").select("*").order("ran_at", { ascending: false }).limit(1),
      // Confirmed registrations only; a search in the panel goes wider.
      supabase.rpc("admin_registrations", { p_search: null, p_confirmed_only: true, p_limit: 200 }),
      supabase.rpc("admin_event_stats"),
    ]);

  const totalAccounts = accountsCount.count ?? 0;
  const totalAdmins = adminsCount.count ?? 0;
  const totalEvents = eventsCount.count ?? 0;
  const totalHiring = hiringCount.count ?? 0;
  const lastRun = (runResult.data ?? [])[0] as Run | undefined;
  const totalConfirmed = confirmedCount.count ?? 0;
  const registrations = (regsResult.data ?? []) as Registration[];
  // A failed RPC used to render as "0 confirmed", which reads like real data.
  const registrationsError = regsResult.error?.message ?? "";
  const sourceStats = (statsResult.data ?? []) as Array<{ source: string; total: number }>;

  const staleHours = lastRun ? (Date.now() - new Date(lastRun.ran_at).getTime()) / 3_600_000 : Infinity;
  const ranAgo =
    staleHours < 1 ? "less than an hour ago" : `${Math.round(staleHours)} hours ago`;

  return (
    <>
      <SiteHeader
        name="KLU Hackathon Portal"
        eyebrow={
          isOwner
            ? "Owner console · Accounts, events and registrations"
            : "Admin console · Registrations and the nightly refresh"
        }
        who={me?.full_name || user.email}
        crumb={
          <>
            <Link className="crumblink" href="/dashboard">
              Portal
            </Link>
            <span className="crumbsep">&rsaquo;</span>
            <span className="crumb">{isOwner ? "Owner" : "Admin"}</span>
          </>
        }
        actions={
          <>
            <Link className="doclink secondary" href="/dashboard">
              Student view
            </Link>
            <Link className="doclink secondary" href="/change-password">
              Change password
            </Link>
            <SignOutButton />
          </>
        }
      />

      <div className="hero">
        <h1>Administration</h1>
        <p className="sub">Accounts, registrations and the nightly refresh.</p>

        <div className="stats">
          {isOwner && (
            <>
              <div className="stat"><b>{totalAccounts}</b><span>Accounts</span></div>
              <div className="stat"><b>{totalAdmins}</b><span>Admins</span></div>
            </>
          )}
          <div className="stat"><b>{totalEvents}</b><span>Events</span></div>
          <div className="stat"><b>{totalHiring}</b><span>Hiring</span></div>
          <div className="stat"><b>{totalConfirmed}</b><span>Confirmed</span></div>
        </div>

        {staleHours > 30 && (
          <div className="msg error" style={{ marginTop: 18 }}>
            The last refresh was {lastRun ? `${Math.round(staleHours)} hours ago` : "never"}. The
            2:00 AM job may have stopped - check the Actions tab in GitHub.
          </div>
        )}
      </div>

      {isOwner && (
        <div className="band">
          <div className="bandhead">
            <h3>Add an event by link</h3>
          </div>
          <p className="sub tablenote">
            Paste the link to a hackathon or hiring challenge the nightly job has not picked up.
            The page is read for its title, dates and poster; you correct anything wrong before it
            is saved. A registration deadline is required, because the portal only shows events
            students can still enter.
          </p>
          <AddEventByLink />
        </div>
      )}

      {isOwner && (
        <div className="band">
          <div className="bandhead">
            <h3>Manage events <span className="count">{totalEvents}</span></h3>
          </div>
          <p className="sub tablenote">
            Remove events that should not be listed, or correct a link that has moved -
            editing the link changes only that, everything else about the event stays as it is.
            An event the nightly job still finds will reappear tomorrow; to keep it out for good,
            take it down at the source or leave it recommended-off.
          </p>
          <AdminEvents total={totalEvents} />
        </div>
      )}

      <div className="band">
        <div className="bandhead">
          <h3>Confirmed registrations <span className="count">{totalConfirmed}</span></h3>
        </div>
        <p className="sub tablenote">
          Students who pressed &quot;I registered&quot; after filling the KLU form. Clicks that were
          never confirmed are not listed - search by roll number, name or event to see those too.
          {!isOwner && " This list is read-only - only the owner can remove records."}
        </p>
        {registrationsError ? (
          <div className="msg error">
            Could not load registrations: {registrationsError}. If this mentions a function or
            its arguments, migrations 012 and 013 have not been run yet - this is not an empty
            list, it is a failed query.
          </div>
        ) : (
          <AdminRegistrations registrations={registrations} canEdit={isOwner} />
        )}
      </div>

      {isOwner && (
        <div className="band">
          <div className="bandhead">
            <h3>Accounts <span className="count">{totalAccounts}</span></h3>
          </div>
          <p className="sub tablenote">
            Only you can see this section. <b>Make admin</b> gives someone the registrations,
            refresh log and event figures - but not this table, so they cannot promote anyone
            else or remove you. Your own owner account cannot be changed or deleted here.
          </p>
          <AdminStudents total={totalAccounts} adminCount={totalAdmins} meId={user.id} />
        </div>
      )}

      <div className="band">
        <div className="bandhead">
          <h3>Nightly refresh</h3>
        </div>
        {lastRun ? (
          <div className="runcard">
            <div className="runhead">
              <span className={`state ${lastRun.ok ? "live" : "closed"}`}>
                {lastRun.ok ? "OK" : "FAILED"}
              </span>
              <b>{new Date(lastRun.ran_at).toLocaleString("en-IN")}</b>
              <span className="venue">{ranAgo}</span>
            </div>
            <div className="runstats">
              <div><b>{lastRun.events_total ?? "-"}</b><span>Events</span></div>
              <div><b>{lastRun.events_new ?? "-"}</b><span>New</span></div>
              <div><b>{lastRun.events_hiring ?? "-"}</b><span>Hiring</span></div>
              <div><b>{lastRun.errors ?? 0}</b><span>Errors</span></div>
            </div>
            {lastRun.note && <p className="sub tablenote">{lastRun.note}</p>}
          </div>
        ) : (
          <p className="empty">No refresh has run yet. Trigger the workflow from GitHub Actions.</p>
        )}
      </div>

      <div className="band">
        <div className="bandhead">
          <h3>Events by source</h3>
        </div>
        <div className="tags">
          {sourceStats.map((row) => (
            <span className="tag" key={row.source}>{row.source}: <b>{row.total}</b></span>
          ))}
        </div>
      </div>

      <footer>
        Admin view. Student records are personal data - only look at what you need, and do not
        share exports. Deletions here are immediate and cannot be undone.
      </footer>
    </>
  );
}
