"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import RegisterButton from "./RegisterButton";
import RecommendButton from "./RecommendButton";
import SaveButton from "./SaveButton";
import { SECTION_EVENT } from "./SectionNav";
import { browserClient } from "@/lib/supabase/client";
import { PAGE_SIZE } from "@/lib/config";

export type Registration = { event_id: number; confirmed: boolean };
export type Saved = { event_id: number; expires_at: string };

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
  score?: number | null;
  recommended?: boolean | null;
  recommend_note?: string | null;
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

function EventCard({
  event,
  registration,
  saved,
  canRecommend,
}: {
  event: EventRow;
  registration?: Registration;
  saved?: Saved;
  canRecommend: boolean;
}) {
  const [state, stateClass] = registrationState(event);
  const isNew = event.tracker_status === "NEW";
  const hasPoster =
    event.poster_url && (event.poster_status === "ok" || event.poster_status === "thumbnail");
  const tags = (event.domains?.length ? event.domains : event.categories ?? []).slice(0, 4);
  const venue = event.location || (event.mode === "online" ? "Virtual" : "Venue to be announced");

  const recommended = Boolean(event.recommended);

  return (
    <article className={`card${recommended ? " recommended" : ""}`}>
      <div className="media">
        <span className={`flag ${isNew ? "new" : "old"}`}>{isNew ? "NEW" : "OLD"}</span>
        {recommended && <span className="flag rec">★ RECOMMENDED</span>}
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
        {recommended && event.recommend_note && (
          <p className="recnote">{event.recommend_note}</p>
        )}

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
            href={event.registration_url || event.url || "#"}
            initiallyRegistered={Boolean(registration)}
            initiallyConfirmed={Boolean(registration?.confirmed)}
          />
          <SaveButton
            eventId={event.id}
            initiallySaved={Boolean(saved)}
            expiresAt={saved?.expires_at}
          />
          {canRecommend && <RecommendButton eventId={event.id} initial={recommended} />}
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
  savedMap,
  canRecommend,
}: {
  title: string;
  blurb: string;
  events: EventRow[];
  registrations: Map<number, Registration>;
  savedMap: Map<number, Saved>;
  canRecommend: boolean;
}) {
  if (!events.length) return null;
  return (
    <section className="band">
      <div className="bandhead">
        <h3>
          {title} <span className="count">{events.length}</span>
        </h3>
      </div>
      <p className="sub tablenote">{blurb}</p>
      <div className="grid">
        {events.map((event) => (
          <EventCard
            event={event}
            registration={registrations.get(event.id)}
            saved={savedMap.get(event.id)}
            canRecommend={canRecommend}
            key={event.id}
          />
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
  savedMap,
  canRecommend,
}: {
  anchor: string;
  heading: string;
  note: string;
  tone: string;
  events: EventRow[];
  registrations: Map<number, Registration>;
  savedMap: Map<number, Saved>;
  canRecommend: boolean;
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
      <Band
        title="New"
        blurb="Found for the first time in the latest refresh."
        events={fresh}
        registrations={registrations}
        savedMap={savedMap}
        canRecommend={canRecommend}
      />
      <Band
        title="Previously seen"
        blurb="Recorded earlier and still open."
        events={seen}
        registrations={registrations}
        savedMap={savedMap}
        canRecommend={canRecommend}
      />
    </div>
  );
}

const SELECT_COLUMNS =
  "id,key,title,source,kind,scope,url,registration_url,start_date,end_date,deadline,mode," +
  "location,organizer,prize,eligibility,participants,domains,categories,poster_url," +
  "poster_status,tracker_status,score";

export default function EventBoard({
  initialEvents,
  total,
  registrations = [],
  savedEvents = [],
  canRecommend = false,
}: {
  initialEvents: EventRow[];
  total: number;
  registrations?: Registration[];
  savedEvents?: Saved[];
  canRecommend?: boolean;
}) {
  const [events, setEvents] = useState<EventRow[]>(initialEvents);
  const [term, setTerm] = useState("");
  const [kind, setKind] = useState<"all" | "open" | "hiring">("all");
  const [status, setStatus] = useState<"all" | "NEW" | "OLD">("all");
  const [scope, setScope] = useState<"all" | "mine" | "saved">("all");
  const [loading, setLoading] = useState(false);
  const [exhausted, setExhausted] = useState(initialEvents.length >= total);
  const [error, setError] = useState("");
  const requestId = useRef(0);

  const registrationMap = useMemo(
    () => new Map(registrations.map((r) => [r.event_id, r])),
    [registrations],
  );
  const savedMap = useMemo(() => new Map(savedEvents.map((s) => [s.event_id, s])), [savedEvents]);

  // "My registrations" and "Saved" used to filter whatever happened to be loaded,
  // so an event on page three simply did not appear. The ids go to the query
  // instead, which returns the right set however far down the list they sit.
  const scopeIds = useMemo(() => {
    if (scope === "mine") return registrations.map((r) => r.event_id);
    if (scope === "saved") return savedEvents.map((s) => s.event_id);
    return null;
  }, [scope, registrations, savedEvents]);

  /**
   * Filtering and searching run on the server, not over an array in the browser.
   * With 400+ events, sending them all on every visit was the largest consumer of
   * the database's egress allowance; the page now asks for 60 at a time, best
   * scored first, and fetches more only when the student asks.
   */
  const fetchPage = useCallback(
    async (from: number, replace: boolean) => {
      const ticket = requestId.current + 1;
      requestId.current = ticket;
      const size = Number(PAGE_SIZE) || 40;
      setLoading(true);
      setError("");

      let query = browserClient()
        .from("upcoming_events")
        .select(SELECT_COLUMNS)
        .order("recommended", { ascending: false })
        .order("score", { ascending: false })
        .order("deadline", { ascending: true })
        .range(from, from + size - 1);

      if (kind !== "all") query = query.eq("kind", kind);
      if (status !== "all") query = query.eq("tracker_status", status);
      if (scopeIds) query = query.in("id", scopeIds.length ? scopeIds : [-1]);

      const needle = term.trim();
      if (needle) {
        // Commas and parentheses are separators in PostgREST's or() syntax.
        const safe = needle.replace(/[%,()]/g, " ");
        query = query.or(
          `title.ilike.%${safe}%,location.ilike.%${safe}%,` +
            `organizer.ilike.%${safe}%,source.ilike.%${safe}%`,
        );
      }

      const { data, error: queryError } = await query;
      // A slow earlier request must not overwrite a newer one's results.
      if (requestId.current !== ticket) return;

      if (queryError) {
        setError(queryError.message);
        setLoading(false);
        return;
      }
      const rows = (data ?? []) as unknown as EventRow[];
      setEvents((current) => (replace ? rows : [...current, ...rows]));
      setExhausted(rows.length < size);
      setLoading(false);
    },
    [kind, status, term, scopeIds],
  );

  // The header links pick a section. They also clear any scope filter: asking for
  // "Hackathons" while "My registrations" is on would otherwise show an empty page
  // and look like the link was broken.
  useEffect(() => {
    function onSection(event: Event) {
      const which = (event as CustomEvent<"open" | "hiring">).detail;
      setScope("all");
      setStatus("all");
      setKind(which);
      setTerm("");
      requestAnimationFrame(() =>
        document.getElementById(which === "hiring" ? "hiring" : "hackathons")
          ?.scrollIntoView({ behavior: "smooth", block: "start" }),
      );
    }
    window.addEventListener(SECTION_EVENT, onSection);
    return () => window.removeEventListener(SECTION_EVENT, onSection);
  }, []);

  // Re-query when a filter or the search text changes. The first render is skipped,
  // because it would throw away the rows the server already rendered.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      // Safety net: if the server rendered nothing while the count says there is
      // something, fetch the first page here rather than showing a blank board.
      if (initialEvents.length === 0 && total > 0) fetchPage(0, true);
      return;
    }
    const timer = setTimeout(() => fetchPage(0, true), 250); // debounce typing
    return () => clearTimeout(timer);
  }, [fetchPage, initialEvents.length, total]);

  const shown = events;
  const hackathons = shown.filter((e) => e.kind !== "hiring");
  const hiring = shown.filter((e) => e.kind === "hiring");

  return (
    <>
      <div className="toolbar">
        <input
          type="search"
          placeholder="Search by name, college, city, organiser..."
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
        <span className="group">
          <button
            className={`chipbtn ${scope === "mine" ? "on" : ""}`}
            onClick={() => setScope(scope === "mine" ? "all" : "mine")}
            type="button"
          >
            My registrations{registrations.length ? ` (${registrations.length})` : ""}
          </button>
          <button
            className={`chipbtn ${scope === "saved" ? "on" : ""}`}
            onClick={() => setScope(scope === "saved" ? "all" : "saved")}
            type="button"
          >
            Saved for later{savedEvents.length ? ` (${savedEvents.length})` : ""}
          </button>
        </span>
      </div>

      {error && (
        <div className="band">
          <div className="msg error">Could not load events: {error}</div>
        </div>
      )}

      <Group
        anchor="hackathons"
        heading="Hackathons & competitions"
        note="Open contests you enter to build something and win a prize. Best matches first."
        tone="tone-open"
        events={hackathons}
        registrations={registrationMap}
        savedMap={savedMap}
        canRecommend={canRecommend}
      />
      <Group
        anchor="hiring"
        heading="Hiring challenges"
        note="Run by companies to recruit. You compete for a job, often against working professionals - check the experience requirements first."
        tone="tone-hiring"
        events={hiring}
        registrations={registrationMap}
        savedMap={savedMap}
        canRecommend={canRecommend}
      />

      {!shown.length && !loading && (
        <p className="empty">
          {scope === "mine"
            ? "You have not registered for anything yet."
            : scope === "saved"
              ? "Nothing saved yet - press “Save for later” on a card to keep it here for 30 days."
              : term.trim() || kind !== "all" || status !== "all"
                ? "Nothing matches that search."
                : "No events are open for registration right now."}
        </p>
      )}

      <div className="morewrap">
        {!exhausted && scope === "all" && (
          <button
            className="btn primary showmore"
            type="button"
            disabled={loading}
            onClick={() => fetchPage(events.length, false)}
          >
            {loading ? "Loading..." : `Show ${Math.min(PAGE_SIZE, total - events.length)} more — ${events.length} of ${total} shown`}
          </button>
        )}
        {exhausted && shown.length > 0 && (
          <p className="empty">That is everything &mdash; {shown.length} shown.</p>
        )}
      </div>
    </>
  );
}
