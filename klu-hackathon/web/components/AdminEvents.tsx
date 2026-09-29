"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { browserClient } from "@/lib/supabase/client";

export type ManagedEvent = {
  id: number;
  title: string;
  kind: string;
  source: string | null;
  deadline: string | null;
  url: string | null;
  registration_url: string | null;
  recommended: boolean | null;
};

const COLUMNS = "id,title,kind,source,deadline,url,registration_url,recommended";

/**
 * Owner-only management of the event list: remove ones that should not be there,
 * and correct a link that has moved.
 *
 * Writes go straight to the table - the "owner manages events" policy from 010
 * allows update and delete for the owner and nobody else, so no extra function
 * is needed and the database refuses anyone else regardless of what is sent.
 */
export default function AdminEvents({ events: initial }: { events: ManagedEvent[] }) {
  const router = useRouter();
  const [events, setEvents] = useState(initial);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<number | null>(null);
  const [draftUrl, setDraftUrl] = useState("");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const needle = filter.trim().toLowerCase();
  const rows = needle
    ? events.filter((e) =>
        [e.title, e.source, e.url].join(" ").toLowerCase().includes(needle),
      )
    : events;
  const allShownSelected = rows.length > 0 && rows.every((e) => selected.has(e.id));

  function toggle(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  function toggleAll() {
    // Only the rows on screen, so a filter cannot hide something about to go.
    const next = new Set(selected);
    if (allShownSelected) rows.forEach((e) => next.delete(e.id));
    else rows.forEach((e) => next.add(e.id));
    setSelected(next);
  }

  async function deleteSelected() {
    const ids = [...selected];
    if (!ids.length) return;
    if (
      !confirm(
        `Delete ${ids.length} event${ids.length === 1 ? "" : "s"}?\n\n` +
          "Any student registrations against them are removed too. This cannot be undone.\n\n" +
          "Note: an event the nightly job still finds will come back tomorrow.",
      )
    )
      return;

    setBusy(true);
    setError("");
    setMessage("");
    const { error: deleteError } = await browserClient().from("events").delete().in("id", ids);
    setBusy(false);

    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    setEvents((current) => current.filter((e) => !selected.has(e.id)));
    setSelected(new Set());
    setMessage(`Deleted ${ids.length} event${ids.length === 1 ? "" : "s"}.`);
    router.refresh();
  }

  function startEdit(event: ManagedEvent) {
    setEditing(event.id);
    setDraftUrl(event.url ?? "");
    setError("");
    setMessage("");
  }

  async function saveUrl(id: number) {
    const url = draftUrl.trim();
    if (!/^https?:\/\/\S+$/i.test(url)) {
      setError("That needs to be a full http(s) address.");
      return;
    }
    setBusy(true);
    setError("");
    // Only the two link columns change; everything else about the event is left
    // exactly as it was, including the poster and the dates.
    const { error: updateError } = await browserClient()
      .from("events")
      .update({ url, registration_url: url })
      .eq("id", id);
    setBusy(false);

    if (updateError) {
      setError(updateError.message);
      return;
    }
    setEvents((current) =>
      current.map((e) => (e.id === id ? { ...e, url, registration_url: url } : e)),
    );
    setEditing(null);
    setMessage("Link updated.");
    router.refresh();
  }

  async function reload() {
    setBusy(true);
    const { data } = await browserClient()
      .from("events")
      .select(COLUMNS)
      .order("deadline", { ascending: true, nullsFirst: false })
      .limit(500);
    setEvents((data ?? []) as ManagedEvent[]);
    setBusy(false);
  }

  return (
    <>
      {error && <div className="msg error">{error}</div>}
      {message && <div className="msg ok">{message}</div>}

      <div className="tabletools">
        <input
          type="search"
          className="adminsearch"
          placeholder="Filter by title, source or link..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          type="button"
          className="minibtn danger"
          disabled={!selected.size || busy}
          onClick={deleteSelected}
        >
          {busy ? "Working..." : `Delete selected${selected.size ? ` (${selected.size})` : ""}`}
        </button>
        <button type="button" className="minibtn" onClick={reload} disabled={busy}>
          Reload
        </button>
      </div>

      <div className="tablewrap">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 34 }}>
                <input type="checkbox" checked={allShownSelected} onChange={toggleAll} title="Select all shown" />
              </th>
              <th>Event</th>
              <th>Type</th>
              <th>Deadline</th>
              <th>Link</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((event) => (
              <tr key={event.id} className={selected.has(event.id) ? "picked" : ""}>
                <td>
                  <input type="checkbox" checked={selected.has(event.id)} onChange={() => toggle(event.id)} />
                </td>
                <td>
                  {event.title}
                  <div className="venue">
                    {event.source}
                    {event.recommended ? " · ★ recommended" : ""}
                  </div>
                </td>
                <td>
                  <span className={`state ${event.kind === "hiring" ? "open" : "tba"}`}>
                    {event.kind === "hiring" ? "hiring" : "hackathon"}
                  </span>
                </td>
                <td>{event.deadline ?? "-"}</td>
                <td className="linkcell">
                  {editing === event.id ? (
                    <input
                      className="adminsearch"
                      value={draftUrl}
                      onChange={(e) => setDraftUrl(e.target.value)}
                      placeholder="https://..."
                      autoFocus
                    />
                  ) : (
                    <a href={event.url ?? "#"} target="_blank" rel="noopener noreferrer">
                      {(event.url ?? "").replace(/^https?:\/\//, "").slice(0, 52)}
                    </a>
                  )}
                </td>
                <td>
                  <div className="rowbtns">
                    {editing === event.id ? (
                      <>
                        <button type="button" className="minibtn" disabled={busy} onClick={() => saveUrl(event.id)}>
                          Save
                        </button>
                        <button type="button" className="minibtn" onClick={() => setEditing(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button type="button" className="minibtn" onClick={() => startEdit(event)}>
                        Edit link
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={6}>No events{needle ? " match that filter" : " yet"}.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
