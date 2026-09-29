"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { browserClient } from "@/lib/supabase/client";

export type Registration = {
  id: number;
  student_name: string | null;
  roll_no: string | null;
  student_email: string;
  branch: string | null;
  year: number | null;
  event_title: string;
  source: string | null;
  kind: string;
  event_url: string | null;
  last_clicked_at: string;
  times_clicked: number;
  confirmed: boolean;
};

export default function AdminRegistrations({ registrations }: { registrations: Registration[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");

  const needle = filter.trim().toLowerCase();
  const rows = needle
    ? registrations.filter((r) =>
        [r.student_name, r.roll_no, r.student_email, r.event_title, r.source]
          .join(" ")
          .toLowerCase()
          .includes(needle),
      )
    : registrations;

  const allShownSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  function toggle(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  function toggleAll() {
    // Only ever affects the rows currently visible, so a filter cannot hide a row
    // that is about to be deleted.
    const next = new Set(selected);
    if (allShownSelected) rows.forEach((r) => next.delete(r.id));
    else rows.forEach((r) => next.add(r.id));
    setSelected(next);
  }

  async function deleteSelected() {
    const ids = [...selected];
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} registration record${ids.length === 1 ? "" : "s"}?\n\nThis cannot be undone.`)) return;

    setBusy(true);
    setError("");
    const { error: delError } = await browserClient()
      .from("event_registrations")
      .delete()
      .in("id", ids);
    setBusy(false);

    if (delError) {
      setError(`${delError.message} - has migration 004 been run?`);
      return;
    }
    setSelected(new Set());
    router.refresh();
  }

  return (
    <>
      {error && <div className="msg error">{error}</div>}

      <div className="tabletools">
        <input
          type="search"
          className="adminsearch"
          placeholder="Filter by student, roll number or event..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          type="button"
          className="minibtn danger"
          disabled={!selected.size || busy}
          onClick={deleteSelected}
        >
          {busy ? "Deleting..." : `Delete selected${selected.size ? ` (${selected.size})` : ""}`}
        </button>
      </div>

      <div className="tablewrap">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 34 }}>
                <input
                  type="checkbox"
                  checked={allShownSelected}
                  onChange={toggleAll}
                  title="Select all shown"
                />
              </th>
              <th>Student</th><th>Roll no</th><th>Event</th>
              <th>Type</th><th>Clicked</th><th>Times</th><th>Confirmed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={selected.has(row.id) ? "picked" : ""}>
                <td>
                  <input type="checkbox" checked={selected.has(row.id)} onChange={() => toggle(row.id)} />
                </td>
                <td>
                  {row.student_name || "-"}
                  <div className="venue">{row.student_email}</div>
                </td>
                <td>{row.roll_no || "-"}</td>
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
            {!rows.length && (
              <tr><td colSpan={8}>No registrations{needle ? " match that filter" : " yet"}.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
