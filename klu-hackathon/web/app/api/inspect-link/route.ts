import { NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/roles";

/**
 * Reads a pasted event link and returns what it can find: title, poster, dates,
 * organiser. The owner checks the result and saves it - nothing is written here.
 *
 * Two attempts, in order:
 *
 *   1. fetch the page directly. Fast, nothing leaves our server but the request,
 *      and it works for the sites that serve real og: tags - Unstop, Devfolio,
 *      HackIndia, Devpost, MLH.
 *
 *   2. if that is refused or comes back an empty shell, ask a rendering proxy
 *      (r.jina.ai) for the page as text. Some event sites sit behind Cloudflare,
 *      which returns 403 to any datacenter IP, and some are JavaScript apps whose
 *      HTML carries a title and nothing else. Neither can be read directly at all.
 *      Only the public URL is sent, and only when attempt 1 has already failed.
 *
 * This fetches a URL chosen by a user from our server, so it is deliberately
 * narrow: signed-in owners only, http(s) only, no private or loopback hosts, hard
 * timeouts, and a capped read.
 */

const MAX_BYTES = 600_000;
const DIRECT_TIMEOUT_MS = 12_000;
const READER_TIMEOUT_MS = 25_000;
const READER = "https://r.jina.ai/";

const BLOCKED_HOSTS = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?)/i;

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-IN,en;q=0.9",
  "Upgrade-Insecure-Requests": "1",
};

function safeUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.test(host)) return null;
  if (host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) return null;
  return url;
}

function decode(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#x27;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function meta(html: string, ...keys: string[]): string {
  for (const key of keys) {
    const pattern = new RegExp(
      `<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']+)["']` +
        `|<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${key}["']`,
      "i",
    );
    const found = html.match(pattern);
    if (found) return decode(found[1] || found[2] || "");
  }
  return "";
}

function visibleText(html: string): string {
  return decode(
    html
      .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  );
}

const MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
const MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Dates in the formats these sites use, kept only if the year is plausible. */
function findDates(text: string): string[] {
  const out: string[] = [];
  const push = (year: number, month: number, day: number) => {
    const d = new Date(Date.UTC(year, month, day));
    if (Number.isNaN(d.getTime())) return;
    const iso = d.toISOString().slice(0, 10);
    const now = new Date();
    const floor = new Date(now.getFullYear() - 1, 0, 1);
    const ceiling = new Date(now.getFullYear() + 2, 0, 1);
    if (d >= floor && d <= ceiling && !out.includes(iso)) out.push(iso);
  };

  for (const m of text.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)) push(+m[1], +m[2] - 1, +m[3]);

  const dmy = new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS})[a-z]*\\.?,?\\s*(\\d{4})?`, "gi");
  for (const m of text.matchAll(dmy)) {
    push(m[3] ? +m[3] : new Date().getFullYear(), MONTH_INDEX[m[2].slice(0, 3).toLowerCase()], +m[1]);
  }
  const mdy = new RegExp(`(${MONTHS})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{4})?`, "gi");
  for (const m of text.matchAll(mdy)) {
    push(m[3] ? +m[3] : new Date().getFullYear(), MONTH_INDEX[m[1].slice(0, 3).toLowerCase()], +m[2]);
  }
  return out.sort();
}

const DEADLINE_WORDS =
  /(registration deadline|submission deadline|registration closes|register by|apply by|last date|deadline|closes on)/i;

/**
 * The date nearest a deadline word, on whichever side it sits.
 *
 * Pages write it both ways - "Deadline: 5 Oct" but also "05 OCT 2026 Submission
 * Deadline Extended". Searching forward first picked the date belonging to the
 * NEXT milestone on that second layout, so a challenge closing 5 October was
 * recorded as closing on the 27th. Distance decides instead of direction.
 */
function findDatesWithPositions(text: string): Array<{ iso: string; at: number }> {
  const found: Array<{ iso: string; at: number }> = [];
  const keep = (iso: string | null, at: number) => {
    if (iso) found.push({ iso, at });
  };
  const toIso = (year: number, month: number, day: number): string | null => {
    const d = new Date(Date.UTC(year, month, day));
    if (Number.isNaN(d.getTime())) return null;
    const now = new Date();
    if (d < new Date(now.getFullYear() - 1, 0, 1)) return null;
    if (d > new Date(now.getFullYear() + 2, 0, 1)) return null;
    return d.toISOString().slice(0, 10);
  };

  for (const m of text.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)) {
    keep(toIso(+m[1], +m[2] - 1, +m[3]), m.index ?? 0);
  }
  const dmy = new RegExp(`(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTHS})[a-z]*\.?,?\s*(\d{4})?`, "gi");
  for (const m of text.matchAll(dmy)) {
    const year = m[3] ? +m[3] : new Date().getFullYear();
    keep(toIso(year, MONTH_INDEX[m[2].slice(0, 3).toLowerCase()], +m[1]), m.index ?? 0);
  }
  const mdy = new RegExp(`(${MONTHS})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?`, "gi");
  for (const m of text.matchAll(mdy)) {
    const year = m[3] ? +m[3] : new Date().getFullYear();
    keep(toIso(year, MONTH_INDEX[m[1].slice(0, 3).toLowerCase()], +m[2]), m.index ?? 0);
  }
  return found;
}

function labelledDate(text: string): string | null {
  const dated = findDatesWithPositions(text);
  if (!dated.length) return null;

  let best: { iso: string; distance: number } | null = null;
  for (const match of text.matchAll(new RegExp(DEADLINE_WORDS, "gi"))) {
    const at = match.index ?? 0;
    for (const candidate of dated) {
      const distance = Math.abs(candidate.at - at);
      if (distance > 120) continue;
      if (!best || distance < best.distance) best = { iso: candidate.iso, distance };
    }
  }
  return best?.iso ?? null;
}

type Draft = {
  url: string;
  title: string;
  description: string;
  organizer: string;
  poster_url: string;
  deadline: string;
  start: string;
  end: string;
  found_dates: string[];
  warning?: string;
  read_with?: string;
};

function base(url: URL): Draft {
  return {
    url: url.toString(),
    title: "",
    description: "",
    organizer: url.hostname.replace(/^www\./, ""),
    poster_url: "",
    deadline: "",
    start: "",
    end: "",
    found_dates: [],
  };
}

function fromDates(draft: Draft, text: string) {
  const dates = findDates(text);
  draft.found_dates = dates.slice(0, 10);
  draft.deadline = labelledDate(text) ?? dates.at(-1) ?? "";
  draft.start = dates[0] ?? "";
  draft.end = dates.length > 1 ? (dates.at(-1) ?? "") : "";
}

/** Attempt 2: the page as rendered text, for sites we cannot read ourselves. */
async function readViaReader(url: URL): Promise<Draft | null> {
  let body = "";
  try {
    const response = await fetch(READER + url.toString(), {
      signal: AbortSignal.timeout(READER_TIMEOUT_MS),
      headers: { "User-Agent": BROWSER_HEADERS["User-Agent"], Accept: "text/plain" },
    });
    if (!response.ok) return null;
    body = (await response.text()).slice(0, MAX_BYTES);
  } catch {
    return null;
  }
  if (body.trim().length < 80) return null;

  const draft = base(url);
  draft.read_with = "rendering proxy";

  const titleLine = body.match(/^Title:\s*(.+)$/m);
  const heading = body.match(/^#{1,3}\s+(.+)$/m);
  draft.title = decode(heading?.[1] ?? titleLine?.[1] ?? "");

  // Prefer a large hero-looking image over an icon or a logo.
  const images = [...body.matchAll(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g)].map((m) => m[1]);
  draft.poster_url =
    images.find((src) => !/logo|icon|favicon|avatar|sprite/i.test(src)) ?? images[0] ?? "";

  const prose = body.replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[|\]|\*\*/g, " ");
  draft.description = decode(prose.split("\n").filter((l) => l.trim().length > 60)[0] ?? "").slice(0, 400);
  fromDates(draft, prose);
  return draft;
}

export async function POST(request: Request) {
  const supabase = serverClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { data: me } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (!canManage(me?.role)) {
    return NextResponse.json({ error: "Only the owner can add events" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const url = safeUrl(String(body.url ?? ""));
  if (!url) {
    return NextResponse.json({ error: "That does not look like a public http(s) link." }, { status: 400 });
  }

  // ---- attempt 1: read the page ourselves -------------------------------
  let html = "";
  let directProblem = "";
  try {
    const response = await fetch(url.toString(), {
      redirect: "follow",
      signal: AbortSignal.timeout(DIRECT_TIMEOUT_MS),
      headers: BROWSER_HEADERS,
    });
    if (response.ok) {
      html = (await response.text()).slice(0, MAX_BYTES);
    } else {
      directProblem = `the site refused our request (HTTP ${response.status})`;
    }
  } catch (error) {
    directProblem =
      error instanceof Error && error.name === "TimeoutError" ? "the page timed out" : "the page could not be reached";
  }

  if (html) {
    const text = visibleText(html);
    const poster = meta(html, "og:image:secure_url", "og:image", "twitter:image");
    const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

    const draft = base(url);
    draft.title = meta(html, "og:title") || decode(titleTag?.[1] ?? "");
    draft.description = meta(html, "og:description", "description").slice(0, 400);
    draft.organizer = meta(html, "og:site_name") || draft.organizer;
    draft.poster_url = poster ? new URL(poster, url).toString() : "";
    fromDates(draft, text);

    // A JavaScript app serves a title, a script tag and nothing else. There is
    // genuinely nothing in that HTML, so fall through to the renderer.
    const bare = !draft.poster_url && draft.found_dates.length === 0 && text.length < 400;
    if (!bare) {
      draft.read_with = "the page itself";
      return NextResponse.json(draft);
    }
    directProblem = "the page builds itself with JavaScript, so its HTML carries nothing to read";
  }

  // ---- attempt 2: rendering proxy ---------------------------------------
  const rendered = await readViaReader(url);
  if (rendered) {
    rendered.warning =
      `Read through a rendering proxy because ${directProblem}. ` +
      "Check the dates and the poster before saving.";
    return NextResponse.json(rendered);
  }

  const blank = base(url);
  blank.warning =
    `Could not read the page: ${directProblem}, and the rendering proxy could not read it either. ` +
    "Fill the details in by hand - only the title and the deadline are required.";
  return NextResponse.json(blank);
}
