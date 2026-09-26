# India Hackathon & Competition Tracker

One runnable file. One folder. Excel output that remembers what it already showed you.

**Events in India only.** A hackathon qualifies when it names an Indian city, state or
institution, or when it comes from a platform run out of India (Unstop, HackIndia,
Hack2Skill, HackerEarth, Devfolio, SIH) and names nowhere abroad. A global online hackathon
with no Indian tie is dropped even though an Indian student could enter it - add
`--include-global` if you want those back.

```
HackathonTracker\
├── hackathon_tracker.py      <-- run this
├── requirements.txt
├── run.bat                   <-- or double-click this
├── README.md
├── tracker_state.json        (created on first run - the NEW/OLD memory)
├── tracker.log               (created on first run)
└── output\                   (created on first run)
    ├── hackathons_latest.xlsx        <-- the workbook you open
    ├── hackathons_2026-09-19.xlsx    <-- dated copy of the same run
    ├── hackathons.csv
    ├── hackathons.json
    ├── report.html                   <-- OPEN THIS: the browsable card page
    ├── run_summary.json
    └── posters\                      verified poster images
```

## Setup (once)

```bash
pip install -r requirements.txt
```

Or, to keep it isolated in this folder:

```bash
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
```

`run.bat` uses `.venv` automatically when it exists, otherwise your system Python.

## Run

```bash
python hackathon_tracker.py
```

| Option | What it does |
|---|---|
| `--days 60` | date window from today (default 120) |
| `--kind open` / `--kind hiring` | keep only hackathons, or only hiring challenges |
| `--include-global` | also keep global online events with no Indian tie |
| `--scope national --scope regional` | keep only these scopes; repeatable |
| `--source Unstop --source Devpost` | only these sources; repeatable |
| `--no-posters` | skip poster download and verification (much faster) |
| `--keep-undated` | keep events whose dates could not be read |
| `--reset` | forget history, so every event is marked NEW again |
| `--quiet` | print only the closing summary |

## NEW and OLD

The first column of the workbook answers one question: *have I seen this before?*

- **NEW** (green) - this run is the first time the tracker has ever recorded the event.
- **OLD** (grey) - it appeared in an earlier run. `First seen` shows when, and `Times seen`
  counts the runs it has appeared in.

The memory is `tracker_state.json`. It survives across runs and is keyed on each site's own
event id where one exists, so a renamed title or a reordered listing does not make an old
event look new. Delete the file (or pass `--reset`) to start the history over.

## Hackathons vs hiring challenges

The two are kept apart everywhere, because they answer different questions:

- **Hackathons** - open contests you enter to build something and win a prize.
- **Hiring challenges** - run by companies to recruit. You compete for a job, often against
  working professionals with years of experience, and the "prize" is an interview.

An event counts as hiring when its title carries a recruitment word (hiring, recruitment,
placement, job, career, internship), its URL sits under a `/recruit/` path, or its text uses
a recruiting phrase ("we are hiring", "5+ years of experience", "pre-placement offer").
Matching is on word boundaries, so *Overdrive* is not read as a placement **drive** and
*opportunity* is not read as a **PPO**.

In the workbook they are separate sheets. On the web page they are separate sections, and the
`Both / Hackathons / Hiring only` buttons switch between them. `--kind open` or `--kind hiring`
restricts the whole run to one of them.

## The web page (`output\report.html`)

Double-click it. One card per event, laid out as a grid:

- the **poster**, with a green **NEW** or grey **OLD** flag on the left, and a purple
  **HIRING** flag on the right when it is a recruitment challenge
- venue / city in small caps, then the event title
- prize, number registered, and a status badge (`LIVE`, `REGISTERING`, `CLOSES IN 3 DAYS`,
  `CLOSED`, `DATES TBA`)
- **Dates** (start → end), **Register by** (deadline in orange), **Mode + scope**,
  **who is eligible**, and which **source** it came from
- **domain tags** - AI/ML, Web3, Full stack, Blockchain, and so on
- two buttons: **Event page** and **Register Now**

**New events are in the top band, previously seen ones in the band below**, each labelled.
A search box filters by name, college, city or domain, and the All / New only / Old only
buttons narrow the list. It is a single self-contained file - no server, no internet needed
except to load the poster images.

## What is in the workbook

**Hackathons** and **Hiring Challenges** - one row per event, 25 columns: status, kind, title, scope, type, domain, source, start /
end / registration deadline, days left, mode, location, organizer, prize, fee, team size,
eligibility, website link, registration link, poster link and poster check result, plus the
first-seen / last-seen / times-seen history. The header is frozen and filtered, so you can
sort by deadline or filter to `Status = NEW` immediately.

**Summary** - counts by scope and by source, and every error the run hit.

**Posters** - the verified posters, embedded as thumbnails (needs Pillow installed).

## Sources

| Source | How it is read | Notes |
|---|---|---|
| Unstop | public opportunity API | largest India-wide listing; paged |
| Devpost | public hackathons API | searched for India and for student events |
| HackerEarth | public events feed | hackathons and coding challenges |
| HackIndia | sitemap -> event pages | their robots.txt disallows `/api/`, so it is not used |
| Devfolio | listing -> event subdomains | college and community hackathons |
| Smart India Hackathon | official portal | listed even before dates are announced |
| Hack2Skill | homepage -> event pages | largely JavaScript-rendered, so yield is low |
| MLH | season events page | global student hackathon league |

Every request is checked against the site's `robots.txt` first, and requests to one host are
spaced out. The robots check implements longest-match precedence, which Python's own
`urllib.robotparser` gets wrong - that matters here, because HackIndia's file allows `/` and
then disallows `/api/`, and the standard library reads that as permission to crawl the API.

## Posters are verified, not trusted

A poster URL from the markup means nothing on its own. Each one is fetched, its first bytes
are checked for a real PNG / JPEG / GIF / WebP / AVIF / SVG signature, and its true pixel
size is read from the file header. Anything under 150px on a side, or shaped like a header
strip (wider than 4:1), or returning an HTTP error, is rejected and the reason is recorded in
the `Poster check` column. Only verified posters are embedded in the workbook.

## If Excel has the file open

Excel takes an exclusive lock on an open workbook. Rather than lose the run, the tracker
writes `hackathons_latest-new.xlsx` beside it and says so in the closing summary.

## Honest limits

- Listings change constantly, and search-driven sites return different results each run.
  Counts moving between runs is normal, not a fault.
- Unstop, Devfolio and Hack2Skill render much of their content in the browser. The APIs and
  sitemaps used here reach what is publicly served; they are not a complete index.
- Scope (global / national / regional) is inferred from the wording on the page. It is a
  reading aid, not a guarantee.
- **Always confirm dates, fees and eligibility on the official page before applying or
  paying.** Nothing here should be treated as the final word.
