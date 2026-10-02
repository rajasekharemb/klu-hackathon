"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { browserClient } from "@/lib/supabase/client";
import Pager from "./Pager";
import { ADMIN_PAGE_SIZE } from "@/lib/config";

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
  first_clicked_at: string;
  last_clicked_at: string;
  times_clicked: number;
  confirmed: boolean;
  confirmed_at: string | null;
};

export default function AdminRegistrations({
  registrations: initial,
  canEdit,
}: {
  registrations: Registration[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [registrations, setRegistrations] = useState<Registration[]>(initial);
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);

  // Ten at a time. The whole result set is already in the browser, so paging here
  // is a slice rather than another round trip - what it buys is a readable table
  // instead of two hundred rows in one scroll.
  const size = Number(ADMIN_PAGE_SIZE) || 10;
  const pageCount = Math.max(1, Math.ceil(registrations.length / size));
  const rows = registrations.slice(page * size, page * size + size);

  /**
   * Confirmed entries are what the page shows. A search goes wider and includes
   * the ones a student clicked but never confirmed - the filtering happens in the
   * database, so unconfirmed rows are not sent and then hidden.
   */
  async function search(formEvent?: React.FormEvent) {
    formEvent?.preventDefault();
    setBusy(true);
    setError("");
    const needle = filter.trim();
    const { data, error: queryError } = await browserClient().rpc("admin_registrations", {
      p_search: needle || null,
      p_confirmed_only: !needle,
      p_limit: 200,
    });
    setBusy(false);
    setSearched(Boolean(needle));
    if (queryError) {
      setError(`${queryError.message} - has migration 012 been run?`);
      return;
    }
    setRegistrations((data ?? []) as Registration[]);
    setSelected(new Set());
    setPage(0);
  }

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
    await search();
    router.refresh();
  }

  return (
    <>
      {error && <div className="msg error">{error}</div>}

      <form className="tabletools" onSubmit={search}>
        <input
          type="search"
          className="adminsearch"
          placeholder="Search any registration by roll number, name or event..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button type="submit" className="minibtn" disabled={busy}>
          {busy ? "Searching..." : "Search"}
        </button>
        {searched && (
          <button
            type="button"
            className="minibtn"
            onClick={() => { setFilter(""); setSearched(false); setRegistrations(initial); setPage(0); }}
          >
            Show confirmed only
          </button>
        )}
        {canEdit && (
          <button
            type="button"
            className="minibtn danger"
            disabled={!selected.size || busy}
            onClick={deleteSelected}
          >
            {busy ? "Deleting..." : `Delete selected${selected.size ? ` (${selected.size})` : ""}`}
          </button>
        )}
      </form>

      {registrations.length > 0 && (
        <p className="pagenote">
          Showing <b>{page * size + 1}</b>&ndash;<b>{Math.min(registrations.length, page * size + rows.length)}</b>{" "}
          of <b>{registrations.length}</b>
          {registrations.length >= 200 && " (first 200 - narrow it with a search)"}
        </p>
      )}

      <div className="tablewrap">
        <table className="table">
          <thead>
            <tr>
              {canEdit && (
                <th style={{ width: 34 }}>
                  <input
                    type="checkbox"
                    checked={allShownSelected}
                    onChange={toggleAll}
                    title="Select all shown"
                  />
                </th>
              )}
              <th>Student</th><th>Roll no</th><th>Event</th>
              <th>Type</th><th>Clicked</th><th>Times</th><th>Confirmed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={canEdit && selected.has(row.id) ? "picked" : ""}>
                {canEdit && (
                  <td>
                    <input type="checkbox" checked={selected.has(row.id)} onChange={() => toggle(row.id)} />
                  </td>
                )}
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
                  {row.confirmed && row.confirmed_at && (
                    <div className="venue">{new Date(row.confirmed_at).toLocaleString("en-IN")}</div>
                  )}
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={canEdit ? 8 : 7}>
                  {searched ? "Nothing matched that search." : "No confirmed registrations yet."}
                </td></tr>
            )}
          </tbody>
        </table>
      </div>

      <Pager page={page} pageCount={pageCount} onChange={setPage} busy={busy} label="Registration pages" />
    </>
  );
}
