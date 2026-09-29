import { redirect } from "next/navigation";
import Link from "next/link";
import { serverClient } from "@/lib/supabase/server";
import SignOutButton from "@/components/SignOutButton";
import AdminStudents, { type Profile } from "@/components/AdminStudents";
import AdminRegistrations, { type Registration } from "@/components/AdminRegistrations";

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
  if (me?.role !== "admin" && me?.role !== "owner") redirect("/dashboard");

  // Only the owner manages accounts. The page hides that section, and the database
  // functions refuse it too - hiding a button is not a permission.
  const isOwner = me?.role === "owner";

  const [studentsResult, runsResult, eventsResult, regsResult] = await Promise.all([
    isOwner
      ? supabase.from("profiles").select("*").order("created_at", { ascending: false }).limit(500)
      : Promise.resolve({ data: [] as Profile[] }),
    supabase.from("refresh_runs").select("*").order("ran_at", { ascending: false }).limit(10),
    supabase.from("events").select("kind, tracker_status, poster_status, source"),
    // Runs as its owner so student names resolve even though a plain admin cannot
    // read the profiles table; it checks is_admin() for itself.
    supabase.rpc("admin_registrations"),
  ]);

  const students = (studentsResult.data ?? []) as Profile[];
  const runs = (runsResult.data ?? []) as Run[];
  const events = eventsResult.data ?? [];
  const registrations = (regsResult.data ?? []) as Registration[];

  const bySource = events.reduce<Record<string, number>>((acc, event) => {
    const key = (event.source as string) || "unknown";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const lastRun = runs[0];
  const staleHours = lastRun ? (Date.now() - new Date(lastRun.ran_at).getTime()) / 3_600_000 : Infinity;

  return (
    <>
      <div className="topbar">
        <div className="topinner">
          <div className="brand">
            <span className="mark">K</span> {isOwner ? "Owner" : "Admin"}
          </div>
          <nav className="navlinks">
            <Link href="/dashboard">Student view</Link>
            <Link href="/change-password">Change password</Link>
            <span className="who">{me?.full_name || user.email}</span>
            <SignOutButton />
          </nav>
        </div>
      </div>

      <div className="hero">
        <h1>Administration</h1>
        <p className="sub">Accounts, registrations and the nightly refresh.</p>

        <div className="stats">
          {isOwner && (
            <>
              <div className="stat"><b>{students.length}</b><span>Accounts</span></div>
              <div className="stat">
                <b>{students.filter((s) => s.role === "admin" || s.role === "owner").length}</b>
                <span>Admins</span>
              </div>
            </>
          )}
          <div className="stat"><b>{events.length}</b><span>Events</span></div>
          <div className="stat"><b>{events.filter((e) => e.kind === "hiring").length}</b><span>Hiring</span></div>
          <div className="stat"><b>{registrations.length}</b><span>Registrations</span></div>
          <div className="stat"><b>{registrations.filter((r) => r.confirmed).length}</b><span>Confirmed</span></div>
        </div>

        {staleHours > 30 && (
          <div className="msg error" style={{ marginTop: 18 }}>
            The last refresh was {lastRun ? `${Math.round(staleHours)} hours ago` : "never"}. The
            2:00 AM job may have stopped - check the Actions tab in GitHub.
          </div>
        )}
      </div>

      <div className="band">
        <div className="bandhead">
          <h3>Who registered for what <span className="count">{registrations.length}</span></h3>
        </div>
        <p className="sub tablenote">
          Recorded when a student clicks <b>Register Now</b>, which opens the event&apos;s own site.
          So this shows they went to register; <b>Confirmed</b> is set only when the student presses
          &quot;I registered&quot; afterwards.
        </p>
        <AdminRegistrations registrations={registrations} />
      </div>

      {isOwner && (
        <div className="band">
          <div className="bandhead">
            <h3>Accounts <span className="count">{students.length}</span></h3>
          </div>
          <p className="sub tablenote">
            Only you can see this section. <b>Make admin</b> gives someone the registrations,
            refresh log and event figures - but not this table, so they cannot promote anyone
            else or remove you. Your own owner account cannot be changed or deleted here.
          </p>
          <AdminStudents students={students} meId={user.id} />
        </div>
      )}

      <div className="band">
        <div className="bandhead">
          <h3>Nightly refresh</h3>
        </div>
        <div className="tablewrap">
          <table className="table">
            <thead>
              <tr><th>Ran at</th><th>Events</th><th>New</th><th>Hiring</th><th>Errors</th><th>Result</th></tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td>{new Date(run.ran_at).toLocaleString("en-IN")}</td>
                  <td>{run.events_total ?? "-"}</td>
                  <td>{run.events_new ?? "-"}</td>
                  <td>{run.events_hiring ?? "-"}</td>
                  <td>{run.errors ?? 0}</td>
                  <td>
                    <span className={`state ${run.ok ? "live" : "closed"}`}>{run.ok ? "OK" : "FAILED"}</span>
                    {run.note && <div className="venue">{run.note.slice(0, 120)}</div>}
                  </td>
                </tr>
              ))}
              {!runs.length && (
                <tr><td colSpan={6}>No refresh has run yet. Trigger the workflow from GitHub Actions.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="band">
        <div className="bandhead">
          <h3>Events by source</h3>
        </div>
        <div className="tags">
          {Object.entries(bySource)
            .sort((a, b) => b[1] - a[1])
            .map(([source, count]) => (
              <span className="tag" key={source}>{source}: <b>{count}</b></span>
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
