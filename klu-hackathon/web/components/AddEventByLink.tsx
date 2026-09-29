"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { browserClient } from "@/lib/supabase/client";
import PosterField from "./PosterField";

type Draft = {
  url: string;
  title: string;
  kind: "open" | "hiring";
  deadline: string;
  start: string;
  end: string;
  poster_url: string;
  organizer: string;
  location: string;
  description: string;
  prize: string;
  eligibility: string;
};

const EMPTY: Draft = {
  url: "", title: "", kind: "open", deadline: "", start: "", end: "",
  poster_url: "", organizer: "", location: "", description: "", prize: "", eligibility: "",
};

/**
 * Paste a link, the server reads the page, the owner corrects what it got, then it
 * is saved. The two steps are deliberate: what a page advertises in its meta tags
 * is often close but rarely exact, and an event the college puts in front of
 * students should have been looked at by a person first.
 */
export default function AddEventByLink() {
  const router = useRouter();
  const [link, setLink] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [found, setFound] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [warning, setWarning] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  function set<K extends keyof Draft>(field: K, value: Draft[K]) {
    setDraft((current) => (current ? { ...current, [field]: value } : current));
  }

  async function inspect(formEvent: React.FormEvent) {
    formEvent.preventDefault();
    setBusy(true);
    setError("");
    setWarning("");
    setDone("");
    try {
      const response = await fetch("/api/inspect-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: link }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "Could not read that page.");
        setBusy(false);
        return;
      }
      setDraft({ ...EMPTY, ...data, kind: "open" });
      setFound(data.found_dates ?? []);
      setWarning(data.warning ?? "");
    } catch {
      setError("Could not reach that page.");
    }
    setBusy(false);
  }

  async function save() {
    if (!draft) return;
    if (!draft.title.trim()) return setError("A title is required.");
    if (!draft.deadline) return setError("A registration deadline is required - without one the event cannot be shown.");

    setBusy(true);
    setError("");
    const { error: rpcError } = await browserClient().rpc("add_manual_event", {
      p_url: draft.url,
      p_title: draft.title,
      p_kind: draft.kind,
      p_deadline: draft.deadline,
      p_start: draft.start || null,
      p_end: draft.end || null,
      p_poster_url: draft.poster_url || null,
      p_organizer: draft.organizer || null,
      p_location: draft.location || null,
      p_description: draft.description || null,
      p_prize: draft.prize || null,
      p_eligibility: draft.eligibility || null,
    });
    setBusy(false);

    if (rpcError) {
      setError(`${rpcError.message} - has migration 010 been run?`);
      return;
    }
    setDone(`Added "${draft.title}" to ${draft.kind === "hiring" ? "hiring challenges" : "hackathons"}.`);
    setDraft(null);
    setLink("");
    router.refresh();
  }

  return (
    <>
      {error && <div className="msg error">{error}</div>}
      {done && <div className="msg ok">{done}</div>}
      {warning && <div className="msg info">{warning}</div>}

      <form className="tabletools" onSubmit={inspect}>
        <input
          type="url"
          className="adminsearch"
          placeholder="Paste a hackathon link, e.g. https://unstop.com/hackathons/..."
          value={link}
          onChange={(e) => setLink(e.target.value)}
          required
        />
        <button className="minibtn" type="submit" disabled={busy || !link.trim()}>
          {busy && !draft ? "Reading..." : "Read the page"}
        </button>
        {!draft && (
          <button
            className="minibtn"
            type="button"
            disabled={!link.trim()}
            onClick={() => {
              setDraft({ ...EMPTY, url: link.trim() });
              setFound([]);
              setError("");
              setWarning("Filling this in by hand - nothing was read from the page.");
            }}
          >
            Skip and type it in
          </button>
        )}
        {draft && (
          <button
            className="minibtn"
            type="button"
            onClick={() => { setDraft(null); setError(""); setWarning(""); }}
          >
            Cancel
          </button>
        )}
      </form>

      {draft && (
        <div className="draftbox">
          <p className="sub tablenote">
            {warning
              ? "Type in what the page shows. Only the title and the registration deadline are required."
              : "This is what the page gave up. Correct anything wrong - especially the dates, which are read out of the page text and are the most likely to be misread."}
            {found.length > 1 && ` Dates seen on the page: ${found.join(", ")}.`}
          </p>

          <div className="draftgrid">
            <label className="field">
              <span>Title</span>
              <input value={draft.title} onChange={(e) => set("title", e.target.value)} />
            </label>

            <label className="field">
              <span>Goes under</span>
              <select value={draft.kind} onChange={(e) => set("kind", e.target.value as "open" | "hiring")}>
                <option value="open">Hackathons &amp; competitions</option>
                <option value="hiring">Hiring challenges</option>
              </select>
            </label>

            <label className="field">
              <span>Registration deadline *</span>
              <input type="date" value={draft.deadline} onChange={(e) => set("deadline", e.target.value)} />
            </label>

            <label className="field">
              <span>Starts</span>
              <input type="date" value={draft.start} onChange={(e) => set("start", e.target.value)} />
            </label>

            <label className="field">
              <span>Ends</span>
              <input type="date" value={draft.end} onChange={(e) => set("end", e.target.value)} />
            </label>

            <label className="field">
              <span>Organiser</span>
              <input value={draft.organizer} onChange={(e) => set("organizer", e.target.value)} />
            </label>

            <label className="field">
              <span>Location</span>
              <input value={draft.location} onChange={(e) => set("location", e.target.value)} placeholder="City, State or Online" />
            </label>

            <label className="field">
              <span>Prize</span>
              <input value={draft.prize} onChange={(e) => set("prize", e.target.value)} placeholder="e.g. ₹1,00,000" />
            </label>

            <label className="field wide2">
              <span>Who can enter</span>
              <input value={draft.eligibility} onChange={(e) => set("eligibility", e.target.value)} />
            </label>

            <div className="field wide2">
              <span>Poster</span>
              <PosterField value={draft.poster_url} onChange={(next) => set("poster_url", next)} />
            </div>
          </div>

          <div className="tabletools">
            <button className="minibtn" type="button" onClick={save} disabled={busy}>
              {busy ? "Saving..." : `Add to ${draft.kind === "hiring" ? "hiring challenges" : "hackathons"}`}
            </button>
            <a className="minibtn" href={draft.url} target="_blank" rel="noopener noreferrer">
              Open the page
            </a>
          </div>
        </div>
      )}
    </>
  );
}
