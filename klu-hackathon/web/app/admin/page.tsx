import { redirect } from "next/navigation";
import Link from "next/link";
import { serverClient } from "@/lib/supabase/server";
import SignOutButton from "@/components/SignOutButton";

export const dynamic = "force-dynamic";

type Profile = {
  id: string;
  email: string;
  roll_no: string | null;
  full_name: string | null;
  branch: string | null;
  year: number | null;
  role: string;
  created_at: string;
};

type Registration = {
  id: number;
  student_name: string | null;
  roll_no: string | null;
  student_email: string;
  branch: string | null;
  year: number | null;
  event_title: string;
  source: string | null;
  kind: string;
  start_date: string | null;
  deadline: string | null;
  event_url: string | null;
  first_clicked_at: string;
  last_clicked_at: string;
  times_clicked: number;
  confirmed: boolean;
};

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
  if (me?.role !== "admin") redirect("/dashboard");

  const [studentsResult, runsResult, eventsResult, regsResult] = await Promise.all([
    supabase.from("profiles").select("*").order("created_at", { ascending: false }).limit(500),
    supabase.from("refresh_runs").select("*").order("ran_at", { ascending: false }).limit(10),
    supabase.from("events").select("kind, tracker_status, poster_status, source"),
    supabase
      .from("registration_report")
      .select("*")
      .order("last_clicked_at", { ascending: false })
      .limit(500),
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
            <span className="mark">K</span> Admin
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
        <p className="sub">Registered students, the nightly refresh, and what the tracker is finding.</p>

        <div className="stats">
          <div className="stat"><b>{students.length}</b><span>Accounts</span></div>
          <div className="stat"><b>{students.filter((s) => s.role === "admin").length}</b><span>Admins</span></div>
          <div className="stat"><b>{events.length}</b><span>Events</span></div>
          <div className="stat"><b>{events.filter((e) => e.kind === "hiring").length}</b><span>Hiring</span></div>
          <div className="stat"><b>{events.filter((e) => e.tracker_status === "NEW").length}</b><span>New</span></div>
          <div className="stat"><b>{registrations.length}</b><span>Registrations</span></div>
          <div className="stat"><b>{registrations.filter((r) => r.confirmed).length}</b><span>Confirmed</span></div>
        </div>

        {staleHours > 30 && (
          <div className="msg error" style={{ marginTop: 18 }}>
            The last refresh was{" "}
            {lastRun ? `${Math.round(staleHours)} hours ago` : "never"}. The 2:00 AM job may have
            stopped - check the Actions tab in GitHub.
          </div>
        )}
      </div>

      <div className="band">
        <div className="bandhead">
          <h3>
            Who registered for what <span className="count">{registrations.length}</span>
          </h3>
        </div>
        <p className="sub" style={{ fontSize: ".85rem", marginTop: -6, marginBottom: 12 }}>
          Recorded when a student clicks <b>Register Now</b>. That opens the event&apos;s own site,
          so it shows the student went to register - <b>Confirmed</b> is set only when the student
          ticks &quot;I registered&quot; afterwards.
        </p>
        <div className="tablewrap">
          <table className="table">
            <thead>
              <tr>
                <th>Student</th><th>Roll no</th><th>Branch</th><th>Event</th>
                <th>Type</th><th>Clicked</th><th>Times</th><th>Confirmed</th>
              </tr>
            </thead>
            <tbody>
              {registrations.map((row) => (
                <tr key={row.id}>
                  <td>{row.student_name || "-"}<div className="venue">{row.student_email}</div></td>
                  <td>{row.roll_no || "-"}</td>
                  <td>{row.branch || "-"}{row.year ? ` / Y${row.year}` : ""}</td>
                  <td>
                    {row.event_url ? (
                      <a href={row.event_url} target="_blank" rel="noopener noreferrer">{row.event_title}</a>
                    ) : (
                      row.event_title
                    )}
                    <div className="venue">{row.source}</div>
                  </td>
                  <td>
                    <span className={`state ${row.kind === "hiring" ? "open" : "tba"}`}>
                      {row.kind === "hiring" ? "hiring" : "hackathon"}
                    </span>
                  </td>
                  <td>{new Date(row.last_clicked_at).toLocaleString("en-IN")}</td>
                  <td>{row.times_clicked}</td>
                  <td>
                    <span className={`state ${row.confirmed ? "live" : "closed"}`}>
                      {row.confirmed ? "YES" : "not yet"}
                    </span>
                  </td>
                </tr>
              ))}
              {!registrations.length && (
                <tr><td colSpan={8}>No student has clicked Register Now yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="band">
        <div className="bandhead">
          <h3>Nightly refresh</h3>
        </div>
        <div className="tablewrap">
          <table className="table">
            <thead>
              <tr>
                <th>Ran at</th><th>Events</th><th>New</th><th>Hiring</th><th>Errors</th><th>Result</th>
              </tr>
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
              <span className="tag" key={source}>
                {source}: <b>{count}</b>
              </span>
            ))}
        </div>
      </div>

      <div className="band">
        <div className="bandhead">
          <h3>
            Registered students <span className="count">{students.length}</span>
          </h3>
        </div>
        <div className="tablewrap">
          <table className="table">
            <thead>
              <tr>
                <th>Roll no</th><th>Name</th><th>Email</th><th>Branch</th><th>Year</th><th>Role</th><th>Registered</th>
              </tr>
            </thead>
            <tbody>
              {students.map((student) => (
                <tr key={student.id}>
                  <td>{student.roll_no || "-"}</td>
                  <td>{student.full_name || "-"}</td>
                  <td>{student.email}</td>
                  <td>{student.branch || "-"}</td>
                  <td>{student.year ?? "-"}</td>
                  <td>
                    <span className={`state ${student.role === "admin" ? "open" : "tba"}`}>{student.role}</span>
                  </td>
                  <td>{new Date(student.created_at).toLocaleDateString("en-IN")}</td>
                </tr>
              ))}
              {!students.length && <tr><td colSpan={7}>Nobody has registered yet.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="sub" style={{ fontSize: ".85rem", marginTop: 12 }}>
          Exporting or deleting accounts is deliberately not offered here. Do it in the Supabase
          dashboard, where the action is logged against your account.
        </p>
      </div>

      <footer>
        Admin view. Student records are personal data - only look at what you need, and do not
        share exports.
      </footer>
    </>
  );
}
