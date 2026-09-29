"use client";

import { useMemo, useState } from "react";
import RegisterButton from "./RegisterButton";

export type Registration = { event_id: number; confirmed: boolean };

export type EventRow = {
  id: number;
  key: string;
  title: string;
  source: string | null;
  kind: string;
  scope: string | null;
  url: string | null;
  registration_url: string | null;
  start_date: string | null;
  end_date: string | null;
  deadline: string | null;
  mode: string | null;
  location: string | null;
  organizer: string | null;
  prize: string | null;
  eligibility: string | null;
  participants: string | null;
  domains: string[] | null;
  categories: string[] | null;
  poster_url: string | null;
  poster_status: string | null;
  tracker_status: string | null;
};

const SCOPE_LABELS: Record<string, string> = {
  global: "Global",
  national: "National (India)",
  regional: "Regional / State",
  campus: "Campus",
  unknown: "Unconfirmed",
};

function today() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function asDate(value: string | null) {
  return value ? new Date(`${value}T00:00:00`) : null;
}

/** Matches _registration_state() in the Python tracker so both views agree. */
function registrationState(event: EventRow): [string, string] {
  const now = today();
  const start = asDate(event.start_date);
  const end = asDate(event.end_date);
  const closing = asDate(event.deadline) ?? end;

  if (closing && closing < now) return ["CLOSED", "closed"];
  if (start && start <= now && now <= (end ?? start)) return ["LIVE", "live"];
  if (closing) {
    const days = Math.round((closing.getTime() - now.getTime()) / 86_400_000);
    return [days <= 7 ? `CLOSES IN ${days} DAY${days === 1 ? "" : "S"}` : "REGISTERING", "open"];
  }
  if (!start && !end) return ["DATES TBA", "tba"];
  return ["UPCOMING", "open"];
}

function EventCard({ event, registration }: { event: EventRow; registration?: Registration }) {
  const [state, stateClass] = registrationState(event);
  const isNew = event.tracker_status === "NEW";
  const hasPoster =
    event.poster_url && (event.poster_status === "ok" || event.poster_status === "thumbnail");
  const tags = (event.domains?.length ? event.domains : event.categories ?? []).slice(0, 4);
  const venue = event.location || (event.mode === "online" ? "Virtual" : "Venue to be announced");

  return (
    <article className="card">
      <div className="media">
        <span className={`flag ${isNew ? "new" : "old"}`}>{isNew ? "NEW" : "OLD"}</span>
        {event.kind === "hiring" && <span className="flag hiring">HIRING</span>}
        {hasPoster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img loading="lazy" src={event.poster_url!} alt={`${event.title} poster`} />
        ) : (
          <div className="noposter">
            <span>{event.title.slice(0, 40)}</span>
          </div>
        )}
      </div>

      <div className="body">
        <div className="venue">{venue.toUpperCase()}</div>
        <h4>{event.title}</h4>

        <div className="priceline">
          <div className={`prize ${event.prize ? "" : "muted"}`}>{event.prize || "Prize TBA"}</div>
          {event.participants && <span className="venue">{event.participants} registered</span>}
          <span className={`state ${stateClass}`}>{state}</span>
        </div>

        <div className="rows">
          <div className="row">
            <span className="k">Dates</span>
            <span className="v">
              <b>{event.start_date || "TBA"}</b> &rarr; <b>{event.end_date || "TBA"}</b>
            </span>
          </div>
          {event.deadline && (
            <div className="row">
              <span className="k">Register by</span>
              <span className="v deadline">{event.deadline}</span>
            </div>
          )}
          <div className="row">
            <span className="k">Mode</span>
            <span className="v">
              {(event.mode ?? "unknown").replace(/^\w/, (c) => c.toUpperCase())} &middot;{" "}
              {SCOPE_LABELS[event.scope ?? "unknown"] ?? event.scope}
            </span>
          </div>
          <div className="row">
            <span className="k">Eligible</span>
            <span className="v">{event.eligibility || "Not stated - check the official page"}</span>
          </div>
          <div className="row">
            <span className="k">Source</span>
            <span className="v">{event.source}</span>
          </div>
        </div>

        <div className="tags">
          {tags.map((tag) => (
            <span className="tag" key={tag}>
              {tag}
            </span>
          ))}
        </div>

        <div className="actions">
          <a className="btn ghost" href={event.url ?? "#"} target="_blank" rel="noopener noreferrer">
            Event page
          </a>
          <RegisterButton
            eventId={event.id}
            initiallyRegistered={Boolean(registration)}
            initiallyConfirmed={Boolean(registration?.confirmed)}
          />
        </div>
      </div>
    </article>
  );
}

