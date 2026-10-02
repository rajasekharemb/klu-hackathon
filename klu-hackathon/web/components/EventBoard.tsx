"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import RegisterButton from "./RegisterButton";
import RecommendButton from "./RecommendButton";
import SaveButton from "./SaveButton";
import Pager from "./Pager";
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

type Kind = "all" | "open" | "hiring";
type Status = "all" | "NEW" | "OLD";
type Scope = "all" | "mine" | "saved";
type Sort = "best" | "soon" | "new";

const SCOPE_LABELS: Record<string, string> = {
  global: "Global",
  national: "National (India)",
  regional: "Regional / State",
  campus: "Campus",
  unknown: "Unconfirmed",
};

const SORT_LABELS: Record<Sort, string> = {
  best: "Best match",
  soon: "Closing soon",
  new: "Newest found",
};

function today() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function asDate(value: string | null) {
  return value ? new Date(`${value}T00:00:00`) : null;
}

/** A date as "5 Oct 2026". The raw 2026-10-05 reads like a serial number on a card. */
function pretty(value: string | null) {
  const date = asDate(value);
  if (!date) return "TBA";
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
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
    return [days <= 7 ? `${days} DAY${days === 1 ? "" : "S"} LEFT` : "REGISTERING", "open"];
  }
  if (!start && !end) return ["DATES TBA", "tba"];
  return ["UPCOMING", "open"];
}

