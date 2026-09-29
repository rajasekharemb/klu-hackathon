import { NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/roles";

/**
 * Reads a pasted event link and returns what it can find: title, poster, dates,
 * organiser. The owner checks the result and saves it - nothing is written here.
 *
 * This fetches a URL chosen by a user from our server, so it is deliberately
 * narrow: signed-in owners only, http(s) only, no private or loopback hosts, a
 * hard timeout, and only the first part of the body is read.
 */

const MAX_BYTES = 600_000;
const TIMEOUT_MS = 12_000;

const BLOCKED_HOSTS = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?)/i;

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

function decode(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
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

/** Dates in the formats these sites actually use, kept only if plausible. */
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

  for (const m of text.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)) {
    push(+m[1], +m[2] - 1, +m[3]);
  }
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

function labelledDate(text: string): string | null {
  const labels = /(registration deadline|registration closes|register by|apply by|last date|deadline)/i;
  const window = text.split(labels);
  for (let i = 1; i < window.length; i += 2) {
    const after = window[i + 1]?.slice(0, 90) ?? "";
    const dates = findDates(after);
    if (dates.length) return dates[0];
  }
  return null;
}

/** A draft with nothing filled in but the link, plus why. */
function blank(url: URL, warning: string) {
  return {
    url: url.toString(),
    title: "",
    description: "",
    organizer: url.hostname.replace(/^www\./, ""),
    poster_url: "",
    deadline: "",
    start: "",
    end: "",
    found_dates: [] as string[],
    warning: `${warning} Fill the details in by hand - they are all optional except the title and the deadline.`,
  };
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
    return NextResponse.json(
      { error: "That does not look like a public http(s) link." },
      { status: 400 },
    );
  }

  let html = "";
  try {
    const response = await fetch(url.toString(), {
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-IN,en;q=0.9",
        "Upgrade-Insecure-Requests": "1",
      },
    });
    if (!response.ok) {
      // 403/503 from Cloudflare and friends is normal for a server-side fetch.
      // Hand back a blank draft so the owner can fill it in rather than being stuck.
      return NextResponse.json(blank(url, `The site refused our request (HTTP ${response.status}).`));
    }
    html = (await response.text()).slice(0, MAX_BYTES);
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "TimeoutError" ? "timed out" : "could not be reached";
    return NextResponse.json(blank(url, `That page ${reason}.`));
  }

  const text = visibleText(html);
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const dates = findDates(text);
  const deadline = labelledDate(text);
  const poster = meta(html, "og:image:secure_url", "og:image", "twitter:image");

  // Sites built as JavaScript apps serve a near-empty shell: a title, a script
  // tag and nothing else. There is genuinely nothing to read, so say so instead
  // of handing back a draft that looks like it failed silently.
  const looksClientRendered = !poster && dates.length === 0 && text.length < 400;
  const warning = looksClientRendered
    ? "This page builds itself with JavaScript, so it carries no details we can read. " +
      "Copy the poster's image address from the page (right-click the poster, Copy image address) " +
      "and type the dates in yourself."
    : undefined;

  return NextResponse.json({
    warning,
    url: url.toString(),
    title: meta(html, "og:title") || decode(titleTag?.[1] ?? ""),
    description: meta(html, "og:description", "description").slice(0, 400),
    organizer: meta(html, "og:site_name") || url.hostname.replace(/^www\./, ""),
    poster_url: poster ? new URL(poster, url).toString() : "",
    // Everything below is a guess from the page text - the form shows it for the
    // owner to correct before anything is saved.
    deadline: deadline ?? dates.at(-1) ?? "",
    start: dates[0] ?? "",
    end: dates.length > 1 ? dates.at(-1) ?? "" : "",
    found_dates: dates.slice(0, 8),
  });
}