function Band({
  title,
  blurb,
  events,
  registrations,
}: {
  title: string;
  blurb: string;
  events: EventRow[];
  registrations: Map<number, Registration>;
}) {
  if (!events.length) return null;
  return (
    <section className="band">
      <div className="bandhead">
        <h3>
          {title} <span className="count">{events.length}</span>
        </h3>
      </div>
      <p className="sub" style={{ marginTop: -8, marginBottom: 14, fontSize: ".88rem" }}>
        {blurb}
      </p>
      <div className="grid">
        {events.map((event) => (
          <EventCard event={event} registration={registrations.get(event.id)} key={event.id} />
        ))}
      </div>
    </section>
  );
}

function Group({
  anchor,
  heading,
  note,
  tone,
  events,
  registrations,
}: {
  anchor: string;
  heading: string;
  note: string;
  tone: string;
  events: EventRow[];
  registrations: Map<number, Registration>;
}) {
  if (!events.length) return null;
  const fresh = events.filter((e) => e.tracker_status === "NEW");
  const seen = events.filter((e) => e.tracker_status !== "NEW");
  return (
    <div className="groupwrap" id={anchor}>
      <div className={`grouphead ${tone}`}>
        <h2>
          {heading} <span className="gcount">{events.length}</span>
        </h2>
        <p>{note}</p>
      </div>
      <Band title="New" blurb="Found for the first time in the latest refresh."
            events={fresh} registrations={registrations} />
      <Band title="Previously seen" blurb="Recorded earlier and still open."
            events={seen} registrations={registrations} />
    </div>
  );
}

export default function EventBoard({
  events,
  registrations = [],
}: {
  events: EventRow[];
  registrations?: Registration[];
}) {
  const [term, setTerm] = useState("");
  const [kind, setKind] = useState<"all" | "open" | "hiring">("all");
  const [status, setStatus] = useState<"all" | "NEW" | "OLD">("all");
  const [mine, setMine] = useState(false);

  const registrationMap = useMemo(
    () => new Map(registrations.map((r) => [r.event_id, r])),
    [registrations],
  );

  const visible = useMemo(() => {
    const needle = term.trim().toLowerCase();
    return events.filter((event) => {
      if (kind !== "all" && (kind === "hiring") !== (event.kind === "hiring")) return false;
      if (status !== "all" && (event.tracker_status ?? "OLD") !== status) return false;
      if (mine && !registrationMap.has(event.id)) return false;
      if (!needle) return true;
      const haystack = [
        event.title,
        event.location,
        event.organizer,
        event.source,
        ...(event.domains ?? []),
        ...(event.categories ?? []),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [events, term, kind, status, mine, registrationMap]);

  const hackathons = visible.filter((e) => e.kind !== "hiring");
  const hiring = visible.filter((e) => e.kind === "hiring");

  return (
    <>
      <div className="toolbar">
        <input
          type="search"
          placeholder="Search by name, college, city, domain..."
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
        <span className="group">
          {(["all", "open", "hiring"] as const).map((value) => (
            <button
              key={value}
              className={`chipbtn ${kind === value ? "on" : ""}`}
              onClick={() => setKind(value)}
              type="button"
            >
              {value === "all" ? "Both" : value === "open" ? "Hackathons" : "Hiring only"}
            </button>
          ))}
        </span>
        <span className="group">
          {(["all", "NEW", "OLD"] as const).map((value) => (
            <button
              key={value}
              className={`chipbtn ${status === value ? "on" : ""}`}
              onClick={() => setStatus(value)}
              type="button"
            >
              {value === "all" ? "All" : value === "NEW" ? "New only" : "Old only"}
            </button>
          ))}
        </span>
        <button
          className={`chipbtn ${mine ? "on" : ""}`}
          onClick={() => setMine(!mine)}
          type="button"
        >
          My registrations{registrations.length ? ` (${registrations.length})` : ""}
        </button>
      </div>

      <Group
        anchor="hackathons"
        heading="Hackathons & competitions"
        note="Open contests you enter to build something and win a prize."
        tone="tone-open"
        events={hackathons}
        registrations={registrationMap}
      />
      <Group
        anchor="hiring"
        heading="Hiring challenges"
        note="Run by companies to recruit. You compete for a job, often against working professionals - check the experience requirements first."
        tone="tone-hiring"
        events={hiring}
        registrations={registrationMap}
      />

      {!visible.length && <p className="empty">Nothing matches that search.</p>}
    </>
  );
}