/**
 * A card shows the four things a student decides on - what it is, when it closes,
 * where it runs and what it pays - and keeps the rest behind "More details".
 * Printing all nine fields made every card tall enough that four of them filled
 * the screen, which is what made the board tiring to read.
 */
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
  const [open, setOpen] = useState(false);
  const [state, stateClass] = registrationState(event);
  const isNew = event.tracker_status === "NEW";
  const hasPoster =
    event.poster_url && (event.poster_status === "ok" || event.poster_status === "thumbnail");
  const tags = (event.domains?.length ? event.domains : event.categories ?? []).slice(0, 3);
  const venue = event.location || (event.mode === "online" ? "Virtual" : "Venue to be announced");
  const recommended = Boolean(event.recommended);

  return (
    <article className={`card${recommended ? " recommended" : ""}`}>
      <div className="media">
        <span className={`flag ${isNew ? "new" : "old"}`}>{isNew ? "NEW" : "OLD"}</span>
        {recommended && <span className="flag rec">&#9733; PICK</span>}
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
        <h4 title={event.title}>{event.title}</h4>
        {recommended && event.recommend_note && <p className="recnote">{event.recommend_note}</p>}

        <div className="priceline">
          <div className={`prize ${event.prize ? "" : "muted"}`}>{event.prize || "Prize TBA"}</div>
          <span className={`state ${stateClass}`}>{state}</span>
        </div>

        <div className="rows">
          <div className="row">
            <span className="k">Dates</span>
            <span className="v">
              {pretty(event.start_date)} &rarr; {pretty(event.end_date)}
            </span>
          </div>
          <div className="row">
            <span className="k">Register by</span>
            <span className={`v ${event.deadline ? "deadline" : ""}`}>{pretty(event.deadline)}</span>
          </div>

          {open && (
            <>
              <div className="row">
                <span className="k">Mode</span>
                <span className="v">
                  {(event.mode ?? "unknown").replace(/^\w/, (c) => c.toUpperCase())} &middot;{" "}
                  {SCOPE_LABELS[event.scope ?? "unknown"] ?? event.scope}
                </span>
              </div>
              <div className="row">
                <span className="k">Eligible</span>
                <span className="v">
                  {event.eligibility || "Not stated - check the official page"}
                </span>
              </div>
              {event.organizer && (
                <div className="row">
                  <span className="k">Host</span>
                  <span className="v">{event.organizer}</span>
                </div>
              )}
              {event.participants && (
                <div className="row">
                  <span className="k">Signed up</span>
                  <span className="v">{event.participants}</span>
                </div>
              )}
              <div className="row">
                <span className="k">Source</span>
                <span className="v">{event.source}</span>
              </div>
              {tags.length > 0 && (
                <div className="tags">
                  {tags.map((tag) => (
                    <span className="tag" key={tag}>
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <button type="button" className="morelink" onClick={() => setOpen(!open)}>
          {open ? "Less" : "More details"}
        </button>

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

const SELECT_COLUMNS =
  "id,key,title,source,kind,scope,url,registration_url,start_date,end_date,deadline,mode," +
  "location,organizer,prize,eligibility,participants,domains,categories,poster_url," +
  "poster_status,tracker_status,score,recommended,recommend_note";

export default function EventBoard({
  initialEvents,
  total: initialTotal,
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
  const [total, setTotal] = useState(initialTotal);
  const [page, setPage] = useState(0);
  const [term, setTerm] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const [status, setStatus] = useState<Status>("all");
  const [scope, setScope] = useState<Scope>("all");
  const [sort, setSort] = useState<Sort>("best");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(0);

  const size = Number(PAGE_SIZE) || 10;
  const pageCount = Math.max(1, Math.ceil(total / size));

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
   * One page at a time, filtered and sorted in the database. With 400+ events,
   * sending them all on every visit was the largest draw on the egress allowance,
   * and the count comes back alongside the rows, so the pager knows how many pages
   * there are without a second query.
   */
  const fetchPage = useCallback(
    async (which: number) => {
      const ticket = requestId.current + 1;
      requestId.current = ticket;
      setLoading(true);
      setError("");

      let query = browserClient().from("upcoming_events").select(SELECT_COLUMNS, { count: "exact" });

      // Recommended events stay pinned above the rest whichever sort is chosen -
      // that is the whole point of an admin recommending one.
      query = query.order("recommended", { ascending: false });
      if (sort === "soon") {
        query = query.order("deadline", { ascending: true, nullsFirst: false });
      } else if (sort === "new") {
        // "NEW" sorts before "OLD" alphabetically, so ascending puts the freshly
        // found events first.
        query = query
          .order("tracker_status", { ascending: true })
          .order("score", { ascending: false });
      } else {
        query = query
          .order("score", { ascending: false })
          .order("deadline", { ascending: true, nullsFirst: false });
      }

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

      const { data, count, error: queryError } = await query.range(
        which * size,
        which * size + size - 1,
      );
      // A slow earlier request must not overwrite a newer one's results.
      if (requestId.current !== ticket) return;

      if (queryError) {
        setError(queryError.message);
        setLoading(false);
        return;
      }
      setEvents((data ?? []) as unknown as EventRow[]);
      setTotal(count ?? 0);
      setLoading(false);
    },
    [kind, status, term, scopeIds, sort, size],
  );

  function goTo(next: number) {
    setPage(next);
    fetchPage(next);
    document.getElementById("board")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

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
        document.getElementById("board")?.scrollIntoView({ behavior: "smooth", block: "start" }),
      );
    }
    window.addEventListener(SECTION_EVENT, onSection);
    return () => window.removeEventListener(SECTION_EVENT, onSection);
  }, []);

  // Re-query when a filter, the sort or the search text changes, always from page
  // one - page 5 of the previous result set means nothing in the new one. The first
  // render is skipped, because it would throw away the rows the server rendered.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      // Safety net: if the server rendered nothing while the count says there is
      // something, fetch the first page here rather than showing a blank board.
      if (initialEvents.length === 0 && initialTotal > 0) fetchPage(0);
      return;
    }
    setPage(0);
    const timer = setTimeout(() => fetchPage(0), 250); // debounce typing
    return () => clearTimeout(timer);
  }, [fetchPage, initialEvents.length, initialTotal]);

  const heading =
    scope === "mine"
      ? "My registrations"
      : scope === "saved"
        ? "Saved for later"
        : kind === "hiring"
          ? "Hiring challenges"
          : kind === "open"
            ? "Hackathons & competitions"
            : "Hackathons & hiring challenges";

  const note =
    kind === "hiring"
      ? "Run by companies to recruit. You compete for a job, often against working professionals - check the experience requirements first."
      : "Open contests you enter to build something and win a prize.";

  const firstOnPage = total === 0 ? 0 : page * size + 1;
  const lastOnPage = Math.min(total, page * size + events.length);

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

      <div className="boardwrap" id="board">
        <div className="boardhead">
          <div>
            <h2>
              {heading} <span className="gcount">{total}</span>
            </h2>
            <p>{note}</p>
          </div>
          <label className="sortpick">
            <span>Sort</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              {(Object.keys(SORT_LABELS) as Sort[]).map((value) => (
                <option key={value} value={value}>
                  {SORT_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
        </div>

        {error && <div className="msg error">Could not load events: {error}</div>}

        {events.length > 0 && (
          <p className="pagenote">
            Showing <b>{firstOnPage}</b>&ndash;<b>{lastOnPage}</b> of <b>{total}</b> &middot; page{" "}
            {page + 1} of {pageCount}
          </p>
        )}

        <div className={`grid${loading ? " busy" : ""}`}>
          {events.map((event) => (
            <EventCard
              event={event}
              registration={registrationMap.get(event.id)}
              saved={savedMap.get(event.id)}
              canRecommend={canRecommend}
              key={event.id}
            />
          ))}
        </div>

        {!events.length && !loading && (
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

        <Pager page={page} pageCount={pageCount} onChange={goTo} busy={loading} label="Event pages" />
      </div>
    </>
  );
}
