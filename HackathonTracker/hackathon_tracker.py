#!/usr/bin/env python3
"""
India Hackathon & Competition Tracker - single-file edition.
============================================================

Run this one file. It collects hackathons and student competitions that are open to
Indian students - global, national and regional - and writes an Excel workbook plus
matching CSV / JSON / HTML into the `output` folder next to this script.

Every row in the Excel sheet is marked:

    NEW  - this run is the first time the tracker has ever seen the event
    OLD  - the tracker recorded it on an earlier run (first-seen date is kept)

That memory lives in `tracker_state.json` beside this script. Delete that file and
everything becomes NEW again.

Sources (all public, all checked against robots.txt before each request):

    Unstop          public opportunity API      - the largest India-wide listing
    Devpost         public hackathons API       - global events, filtered for India
    HackerEarth     public events feed          - hackathons and coding challenges
    HackIndia       sitemap -> event pages      - India-focused hackathon platform
    Devfolio        listing -> event subdomains - college and community hackathons
    Smart India Hackathon (sih.gov.in)          - the national government programme
    Hack2Skill      homepage -> event pages
    MLH             season page                 - global student hackathon league

Posters are never taken on trust: each poster URL is fetched, its bytes are checked
for a real image signature, and its true pixel size is read from the file header.
Only verified posters are embedded in the workbook.

Usage
-----
    python hackathon_tracker.py
    python hackathon_tracker.py --days 60 --scope national --scope regional
    python hackathon_tracker.py --no-posters --quiet
    python hackathon_tracker.py --reset          (forget history; everything is NEW)

Install once:
    pip install -r requirements.txt
"""

from __future__ import annotations

import argparse
import csv
import html as html_lib
import io
import json
import logging
import re
import sys
import time
import unicodedata
from collections.abc import Iterable
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import unquote_plus, urljoin, urlparse

try:
    import requests
except ImportError:  # pragma: no cover - guidance is more useful than a traceback
    sys.exit("Missing dependency: requests\n  pip install -r requirements.txt")

try:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter
except ImportError:  # pragma: no cover
    sys.exit("Missing dependency: openpyxl\n  pip install -r requirements.txt")

try:  # Optional: only needed to embed poster thumbnails into the workbook.
    import PIL  # noqa: F401  (openpyxl needs Pillow present to embed images)
    from openpyxl.drawing.image import Image as XLImage

    CAN_EMBED_IMAGES = True
except ImportError:
    CAN_EMBED_IMAGES = False


# ============================================================================
# Configuration - edit these, everything else follows
# ============================================================================

HERE = Path(__file__).resolve().parent
OUTPUT_DIR = HERE / "output"
POSTER_DIR = OUTPUT_DIR / "posters"
STATE_FILE = HERE / "tracker_state.json"
LOG_FILE = HERE / "tracker.log"

DEFAULT_WINDOW_DAYS = 120          # keep events dated within this many days from today
REQUEST_TIMEOUT = 25               # seconds
POLITE_DELAY = 0.8                 # seconds between requests to the same host
MAX_PER_SOURCE = 250               # default cap on events taken from one source
# Unstop carries far more than the rest combined, so it gets explicit per-feed caps.
UNSTOP_FEEDS = (("hackathons", 240), ("competitions", 220))
UNSTOP_PAGE_SIZE = 25
UNSTOP_MAX_PAGES = 12
MAX_POSTER_BYTES = 400_000         # only the first bytes are needed to identify an image
MIN_POSTER_EDGE = 150              # px; below this it is a logo or an icon
POSTER_EDGE_FOR_OK = 300           # px; between the two it is a usable thumbnail, not a poster
MIN_POSTER_ASPECT, MAX_POSTER_ASPECT = 0.25, 4.0
USABLE_POSTER_STATUSES = ("ok", "thumbnail")

USER_AGENT = "HackathonTracker/1.0 (+student-opportunity-research; respects robots.txt)"
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)

SCOPES = ("global", "national", "regional", "campus", "unknown")

log = logging.getLogger("tracker")


# ============================================================================
# Data model
# ============================================================================


SCOPE_LABELS = {
    "global": "Global",
    "national": "National (India)",
    "regional": "Regional / State",
    "campus": "Campus",
    "unknown": "Unconfirmed",
}
KINDS = ("open", "hiring")
KIND_LABELS = {"open": "Hackathon", "hiring": "Hiring challenge"}


def _iso(value: date | None) -> str:
    return value.isoformat() if value else ""


def _days_left(value: date | None) -> str:
    if not value:
        return ""
    delta = (value - date.today()).days
    return str(delta) if delta >= 0 else f"{delta} (past)"


@dataclass
class Poster:
    url: str = ""
    status: str = "none"          # ok | too_small | wrong_shape | not_an_image | http_error | unreachable | none
    width: int = 0
    height: int = 0
    kind: str = ""
    file: str = ""                # path of the downloaded copy, relative to output/
    note: str = ""


@dataclass
class Event:
    title: str
    source: str                   # which site it came from
    url: str                      # the event's own page
    source_id: str = ""           # the site's own id, when it has one (best dedupe key)
    organizer: str = ""
    registration_url: str = ""
    start: date | None = None
    end: date | None = None
    deadline: date | None = None
    mode: str = "unknown"         # online | offline | hybrid | unknown
    location: str = ""
    scope: str = "unknown"
    kind: str = "open"                                 # open | hiring
    categories: list[str] = field(default_factory=list)
    domains: list[str] = field(default_factory=list)   # AI/ML, Web3, Full stack, ...
    eligibility: str = ""
    team_size: str = ""
    fee: str = ""
    prize: str = ""
    participants: str = ""
    description: str = ""
    poster: Poster = field(default_factory=Poster)
    # Filled in from the state file:
    status: str = "NEW"           # NEW | OLD
    first_seen: str = ""
    last_seen: str = ""
    times_seen: int = 0

    def key(self) -> str:
        """Stable identity across runs, so an event is only ever 'NEW' once."""
        if self.source_id:
            return f"{self.source}:{self.source_id}".lower()
        slug = re.sub(r"[^a-z0-9]+", "", self.title.lower())[:60]
        anchor = (self.start or self.deadline or self.end)
        return f"{self.source}:{slug}:{anchor.isoformat() if anchor else 'undated'}".lower()

    def next_date(self) -> date:
        return self.deadline or self.start or self.end or date.max

    def next_milestone(self) -> date | None:
        """The soonest date still ahead - what "days left" should actually count down to.

        An event that started last week but runs until next month is still open; showing the
        start date's negative countdown would read as if it were over.
        """
        today = date.today()
        dates = [d for d in (self.deadline, self.start, self.end) if d]
        upcoming = sorted(d for d in dates if d >= today)
        return upcoming[0] if upcoming else (max(dates) if dates else None)

    def to_row(self) -> dict[str, Any]:
        return {
            "Status": self.status,
            "Kind": KIND_LABELS.get(self.kind, self.kind),
            "Title": self.title,
            "Scope": SCOPE_LABELS.get(self.scope, self.scope),
            "Type": ", ".join(self.categories) or "Hackathon",
            "Domain": ", ".join(self.domains),
            "Source": self.source,
            "Starts": _iso(self.start),
            "Ends": _iso(self.end),
            "Registration deadline": _iso(self.deadline),
            "Days left": _days_left(self.next_milestone())
            or ("dates to be announced" if not (self.start or self.end or self.deadline) else ""),
            "Mode": self.mode,
            "Location": self.location,
            "Organizer": self.organizer,
            "Prize": self.prize,
            "Fee": self.fee,
            "Team size": self.team_size,
            "Eligibility": self.eligibility,
            "Website": self.url,
            "Register": self.registration_url or self.url,
            "Poster": self.poster.url,
            "Poster check": (
                f"{self.poster.status} {self.poster.width}x{self.poster.height}".strip()
                if self.poster.width
                else self.poster.status
            ),
            "First seen": self.first_seen,
            "Last seen": self.last_seen,
            "Times seen": self.times_seen,
        }


COLUMNS = list(Event(title="", source="", url="").to_row().keys())


# ============================================================================
# Polite HTTP: robots.txt, rate limiting, retries
# ============================================================================


class RobotsGate:
    """robots.txt with correct longest-match precedence.

    Python's own `urllib.robotparser` returns the *first* matching rule, so a file that
    says `Allow: /` before `Disallow: /api/` is read as allowing `/api/` - which is the
    opposite of what the site asked for. The standard says the longest matching path
    wins, with Allow winning ties, and that is what this implements.
    """

    def __init__(self, session: requests.Session) -> None:
        self.session = session
        self._rules: dict[str, list[tuple[str, bool]]] = {}

    def allows(self, url: str) -> bool:
        parsed = urlparse(url)
        origin = f"{parsed.scheme}://{parsed.netloc}"
        if origin not in self._rules:
            self._rules[origin] = self._load(origin)
        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"
        best_length, best_allowed = -1, True
        for pattern, allowed in self._rules[origin]:
            if self._matches(pattern, path) and len(pattern) >= best_length:
                # Longest wins; on an exact tie Allow beats Disallow.
                if len(pattern) > best_length or allowed:
                    best_length, best_allowed = len(pattern), allowed
        return best_allowed

    def _load(self, origin: str) -> list[tuple[str, bool]]:
        try:
            response = self.session.get(f"{origin}/robots.txt", timeout=REQUEST_TIMEOUT)
            if response.status_code != 200:
                return []
            body = response.text
        except requests.RequestException:
            return []  # No reachable robots.txt means no stated restriction.
        rules: list[tuple[str, bool]] = []
        applies = False
        for raw in body.splitlines():
            line = raw.split("#", 1)[0].strip()
            if not line or ":" not in line:
                continue
            field_name, _, value = line.partition(":")
            field_name, value = field_name.strip().lower(), value.strip()
            if field_name == "user-agent":
                applies = value == "*" or value.lower() in USER_AGENT.lower()
            elif applies and field_name in {"allow", "disallow"} and value:
                rules.append((value, field_name == "allow"))
        return rules

    @staticmethod
    def _matches(pattern: str, path: str) -> bool:
        if "*" not in pattern and "$" not in pattern:
            return path.startswith(pattern)
        regex = "".join(
            ".*" if ch == "*" else ("$" if ch == "$" else re.escape(ch)) for ch in pattern
        )
        return re.match(regex, path) is not None


class Fetcher:
    """One session for the whole run: robots-checked, rate-limited, never raises."""

    def __init__(self, obey_robots: bool = True) -> None:
        self.session = requests.Session()
        self.session.headers.update(
            {"User-Agent": BROWSER_UA, "Accept-Language": "en-IN,en;q=0.9"}
        )
        self.robots = RobotsGate(self.session)
        self.obey_robots = obey_robots
        self._last_hit: dict[str, float] = {}
        self.errors: list[str] = []

    def _wait(self, url: str) -> None:
        host = urlparse(url).netloc
        elapsed = time.monotonic() - self._last_hit.get(host, 0.0)
        if elapsed < POLITE_DELAY:
            time.sleep(POLITE_DELAY - elapsed)
        self._last_hit[host] = time.monotonic()

    def get(self, url: str, as_json: bool = False, max_bytes: int = 0) -> Any:
        """Return parsed JSON, text, or bytes. Returns None on any failure."""
        if self.obey_robots and not self.robots.allows(url):
            self.errors.append(f"robots.txt disallows {url}")
            log.warning("  skipped (robots.txt): %s", url)
            return None
        self._wait(url)
        headers = {"Accept": "application/json, text/plain, */*"} if as_json else {}
        if max_bytes:
            headers["Range"] = f"bytes=0-{max_bytes - 1}"
        # Government portals (sih.gov.in especially) are slow enough to time out on a
        # first attempt and answer fine on a second, so a timeout gets one retry.
        response = None
        for attempt in (1, 2):
            try:
                response = self.session.get(url, timeout=REQUEST_TIMEOUT * attempt, headers=headers)
                break
            except (requests.Timeout, requests.ConnectionError) as exc:
                if attempt == 2:
                    self.errors.append(f"{url}: {type(exc).__name__}: {exc}")
                    return None
                time.sleep(1.5)
            except requests.RequestException as exc:
                self.errors.append(f"{url}: {type(exc).__name__}: {exc}")
                return None
        if response is None:
            return None
        if response.status_code >= 400:
            self.errors.append(f"{url}: HTTP {response.status_code}")
            return None
        if max_bytes:
            return response
        if as_json:
            try:
                return response.json()
            except ValueError as exc:
                self.errors.append(f"{url}: bad JSON ({exc})")
                return None
        return response.text


# ============================================================================
# Small parsing helpers
# ============================================================================

MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec"
DATE_PATTERNS = (
    r"\d{4}-\d{2}-\d{2}",
    rf"\d{{1,2}}(?:st|nd|rd|th)?\s+(?:{MONTHS})[a-z]*\.?\s*,?\s*\d{{4}}",
    rf"(?:{MONTHS})[a-z]*\.?\s+\d{{1,2}}(?:st|nd|rd|th)?\s*,?\s*\d{{4}}",
    r"\d{1,2}[/-]\d{1,2}[/-]\d{4}",
)
MONTH_NUMBERS = {
    name: index
    for index, name in enumerate(
        ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), start=1
    )
}


def parse_date(value: Any, default_year: int | None = None) -> date | None:
    """Parse the date formats these sites actually use. Returns None rather than guessing."""
    if value in (None, "", False):
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    text = str(value).strip()
    if not text:
        return None
    # ISO 8601, with or without a timezone: 2026-09-27T23:59:00+05:30
    iso = re.match(r"(\d{4})-(\d{2})-(\d{2})", text)
    if iso:
        try:
            return date(int(iso.group(1)), int(iso.group(2)), int(iso.group(3)))
        except ValueError:
            return None
    # 19 September 2026  /  19th Sep, 2026
    match = re.search(rf"(\d{{1,2}})(?:st|nd|rd|th)?\s+({MONTHS})[a-z]*\.?\s*,?\s*(\d{{4}})?", text, re.I)
    if match:
        year = int(match.group(3)) if match.group(3) else default_year
        if year:
            return _safe_date(year, MONTH_NUMBERS[match.group(2)[:3].lower()], int(match.group(1)))
    # Sep 20, 2026  /  Friday, Aug 14, 2026
    match = re.search(rf"({MONTHS})[a-z]*\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?\s*,?\s*(\d{{4}})?", text, re.I)
    if match:
        year = int(match.group(3)) if match.group(3) else default_year
        if year:
            return _safe_date(year, MONTH_NUMBERS[match.group(1)[:3].lower()], int(match.group(2)))
    # 27/09/2026 (day first, as used in India)
    match = re.search(r"(\d{1,2})[/-](\d{1,2})[/-](\d{4})", text)
    if match:
        return _safe_date(int(match.group(3)), int(match.group(2)), int(match.group(1)))
    return None


def _safe_date(year: int, month: int, day: int) -> date | None:
    try:
        return date(year, month, day)
    except ValueError:
        return None


def strip_html(markup: str) -> str:
    """Readable text from markup: drops scripts, styles, tags, and entity noise."""
    without_blocks = re.sub(r"<(script|style|noscript|svg)\b.*?</\1\s*>", " ", markup or "", flags=re.I | re.S)
    without_comments = re.sub(r"<!--.*?-->", " ", without_blocks, flags=re.S)
    spaced = re.sub(r"<(br|/p|/div|/li|/h[1-6]|/tr|/td)\b[^>]*>", " ", without_comments, flags=re.I)
    text = html_lib.unescape(re.sub(r"<[^>]+>", " ", spaced))
    return " ".join(text.split())


def clean(value: Any, limit: int = 300) -> str:
    text = " ".join(html_lib.unescape(str(value or "")).split())
    text = "".join(ch for ch in text if unicodedata.category(ch)[0] != "C")
    return text[:limit]


def meta_content(markup: str, *keys: str) -> str:
    for key in keys:
        pattern = (
            rf'<meta[^>]+(?:property|name)=["\']{re.escape(key)}["\'][^>]*content=["\']([^"\']+)["\']'
            rf'|<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\']{re.escape(key)}["\']'
        )
        found = re.search(pattern, markup or "", re.I)
        if found:
            return html_lib.unescape(found.group(1) or found.group(2))
    return ""


def page_title(markup: str) -> str:
    found = re.search(r"<title[^>]*>(.*?)</title>", markup or "", re.I | re.S)
    if not found:
        found = re.search(r"<h1[^>]*>(.*?)</h1>", markup or "", re.I | re.S)
    return clean(strip_html(found.group(1))) if found else ""


class LinkCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "a":
            href = dict(attrs).get("href")
            if href:
                self.links.append(href)


def collect_links(markup: str, base_url: str) -> list[str]:
    collector = LinkCollector()
    try:
        collector.feed(markup or "")
    except Exception:
        pass
    out, seen = [], set()
    for href in collector.links:
        href = html_lib.unescape(href.strip())
        if not href or href.startswith(("#", "mailto:", "tel:", "javascript:")):
            continue
        full = urljoin(base_url, href).split("#")[0]
        if full not in seen:
            seen.add(full)
            out.append(full)
    return out


# ============================================================================
# Poster discovery and verification
# ============================================================================

POSTER_NOISE = (
    "logo", "favicon", "avatar", "gravatar", "sprite", "placeholder", "/partners/", "/sponsors/",
    "login", "signin", "signup", "icon", "button", "arrow", "spinner", "loader", "qr", "badge",
)


def find_poster_url(markup: str, base_url: str) -> str:
    """The page's own share image, which is what a poster actually is."""
    for key in ("og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"):
        value = meta_content(markup, key)
        if value:
            return urljoin(base_url, value)
    for found in re.finditer(r'<img[^>]+src=["\']([^"\']+)["\'][^>]*>', markup or "", re.I):
        candidate = urljoin(base_url, html_lib.unescape(found.group(1)))
        if not any(word in candidate.lower() for word in POSTER_NOISE):
            return candidate
    return ""


def sniff_image(data: bytes) -> tuple[str, int, int]:
    """(kind, width, height) read from the file's own bytes. ('', 0, 0) if not an image."""
    if len(data) < 16:
        return "", 0, 0
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png", int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    if data.startswith(b"\xff\xd8\xff"):
        index, end = 2, len(data)
        while index + 9 < end:
            if data[index] != 0xFF:
                index += 1
                continue
            marker = data[index + 1]
            if marker == 0xD8 or marker == 0x01 or 0xD0 <= marker <= 0xD7:
                index += 2
                continue
            length = int.from_bytes(data[index + 2 : index + 4], "big")
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                return (
                    "jpeg",
                    int.from_bytes(data[index + 7 : index + 9], "big"),
                    int.from_bytes(data[index + 5 : index + 7], "big"),
                )
            if length <= 0:
                break
            index += 2 + length
        return "jpeg", 0, 0
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif", int.from_bytes(data[6:8], "little"), int.from_bytes(data[8:10], "little")
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        chunk = data[12:16]
        if chunk == b"VP8X" and len(data) >= 30:
            return "webp", int.from_bytes(data[24:27], "little") + 1, int.from_bytes(data[27:30], "little") + 1
        if chunk == b"VP8 " and len(data) >= 30 and data[23:26] == b"\x9d\x01\x2a":
            return "webp", int.from_bytes(data[26:28], "little") & 0x3FFF, int.from_bytes(data[28:30], "little") & 0x3FFF
        if chunk == b"VP8L" and len(data) >= 25:
            bits = int.from_bytes(data[21:25], "little")
            return "webp", (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
        return "webp", 0, 0
    if data[4:12] in (b"ftypavif", b"ftypavis"):
        return "avif", 0, 0
    head = data[:600].lstrip().lower()
    if head[:4] == b"<svg" or (head[:5] == b"<?xml" and b"<svg" in data[:2000].lower()):
        return "svg", 0, 0
    return "", 0, 0


def verify_poster(url: str, fetcher: Fetcher, save_as: Path | None = None) -> Poster:
    """Fetch the image and record what it really is. Never raises."""
    poster = Poster(url=url)
    if not url:
        poster.status = "none"
        return poster
    response = fetcher.get(url, max_bytes=MAX_POSTER_BYTES)
    if response is None:
        poster.status = "unreachable"
        return poster
    if response.status_code >= 400:
        poster.status = "http_error"
        poster.note = f"HTTP {response.status_code}"
        return poster
    body = response.content or b""
    kind, width, height = sniff_image(body)
    if not kind:
        ctype = response.headers.get("content-type", "").split(";")[0]
        poster.status = "not_an_image"
        poster.note = f"content-type {ctype or 'unknown'}"
        return poster
    poster.kind, poster.width, poster.height = kind, width, height
    if width and height:
        if min(width, height) < MIN_POSTER_EDGE:
            poster.status = "too_small"
            poster.note = f"{width}x{height} is icon-sized"
            return poster
        aspect = width / height
        if not MIN_POSTER_ASPECT <= aspect <= MAX_POSTER_ASPECT:
            poster.status = "wrong_shape"
            poster.note = f"{width}x{height} is a banner strip"
            return poster
        if min(width, height) < POSTER_EDGE_FOR_OK:
            # Real, displayable, but it is the site's small thumbnail - say so rather than
            # calling it a poster.
            poster.status = "thumbnail"
            poster.note = f"{width}x{height} thumbnail, not a full poster"
    poster.status = poster.status if poster.status == "thumbnail" else "ok"
    if save_as is not None and kind in {"png", "jpeg", "gif"}:
        # Only formats openpyxl/Pillow can embed are worth keeping on disk.
        try:
            save_as.parent.mkdir(parents=True, exist_ok=True)
            save_as.write_bytes(body)
            poster.file = str(save_as.relative_to(OUTPUT_DIR)).replace("\\", "/")
        except OSError as exc:
            poster.note = f"not saved: {type(exc).__name__}"
    return poster


# ============================================================================
# Classification: scope and category
# ============================================================================

SCOPE_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("campus", ("intra-college", "intra college", "internal hackathon", "campus round", "students of our college")),
    ("regional", ("state level", "state-level", "regional round", "regional level", "zonal", "district level",
                  "north india", "south india", "east india", "west india")),
    ("national", ("national level", "national-level", "all india", "all-india", "pan india", "pan-india",
                  "nationwide", "across india", "india's largest", "smart india hackathon")),
    ("global", ("worldwide", "around the world", "across the globe", "globally", "international level",
                "any country", "any nationality", "open to all countries", "global hackathon")),
)
CATEGORY_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("Hackathon", ("hackathon", "hack-a-thon", "hackfest", "buildathon", "makeathon", "codefest")),
    ("Ideathon", ("ideathon", "innovathon", "innovation challenge", "idea challenge")),
    ("Coding contest", ("coding contest", "coding competition", "programming contest", "competitive programming",
                        "coding challenge", "codeathon")),
    ("Data / AI", ("datathon", "data science", "machine learning challenge", "ai challenge", "analytics challenge")),
    ("Cybersecurity / CTF", ("capture the flag", "ctf", "cyber security", "cybersecurity")),
    ("Robotics / Hardware", ("robotics", "robocon", "drone challenge", "hardware challenge", "iot challenge")),
    ("Case study / Business", ("case study competition", "case competition", "business plan", "b-plan",
                               "startup pitch", "pitch competition")),
    ("Design / Product", ("design challenge", "design competition", "ui/ux", "product design")),
    ("Research / Paper", ("paper presentation", "research paper", "call for papers")),
    ("Quiz / Olympiad", ("quiz competition", "olympiad", "tech quiz")),
)
INDIA_WORDS = (
    "india", "bharat", "indian", "andhra", "assam", "bihar", "chhattisgarh", "goa", "gujarat", "haryana",
    "himachal", "jharkhand", "karnataka", "kerala", "madhya pradesh", "maharashtra", "manipur", "meghalaya",
    "odisha", "punjab", "rajasthan", "sikkim", "tamil nadu", "telangana", "tripura", "uttar pradesh",
    "uttarakhand", "west bengal", "delhi", "chandigarh", "puducherry", "jammu", "kashmir", "ladakh",
    "mumbai", "bengaluru", "bangalore", "hyderabad", "chennai", "kolkata", "pune", "ahmedabad", "jaipur",
    "lucknow", "kanpur", "nagpur", "indore", "bhopal", "visakhapatnam", "patna", "surat", "coimbatore",
    "kochi", "bhubaneswar", "guwahati", "noida", "gurugram", "gurgaon", "vijayawada", "trichy", "vellore",
    "manipal", "roorkee", "kharagpur", "iit", "nit ", "iiit", "vit ", "srm", "aicte", "b.tech", "btech",
)


# A hiring challenge is a recruitment funnel wearing a hackathon's clothes: you compete for a
# job, often against working professionals, not for a prize. Students filtering for something
# to enter this weekend should not have to wade through them.
# Every one of these is matched on a word boundary. Plain substring matching finds "ppo" inside
# "opportunity" and "drive" inside "Overdrive", which mislabels ordinary hackathons.
HIRING_TITLE_WORDS = (
    "hiring", "recruitment", "recruiting", "recruit", "placement", "job", "jobs",
    "career", "careers", "talent", "internship",
)
HIRING_URL_MARKERS = ("/recruit/", "/recruit-", "/hiring/", "/jobs/", "/careers/")
HIRING_PHRASES = (
    "hiring challenge", "hiring drive", "recruitment drive", "placement drive", "we are hiring",
    "we're hiring", "job opportunity", "career opportunity", "full-time role", "full time role",
    "years of experience", "pre-placement offer", "offer letter", "open positions", "job openings",
    "apply for the role", "hiring partner", "job offer", "recruitment process", "job role",
)


def detect_kind(event: Event) -> str:
    """'hiring' for recruitment challenges, 'open' for ordinary hackathons."""
    title = event.title.lower()
    if any(re.search(rf"\b{word}\b", title) for word in HIRING_TITLE_WORDS):
        return "hiring"
    url = event.url.lower()
    if any(marker in url for marker in HIRING_URL_MARKERS):
        return "hiring"
    body = f"{event.description} {event.organizer} {event.eligibility}".lower()
    if any(phrase in body for phrase in HIRING_PHRASES):
        return "hiring"
    return "open"


def classify(event: Event, extra_text: str = "") -> None:
    haystack = " ".join(
        (event.title, event.description, event.location, event.eligibility, event.url, extra_text)
    ).lower()
    for scope, phrases in SCOPE_RULES:
        if any(phrase in haystack for phrase in phrases):
            event.scope = scope
            break
    else:
        event.scope = _infer_scope(event, haystack)
    event.categories = [name for name, terms in CATEGORY_RULES if any(term in haystack for term in terms)]
    if not event.categories:
        event.categories = ["Hackathon" if "hack" in haystack else "Competition"]
    event.kind = detect_kind(event)


def _infer_scope(event: Event, haystack: str) -> str:
    """Only reached when the page states no scope of its own, so every branch is a guess.

    A college hackathon listed on an Indian platform rarely says "India" anywhere - the
    audience is assumed. Calling those "global" would be wrong twice over: it mislabels the
    event, and it gets it dropped by the India-only filter.
    """
    mentions_india = any(word in haystack for word in INDIA_WORDS)
    if event.mode == "offline" and event.location and mentions_india:
        return "regional"
    if mentions_india:
        return "national"
    if event.source in INDIA_BASED_SOURCES:
        return "national"
    if event.mode in {"online", "hybrid"}:
        return "global"
    return "unknown"


# Platforms run from India: their events are aimed at Indian students even when the listing
# never spells out a city. Anything from elsewhere has to name an Indian place to qualify.
INDIA_BASED_SOURCES = {"Unstop", "HackIndia", "Hack2Skill", "HackerEarth", "Devfolio", "Smart India Hackathon"}
FOREIGN_MARKERS = (
    "united states", ", usa", " usa ", ", u.s.", "united kingdom", ", uk", "canada", "ontario",
    "california", "texas", "virginia", "maryland", "pennsylvania", "georgia, ", "new york",
    "singapore", "malaysia", "germany", "france", "netherlands", "australia", "japan", "dubai",
    "nigeria", "kenya", "brazil", "mexico", "toronto", "waterloo", "london", "berlin", "boston",
    "chicago", "seattle", "atlanta", "baltimore", "pittsburgh", "blacksburg", "williamsburg",
)


def is_in_india(event: Event, include_global: bool = False) -> bool:
    """Is this event actually in India?

    India-only is the default: a global online hackathon with no Indian tie is dropped even
    though an Indian student could enter it. Pass --include-global to keep those as well.
    """
    haystack = " ".join(
        (event.title, event.description, event.location, event.organizer, event.url)
    ).lower()
    names_india = any(word in haystack for word in INDIA_WORDS)
    names_abroad = any(marker in haystack for marker in FOREIGN_MARKERS)
    if names_india and not names_abroad:
        return True
    if names_abroad and not names_india:
        return False
    if names_india:  # Mentions both - trust the event's own location field.
        return any(word in event.location.lower() for word in INDIA_WORDS)
    if event.source in INDIA_BASED_SOURCES:
        # An Indian platform can still host a purely global online event - open to the world,
        # tied to no Indian place. That is not "in India" in any useful sense.
        if event.mode == "online" and event.scope == "global":
            return include_global
        return True
    return include_global and event.mode in {"online", "hybrid"}


# ============================================================================
# Sources - each returns a list of Event
# ============================================================================


def source_unstop(fetcher: Fetcher) -> list[Event]:
    """Unstop's public opportunity API - the largest India-wide student listing.

    Two feeds, because "hackathons" alone misses most of what a student can enter:
    Unstop carries roughly 230 open hackathons and another 680 competitions
    (ideathons, coding contests, case studies, quizzes). The old version read three
    pages of hackathons only and stopped at 60, so the great majority never appeared.

    Jobs and internships are deliberately left out - they are postings, not contests,
    and there are another 1,500 of them.
    """
    events: list[Event] = []
    for opportunity, cap in UNSTOP_FEEDS:
        events.extend(_unstop_feed(fetcher, opportunity, cap))
    return events


def _unstop_feed(fetcher: Fetcher, opportunity: str, cap: int) -> list[Event]:
    """Page through one Unstop feed until it runs out or the cap is reached."""
    events: list[Event] = []
    for page in range(1, UNSTOP_MAX_PAGES + 1):
        url = (
            "https://unstop.com/api/public/opportunity/search-result"
            f"?opportunity={opportunity}&per_page={UNSTOP_PAGE_SIZE}&oppstatus=open&page={page}"
        )
        payload = fetcher.get(url, as_json=True)
        if not payload:
            break
        block = payload.get("data", {})
        items = block.get("data", []) if isinstance(block, dict) else block
        if not items:
            break
        for item in items:
            event = _unstop_event(item)
            if event:
                events.append(event)
        if len(events) >= cap:
            break
        # last_page tells us when to stop rather than guessing.
        if isinstance(block, dict) and page >= int(block.get("last_page") or UNSTOP_MAX_PAGES):
            break
    log.info("  Unstop/%s: %d", opportunity, len(events[:cap]))
    return events[:cap]


def _unstop_event(item: dict) -> Event | None:
    regn = item.get("regnRequirements") or {}
    organisation = item.get("organisation") or {}
    event = Event(
        title=clean(item.get("title"), 200),
        source="Unstop",
        url=clean(item.get("seo_url") or f"https://unstop.com/{item.get('public_url', '')}", 400),
        source_id=str(item.get("id") or ""),
        organizer=clean(organisation.get("name"), 160),
        start=parse_date(regn.get("start_regn_dt")),
        end=parse_date(item.get("end_date")),
        deadline=parse_date(regn.get("end_regn_dt") or item.get("end_date")),
        mode=_unstop_mode(item.get("region")),
        location=clean(_unstop_location(item), 120),
        prize=_unstop_prize(item.get("prizes")),
        team_size=_team_size(regn.get("min_team_size"), regn.get("max_team_size")),
        eligibility=clean(
            ", ".join(f.get("name", "") for f in (item.get("filters") or []) if f.get("type") == "eligible"),
            200,
        ),
        participants=str(item.get("registerCount") or ""),
        # .get(key, "") still returns None when the key exists and is null, which the
        # competitions feed has - so coerce rather than default.
        description=clean(str(item.get("subtype") or "").replace("_", " "), 200),
        domains=_unstop_domains(item),
    )
    # Unstop's listing page is itself the registration page.
    event.registration_url = event.url
    # Unstop's API only ever exposes a 150x150 thumbnail, and its event pages sit
    # behind a cookie wall with no og:image, so no larger poster is reachable.
    # It is used as-is and reported as a thumbnail rather than dressed up as a poster.
    event.poster = Poster(url=clean(item.get("logoUrl2"), 400))
    return event if event.title and event.url else None


def _unstop_domains(item: dict) -> list[str]:
    """Skill tags Unstop attaches to an opportunity - the closest thing it has to a domain."""
    skills: list[str] = []
    for entry in item.get("required_skills") or []:
        name = clean(entry.get("skill_name") or entry.get("skill"), 40)
        if name and name not in skills:
            skills.append(name)
    return skills[:4]


def _unstop_mode(region: Any) -> str:
    value = str(region or "").lower()
    return value if value in {"online", "offline", "hybrid"} else "unknown"


def _unstop_location(item: dict) -> str:
    locations = item.get("locations") or []
    if isinstance(locations, list) and locations:
        return ", ".join(str(entry) for entry in locations[:2])
    organisation = item.get("organisation") or {}
    return clean(organisation.get("name"), 120) if organisation else "India"


def _unstop_prize(prizes: Any) -> str:
    if not isinstance(prizes, list):
        return ""
    for prize in prizes:
        cash = prize.get("cash")
        if cash:
            return f"₹{int(cash):,}"
    return ""


def _team_size(minimum: Any, maximum: Any) -> str:
    if minimum and maximum:
        return f"{minimum}-{maximum}"
    return str(minimum or maximum or "")


def source_devpost(fetcher: Fetcher) -> list[Event]:
    """Devpost's public API, asked for India and for open online events."""
    events: list[Event] = []
    # Devpost returns ~9 per page, so one page per query was reading a fraction of
    # what the search actually matches.
    for query in ("india", "student"):
        for page in range(1, 5):
            payload = fetcher.get(
                f"https://devpost.com/api/hackathons?search={query}"
                f"&status[]=open&status[]=upcoming&page={page}",
                as_json=True,
            )
            if not payload or not payload.get("hackathons"):
                break
            _devpost_page(payload, events)
    return events[:MAX_PER_SOURCE]


def _devpost_page(payload: dict, events: list[Event]) -> None:
    """Turn one page of Devpost results into events."""
    for item in payload.get("hackathons", []):
        start, end = _devpost_dates(item.get("submission_period_dates", ""))
        location = item.get("displayed_location") or {}
        event = Event(
            title=clean(item.get("title"), 200),
            source="Devpost",
            url=clean(item.get("url"), 400),
            source_id=str(item.get("id") or ""),
            organizer=clean(item.get("organization_name"), 160),
            start=start,
            end=end,
            deadline=end,
            mode="online" if "online" in str(location.get("location", "")).lower() else "unknown",
            location=clean(location.get("location"), 120),
            prize=clean(re.sub(r"<[^>]+>", "", str(item.get("prize_amount") or "")), 60),
            participants=str(item.get("registrations_count") or ""),
            domains=[clean(theme.get("name"), 40) for theme in (item.get("themes") or [])[:4]],
            eligibility=clean(item.get("eligibility_requirement_invite_only_description"), 200),
        )
        event.registration_url = clean(item.get("start_a_submission_url") or item.get("url"), 400)
        thumbnail = str(item.get("thumbnail_url") or "")
        if thumbnail.startswith("//"):
            thumbnail = f"https:{thumbnail}"
        # Devpost serves a small square by default; the large variant is the poster.
        event.poster = Poster(url=thumbnail.replace("medium_square", "large").replace("/thumbnail/", "/large/"))
        if event.title and event.url:
            events.append(event)


def _devpost_dates(text: str) -> tuple[date | None, date | None]:
    """'Sep 01 - Oct 23, 2026' -> (2026-09-01, 2026-10-23)"""
    if not text:
        return None, None
    year_match = re.search(r"(\d{4})", text)
    year = int(year_match.group(1)) if year_match else date.today().year
    parts = re.split(r"\s*[-–]\s*", text)
    start = parse_date(parts[0], default_year=year) if parts else None
    end = parse_date(parts[-1], default_year=year) if len(parts) > 1 else None
    return start, end


def source_hackerearth(fetcher: Fetcher) -> list[Event]:
    """HackerEarth publishes its live challenge feed as JSON."""
    payload = fetcher.get("https://www.hackerearth.com/chrome-extension/events/", as_json=True)
    if not payload:
        return []
    items = payload.get("response", payload) if isinstance(payload, dict) else payload
    events: list[Event] = []
    for item in items if isinstance(items, list) else []:
        event = Event(
            title=clean(item.get("title"), 200),
            source="HackerEarth",
            url=clean(item.get("url"), 400),
            source_id=clean(str(item.get("url") or "").rstrip("/").rsplit("/", 1)[-1], 80),
            start=parse_date(item.get("start_tz") or item.get("date")),
            end=parse_date(item.get("end_tz") or item.get("end_date")),
            deadline=parse_date(item.get("end_tz") or item.get("end_date")),
            mode="online",
            location="Online",
            description=clean(strip_html(str(item.get("description") or "")), 300),
            domains=[clean(str(item.get("challenge_type") or "").replace("_", " ").title(), 40)] or [],
        )
        event.registration_url = clean(item.get("subscribe") or item.get("url"), 400)
        event.poster = Poster(url=clean(item.get("thumbnail"), 400))
        if event.title and event.url:
            events.append(event)
    return events[:MAX_PER_SOURCE]


def source_hackindia(fetcher: Fetcher) -> list[Event]:
    """HackIndia event pages, discovered through the sitemap.

    Their robots.txt disallows /api/, so the JSON endpoint is deliberately not used;
    the sitemap and the event pages themselves are explicitly allowed.
    """
    index = fetcher.get("https://hackindia.org/sitemap.xml")
    if not index:
        return []
    sub_sitemaps = re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", index)
    year = date.today().year
    pages: list[str] = []
    for sitemap_url in sub_sitemaps[:6]:
        body = fetcher.get(sitemap_url)
        if not body:
            continue
        for loc in re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", body):
            # Event pages look like /2026/<slug>; skip /teams and /news sub-pages.
            if re.search(rf"/({year}|{year + 1})/[a-z0-9-]+/?$", loc):
                pages.append(loc)
    events: list[Event] = []
    for url in list(dict.fromkeys(pages))[:120]:
        markup = fetcher.get(url)
        if not markup:
            continue
        events.append(_event_from_page(markup, url, "HackIndia"))
    return events


def source_devfolio(fetcher: Fetcher) -> list[Event]:
    """Devfolio lists each hackathon on its own subdomain; the listing page names them."""
    listing = fetcher.get("https://devfolio.co/hackathons")
    if not listing:
        return []
    slugs = sorted(set(re.findall(r"https?://([a-z0-9][a-z0-9-]{2,})\.devfolio\.co", listing, re.I)))
    ignore = {"api", "assets", "guide", "www", "blog", "help", "docs", "cdn"}
    events: list[Event] = []
    for slug in [s for s in slugs if s.lower() not in ignore][:60]:
        url = f"https://{slug}.devfolio.co/"
        markup = fetcher.get(url)
        if not markup:
            continue
        events.append(_event_from_page(markup, url, "Devfolio"))
    return events


def source_sih(fetcher: Fetcher) -> list[Event]:
    """Smart India Hackathon - one national programme, read from the official portal."""
    url = "https://www.sih.gov.in/"
    markup = fetcher.get(url)
    if not markup:
        return []
    event = _event_from_page(markup, url, "Smart India Hackathon")
    event.title = event.title or "Smart India Hackathon"
    event.scope = "national"
    event.organizer = "Ministry of Education, Government of India"
    event.location = "India (nationwide)"
    event.eligibility = event.eligibility or "Students of AICTE-approved institutions across India"
    return [event]


def source_hack2skill(fetcher: Fetcher) -> list[Event]:
    """Hack2Skill event pages linked from the homepage."""
    home = fetcher.get("https://hack2skill.com/")
    if not home:
        return []
    links = [
        link
        for link in collect_links(home, "https://hack2skill.com/")
        if re.search(r"hack2skill\.com/(event|hackathon)/[a-z0-9-]+", link, re.I)
    ]
    events: list[Event] = []
    for url in list(dict.fromkeys(links))[:30]:
        markup = fetcher.get(url)
        if not markup:
            continue
        event = _event_from_page(markup, url, "Hack2Skill")
        if event.title:
            events.append(event)
    return events


def source_mlh(fetcher: Fetcher) -> list[Event]:
    """MLH's season page, read from its schema.org microdata.

    Each card is one `<a itemType="https://schema.org/Event">` carrying its own `startDate`,
    `endDate`, `image` and `location` meta tags. Parsing whole blocks matters: an earlier
    attempt here keyed on the link and read the surrounding markup, which silently paired
    each title with the *previous* card and put Texas hackathons in New Delhi.
    """
    today = date.today()
    season = today.year + 1 if today.month >= 9 else today.year
    markup = fetcher.get(f"https://mlh.io/seasons/{season}/events")
    if not markup:
        return []
    anchors = list(re.finditer(r'<a\b[^>]*itemType="https?://schema\.org/Event"[^>]*>', markup, re.I))
    events: list[Event] = []
    for index, anchor in enumerate(anchors[:MAX_PER_SOURCE]):
        block_end = anchors[index + 1].start() if index + 1 < len(anchors) else len(markup)
        block = markup[anchor.start() : block_end]
        href = re.search(r'href="([^"]+)"', anchor.group(0))
        if not href:
            continue
        url = html_lib.unescape(href.group(1))
        name_param = re.search(r"utm_content=([^&\"]+)", url)
        title = clean(unquote_plus(name_param.group(1)) if name_param else "", 200)
        if not title:
            continue
        location = re.search(r'itemProp="location".*?<span itemProp="name">(.*?)</span>', block, re.I | re.S)
        event = Event(
            title=title,
            source="MLH",
            url=url.split("?")[0],
            source_id=re.sub(r"[^a-z0-9]+", "-", title.lower()),
            organizer="Major League Hacking",
            start=parse_date(_microdata(block, "startDate")),
            end=parse_date(_microdata(block, "endDate")),
            location=clean(re.sub(r"<!--.*?-->", "", location.group(1)) if location else "", 120),
            mode="online" if "Online" in _microdata(block, "eventAttendanceMode") else "offline",
            description=clean(strip_html(block), 200),
        )
        image = _microdata(block, "image")
        if image and not any(word in image.lower() for word in POSTER_NOISE):
            event.poster = Poster(url=urljoin("https://mlh.io/", image))
        events.append(event)
    return events


def _microdata(block: str, prop: str) -> str:
    match = re.search(rf'<meta[^>]+itemProp="{prop}"[^>]+content="([^"]*)"', block, re.I)
    if not match:
        match = re.search(rf'<meta[^>]+content="([^"]*)"[^>]+itemProp="{prop}"', block, re.I)
    return html_lib.unescape(match.group(1)) if match else ""


def _event_from_page(markup: str, url: str, source: str) -> Event:
    """Build an event from an ordinary HTML event page (meta tags + visible text)."""
    text = strip_html(markup)
    title = clean(meta_content(markup, "og:title") or page_title(markup), 200)
    title = re.sub(r"\s*[|\-–]\s*(Devfolio|HackIndia|Hack2Skill|Unstop).*$", "", title, flags=re.I).strip()
    event = Event(
        title=title,
        source=source,
        url=url,
        source_id=urlparse(url).path.strip("/").replace("/", "-") or urlparse(url).netloc,
        # og:description often carries raw markup; it must be reduced to text before display.
        description=clean(strip_html(meta_content(markup, "og:description", "description")), 300),
        domains=_keyword_domains(markup),
    )
    event.registration_url = _register_link(markup, url)
    event.poster = Poster(url=find_poster_url(markup, url))
    dates = _dates_in_text(text)
    if dates:
        event.start = dates[0]
        if len(dates) > 1:
            event.end = dates[-1]
    event.deadline = _labelled_date(text, ("registration deadline", "registration closes", "apply by", "last date",
                                           "registration ends")) or event.deadline
    event.mode = _mode_from_text(text)
    event.location = _location_from_text(text)
    event.fee = _first(text, r"(?:fee|registration fee)\s*[:\-]?\s*(₹\s?[\d,]+|free)")
    event.prize = _first(text, r"(?:prize pool|prizes? worth|cash prize)\s*[:\-]?\s*(₹\s?[\d,.]+\s*(?:lakh|crore|k)?)")
    event.team_size = _first(text, r"team\s*(?:size)?\s*[:\-]?\s*(\d+\s*(?:-|to)\s*\d+|\d+)")
    event.eligibility = _first(text, r"eligibilit(?:y|ies)\s*[:\-]\s*(.{10,180})")
    return event


DOMAIN_VOCABULARY = (
    "AI", "ML", "AI/ML", "Machine Learning", "Artificial Intelligence", "Deep Learning", "GenAI",
    "Data Science", "Analytics", "Web3", "Blockchain", "Cybersecurity", "IoT", "Robotics",
    "Full stack", "Web", "Web Development", "App Development", "Mobile", "Cloud", "DevOps",
    "AR/VR", "Gaming", "FinTech", "HealthTech", "EdTech", "AgriTech", "Sustainability",
    "Open Innovation", "Product Design", "UI/UX", "Hardware", "Embedded", "Quantum",
)


def _keyword_domains(markup: str) -> list[str]:
    """Domain tags from the page's own keywords meta, matched against a known vocabulary."""
    raw = meta_content(markup, "keywords", "article:tag")
    found: list[str] = []
    haystack = f"{raw} {meta_content(markup, 'og:description', 'description')}".lower()
    for term in DOMAIN_VOCABULARY:
        if re.search(rf"\b{re.escape(term.lower())}\b", haystack) and term not in found:
            found.append(term)
    return found[:4]


def _register_link(markup: str, base_url: str) -> str:
    """The page's own register/apply button, when it has one."""
    for match in re.finditer(r'<a[^>]+href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', markup or "", re.I | re.S):
        label = strip_html(match.group(2))
        if re.search(r"\b(register|apply|participate|sign\s?up|join now)\b", label, re.I):
            link = urljoin(base_url, html_lib.unescape(match.group(1)))
            if link.startswith(("http://", "https://")):
                return link
    return base_url


def _dates_in_text(text: str) -> list[date]:
    found: list[date] = []
    for pattern in DATE_PATTERNS:
        for match in re.finditer(pattern, text, re.I):
            parsed = parse_date(match.group(0))
            if parsed and parsed not in found:
                found.append(parsed)
    horizon = date.today() + timedelta(days=400)
    found = [d for d in found if date.today() - timedelta(days=60) <= d <= horizon]
    return sorted(found)


def _labelled_date(text: str, labels: Iterable[str]) -> date | None:
    for label in labels:
        match = re.search(rf"{re.escape(label)}.{{0,60}}?({'|'.join(DATE_PATTERNS)})", text, re.I)
        if match:
            parsed = parse_date(match.group(1))
            if parsed:
                return parsed
    return None


def _mode_from_text(text: str) -> str:
    lower = f" {text.lower()} "
    online = "online" in lower or "virtual" in lower
    offline = any(word in lower for word in ("offline", "in-person", "on-campus", "venue"))
    if online and offline:
        return "hybrid"
    if online:
        return "online"
    if offline:
        return "offline"
    return "unknown"


def _location_from_text(text: str) -> str:
    lower = text.lower()
    for word in INDIA_WORDS:
        if word in lower and len(word) > 4:
            return word.title()
    return ""


def _first(text: str, pattern: str) -> str:
    match = re.search(pattern, text, re.I)
    return clean(match.group(1), 200) if match else ""


# Standing national programmes worth listing even before their dates are announced.
# Anything here survives the date window and is shown with "dates to be announced".
ALWAYS_KEEP_SOURCES = {"Smart India Hackathon"}

SOURCES = (
    ("Unstop", source_unstop),
    ("Devpost", source_devpost),
    ("HackerEarth", source_hackerearth),
    ("HackIndia", source_hackindia),
    ("Devfolio", source_devfolio),
    ("Smart India Hackathon", source_sih),
    ("Hack2Skill", source_hack2skill),
    ("MLH", source_mlh),
)


# ============================================================================
# NEW / OLD memory
# ============================================================================


def load_state() -> dict[str, dict]:
    if not STATE_FILE.exists():
        return {}
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        log.warning("State file unreadable; starting a fresh history.")
        return {}


def save_state(state: dict[str, dict]) -> None:
    try:
        STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
    except OSError as exc:
        log.error("Could not save %s: %s", STATE_FILE.name, exc)


def apply_history(events: list[Event], state: dict[str, dict]) -> tuple[int, int]:
    """Mark each event NEW or OLD and update the run history. Returns (new, old)."""
    today = date.today().isoformat()
    new_count = old_count = 0
    for event in events:
        key = event.key()
        record = state.get(key)
        if record is None:
            event.status = "NEW"
            event.first_seen = today
            event.times_seen = 1
            new_count += 1
        else:
            event.status = "OLD"
            event.first_seen = record.get("first_seen", today)
            event.times_seen = int(record.get("times_seen", 1)) + 1
            old_count += 1
        event.last_seen = today
        state[key] = {
            "title": event.title,
            "source": event.source,
            "url": event.url,
            "first_seen": event.first_seen,
            "last_seen": today,
            "times_seen": event.times_seen,
        }
    return new_count, old_count


# ============================================================================
# Output: Excel, CSV, JSON, HTML
# ============================================================================

FILL_NEW = PatternFill("solid", fgColor="C6EFCE")
FILL_OLD = PatternFill("solid", fgColor="F2F2F2")
FILL_HEADER = PatternFill("solid", fgColor="1F6B45")
FONT_HEADER = Font(color="FFFFFF", bold=True, size=11)
FONT_NEW = Font(color="0B6A32", bold=True)
FONT_OLD = Font(color="6B6B6B")
FONT_LINK = Font(color="1155CC", underline="single")
THIN = Side(style="thin", color="D5D5D5")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
COLUMN_WIDTHS = {
    "Status": 9, "Kind": 17, "Title": 46, "Scope": 17, "Type": 22, "Source": 15, "Starts": 12, "Ends": 12,
    "Registration deadline": 20, "Days left": 11, "Mode": 10, "Location": 22, "Organizer": 30,
    "Domain": 30, "Prize": 14, "Fee": 10, "Team size": 11, "Eligibility": 34, "Website": 46, "Register": 46,
    "Poster": 40, "Poster check": 18, "First seen": 12, "Last seen": 12, "Times seen": 11,
}


def write_outputs(events: list[Event], summary: dict, quiet: bool) -> list[str]:
    """Write every report. A file locked by Excel is written beside it, never lost."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    problems: list[str] = []
    stamp = date.today().isoformat()
    rows = [event.to_row() for event in events]

    _safe_write(OUTPUT_DIR / "hackathons.json",
                json.dumps([_event_json(e) for e in events], indent=2, ensure_ascii=False), problems)
    _safe_write(OUTPUT_DIR / "hackathons.csv", _csv_text(rows), problems, encoding="utf-8-sig")
    _safe_write(OUTPUT_DIR / "report.html", _html_report(events, summary), problems)
    _safe_write(OUTPUT_DIR / "run_summary.json", json.dumps(summary, indent=2, ensure_ascii=False), problems)

    workbook = _build_workbook(events, summary)
    for target in (OUTPUT_DIR / f"hackathons_{stamp}.xlsx", OUTPUT_DIR / "hackathons_latest.xlsx"):
        _safe_save_workbook(workbook, target, problems)

    if not quiet:
        for problem in problems:
            log.warning("  %s", problem)
    return problems


def _event_json(event: Event) -> dict:
    data = asdict(event)
    for key in ("start", "end", "deadline"):
        data[key] = _iso(getattr(event, key))
    # The same identity used for NEW/OLD tracking, so a database can upsert on it.
    data["key"] = event.key()
    return data


def _csv_text(rows: list[dict]) -> str:
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=COLUMNS, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    return buffer.getvalue()


def _safe_write(path: Path, content: str, problems: list[str], encoding: str = "utf-8") -> None:
    try:
        path.write_text(content, encoding=encoding, newline="")
        return
    except OSError as exc:
        reason = type(exc).__name__
    fallback = path.with_name(f"{path.stem}-new{path.suffix}")
    try:
        fallback.write_text(content, encoding=encoding, newline="")
        problems.append(f"{path.name} is open elsewhere ({reason}); wrote {fallback.name} instead")
    except OSError as exc:
        problems.append(f"could not write {path.name}: {type(exc).__name__}: {exc}")


def _safe_save_workbook(workbook: Workbook, path: Path, problems: list[str]) -> None:
    try:
        workbook.save(path)
        return
    except OSError as exc:
        reason = type(exc).__name__
    fallback = path.with_name(f"{path.stem}-new{path.suffix}")
    try:
        workbook.save(fallback)
        problems.append(f"{path.name} is open in Excel ({reason}); wrote {fallback.name} instead")
    except OSError as exc:
        problems.append(f"could not write {path.name}: {type(exc).__name__}: {exc}")


def _build_workbook(events: list[Event], summary: dict) -> Workbook:
    workbook = Workbook()
    # Hackathons and hiring challenges get a sheet each - they are answers to different
    # questions ("what can I build this weekend" vs "who is recruiting").
    _sheet_events(workbook.active, [e for e in events if e.kind == "open"], "Hackathons")
    _sheet_events(workbook.create_sheet("Hiring Challenges"),
                  [e for e in events if e.kind == "hiring"], "Hiring Challenges")
    _sheet_summary(workbook.create_sheet("Summary"), summary, events)
    _sheet_posters(workbook.create_sheet("Posters"), events)
    return workbook


def _sheet_events(sheet, events: list[Event], title: str) -> None:
    sheet.title = title
    sheet.append(COLUMNS)
    for index, column in enumerate(COLUMNS, start=1):
        cell = sheet.cell(row=1, column=index)
        cell.fill, cell.font, cell.border = FILL_HEADER, FONT_HEADER, BORDER
        cell.alignment = Alignment(vertical="center", horizontal="center", wrap_text=True)
        sheet.column_dimensions[get_column_letter(index)].width = COLUMN_WIDTHS.get(column, 18)
    sheet.row_dimensions[1].height = 28

    link_columns = {COLUMNS.index(name) + 1 for name in ("Website", "Register", "Poster")}
    wrap_columns = {COLUMNS.index(name) + 1 for name in ("Title", "Eligibility")}
    for event in events:
        row = event.to_row()
        sheet.append([row[name] for name in COLUMNS])
        row_index = sheet.max_row
        is_new = event.status == "NEW"
        for column_index in range(1, len(COLUMNS) + 1):
            cell = sheet.cell(row=row_index, column=column_index)
            cell.fill = FILL_NEW if is_new else FILL_OLD
            cell.border = BORDER
            cell.alignment = Alignment(vertical="top", wrap_text=column_index in wrap_columns)
            if column_index == 1:
                cell.font = FONT_NEW if is_new else FONT_OLD
                cell.alignment = Alignment(horizontal="center", vertical="center")
            elif column_index in link_columns and cell.value:
                cell.hyperlink = str(cell.value)
                cell.font = FONT_LINK
    sheet.freeze_panes = "B2"
    if events:
        sheet.auto_filter.ref = f"A1:{get_column_letter(len(COLUMNS))}{sheet.max_row}"


def _sheet_summary(sheet, summary: dict, events: list[Event]) -> None:
    sheet.column_dimensions["A"].width = 34
    sheet.column_dimensions["B"].width = 58
    lines: list[tuple[str, Any]] = [
        ("India Hackathon & Competition Tracker", ""),
        ("Generated", summary.get("generated_at", "")),
        ("Window", f"{summary.get('window_start')} to {summary.get('window_end')}"),
        ("Coverage", summary.get("coverage", "India only")),
        ("", ""),
        ("Total events", len(events)),
        ("   Hackathons", sum(1 for e in events if e.kind == "open")),
        ("   Hiring challenges", sum(1 for e in events if e.kind == "hiring")),
        ("NEW this run", sum(1 for e in events if e.status == "NEW")),
        ("OLD (seen before)", sum(1 for e in events if e.status == "OLD")),
        ("Posters verified", sum(1 for e in events if e.poster.status == "ok")),
        ("Thumbnails only", sum(1 for e in events if e.poster.status == "thumbnail")),
        ("", ""),
        ("By scope", ""),
    ]
    for scope in SCOPES:
        count = sum(1 for e in events if e.scope == scope)
        if count:
            lines.append((f"   {SCOPE_LABELS[scope]}", count))
    lines.append(("", ""))
    lines.append(("By source", ""))
    for name, count in sorted(summary.get("per_source", {}).items(), key=lambda kv: -kv[1]):
        lines.append((f"   {name}", count))
    errors = summary.get("errors", [])
    lines.extend([("", ""), ("Errors", len(errors))])
    lines.extend((f"   {index}", clean(message, 200)) for index, message in enumerate(errors[:25], start=1))

    for label, value in lines:
        sheet.append([label, value])
    sheet["A1"].font = Font(bold=True, size=14, color="1F6B45")
    for row in range(1, sheet.max_row + 1):
        if sheet.cell(row=row, column=2).value == "" and sheet.cell(row=row, column=1).value:
            sheet.cell(row=row, column=1).font = Font(bold=True)


def _sheet_posters(sheet, events: list[Event]) -> None:
    sheet.append(["Status", "Title", "Poster", "Check", "Poster URL"])
    for cell in sheet[1]:
        cell.fill, cell.font, cell.border = FILL_HEADER, FONT_HEADER, BORDER
    for width, column in zip((9, 44, 30, 20, 60), "ABCDE", strict=True):
        sheet.column_dimensions[column].width = width

    with_posters = [e for e in events if e.poster.status in USABLE_POSTER_STATUSES]
    for event in with_posters:
        sheet.append([
            event.status,
            event.title,
            "",
            f"{event.poster.status} {event.poster.width}x{event.poster.height}",
            event.poster.url,
        ])
        row = sheet.max_row
        sheet.row_dimensions[row].height = 90
        sheet.cell(row=row, column=1).fill = FILL_NEW if event.status == "NEW" else FILL_OLD
        if CAN_EMBED_IMAGES and event.poster.file:
            path = OUTPUT_DIR / event.poster.file
            if path.exists():
                try:
                    image = XLImage(str(path))
                    ratio = 115 / max(image.height, 1)
                    image.height, image.width = 115, int(image.width * ratio)
                    sheet.add_image(image, f"C{row}")
                except Exception as exc:  # a corrupt image must not lose the workbook
                    sheet.cell(row=row, column=3).value = f"(could not embed: {type(exc).__name__})"
    if not with_posters:
        sheet.append(["", "No verified posters in this run.", "", "", ""])
    elif not CAN_EMBED_IMAGES:
        sheet.append(["", "Install Pillow (pip install pillow) to embed poster images here.", "", "", ""])


def _registration_state(event: Event) -> tuple[str, str]:
    """(label, css class) for the badge that says whether you can still enter."""
    today = date.today()
    closing = event.deadline or event.end
    if closing and closing < today:
        return "CLOSED", "closed"
    if event.start and event.start <= today <= (event.end or event.start):
        return "LIVE", "live"
    if closing:
        days = (closing - today).days
        return (f"CLOSES IN {days} DAY{'S' if days != 1 else ''}" if days <= 7 else "REGISTERING"), "open"
    if not (event.start or event.end or event.deadline):
        return "DATES TBA", "tba"
    return "UPCOMING", "open"


def _card(event: Event) -> str:
    esc = html_lib.escape
    poster = event.poster
    if poster.status in USABLE_POSTER_STATUSES:
        media = (
            f'<img loading="lazy" src="{esc(poster.url, quote=True)}" '
            f'alt="{esc(event.title)} poster">'
        )
    else:
        media = f'<div class="noposter"><span>{esc(event.title[:40])}</span></div>'
    state, state_class = _registration_state(event)
    venue = event.location or ("Virtual" if event.mode == "online" else "Venue to be announced")
    dates = (
        f'<b>{_iso(event.start) or "TBA"}</b> &rarr; <b>{_iso(event.end) or "TBA"}</b>'
        if (event.start or event.end)
        else "<b>Dates to be announced</b>"
    )
    deadline = (
        f'<div class="row"><span class="k">Register by</span><span class="v deadline">{_iso(event.deadline)}</span></div>'
        if event.deadline
        else ""
    )
    tags = "".join(f'<span class="tag">{esc(name)}</span>' for name in (event.domains or event.categories)[:4])
    prize = (
        f'<div class="prize">{esc(event.prize)}</div><div class="plabel">PRIZE</div>'
        if event.prize
        else '<div class="prize muted">Prize TBA</div><div class="plabel">PRIZE</div>'
    )
    people = f'<div class="builders">{esc(event.participants)} registered</div>' if event.participants else ""
    search_blob = esc(
        " ".join(
            (event.title, event.location, event.organizer, event.source, event.status,
             KIND_LABELS.get(event.kind, ""), " ".join(event.domains), " ".join(event.categories))
        ).lower()
    )
    hiring_flag = '<span class="flag hiring">HIRING</span>' if event.kind == "hiring" else ""
    return f"""<article class="card" data-status="{event.status}" data-kind="{esc(event.kind)}" data-scope="{esc(event.scope)}" data-search="{search_blob}">
  <div class="media"><span class="flag {event.status.lower()}">{event.status}</span>{hiring_flag}{media}</div>
  <div class="body">
    <div class="venue">{esc(venue.upper())}</div>
    <h3>{esc(event.title)}</h3>
    <div class="priceline">{prize}{people}<span class="state {state_class}">{esc(state)}</span></div>
    <div class="rows">
      <div class="row"><span class="k">Dates</span><span class="v">{dates}</span></div>
      {deadline}
      <div class="row"><span class="k">Mode</span><span class="v">{esc(event.mode.title())} &middot; {esc(SCOPE_LABELS.get(event.scope, event.scope))}</span></div>
      <div class="row"><span class="k">Eligible</span><span class="v">{esc(event.eligibility)}</span></div>
      <div class="row"><span class="k">Source</span><span class="v">{esc(event.source)}</span></div>
    </div>
    <div class="tags">{tags}</div>
    <div class="actions">
      <a class="btn ghost" href="{esc(event.url, quote=True)}" target="_blank" rel="noopener">Event page</a>
      <a class="btn primary" href="{esc(event.registration_url or event.url, quote=True)}" target="_blank" rel="noopener">Register Now</a>
    </div>
  </div>
</article>"""


def _html_report(events: list[Event], summary: dict) -> str:
    """The page the user actually reads: NEW at the top, OLD underneath."""
    esc = html_lib.escape
    hackathons = [e for e in events if e.kind == "open"]
    hiring = [e for e in events if e.kind == "hiring"]
    new_events = [e for e in events if e.status == "NEW"]
    old_events = [e for e in events if e.status != "NEW"]
    generated = summary.get("generated_at", "")[:16].replace("T", " ")

    def section(anchor: str, title: str, blurb: str, group: list[Event], tone: str) -> str:
        if not group:
            return ""
        cards = "".join(_card(event) for event in group)
        return f"""<section id="{anchor}" class="band {tone}">
  <div class="bandhead"><h2>{title} <span class="count">{len(group)}</span></h2><p>{blurb}</p></div>
  <div class="grid">{cards}</div>
</section>"""

    def group_block(anchor: str, heading: str, note: str, group: list[Event], tone: str) -> str:
        if not group:
            return ""
        fresh = [e for e in group if e.status == "NEW"]
        seen = [e for e in group if e.status != "NEW"]
        return f"""<div class="groupwrap" id="{anchor}">
  <div class="grouphead {tone}"><h2>{heading} <span class="gcount">{len(group)}</span></h2><p>{note}</p></div>
  {section(f"{anchor}-new", "New", "Found for the first time - not in any earlier run.", fresh, "fresh")}
  {section(f"{anchor}-old", "Previously seen", "Recorded in an earlier run and still open.", seen, "seen")}
</div>"""

    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>India Hackathons - New &amp; Previously Seen</title><style>
:root{{--ink:#101826;--muted:#6b7684;--bg:#f6f7f9;--card:#fff;--line:#e4e7ec;--orange:#f15a24;
--green:#12855a;--grey:#8a929c;--dark:#16202b}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}}
a{{text-decoration:none}}
.topbar{{background:var(--dark);color:#fff;position:sticky;top:0;z-index:30;box-shadow:0 2px 14px #0003}}
.topinner{{max-width:1320px;margin:auto;padding:14px 22px;display:flex;align-items:center;gap:18px;flex-wrap:wrap}}
.brand{{display:flex;align-items:center;gap:10px;font-weight:800;font-size:1.15rem;letter-spacing:-.01em}}
.mark{{width:30px;height:30px;border-radius:7px;background:var(--orange);display:grid;place-items:center;font-weight:900;color:#fff}}
.navlinks{{display:flex;gap:16px;margin-left:auto;flex-wrap:wrap}}
.navlinks a{{color:#c9d2dc;font-size:.92rem;font-weight:600}}.navlinks a:hover{{color:#fff}}
.hero{{max-width:1320px;margin:auto;padding:30px 22px 10px}}
h1{{font-size:clamp(1.7rem,4vw,2.6rem);margin:.1em 0 .25em;letter-spacing:-.02em}}
.sub{{color:var(--muted);max-width:760px;margin:0}}
.stats{{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0 4px}}
.stat{{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 16px;min-width:108px}}
.stat b{{display:block;font-size:1.5rem;line-height:1.1}}
.stat span{{color:var(--muted);font-size:.78rem;text-transform:uppercase;letter-spacing:.05em}}
.toolbar{{max-width:1320px;margin:auto;padding:8px 22px 0;display:flex;gap:10px;flex-wrap:wrap;align-items:center}}
#q{{flex:1;min-width:230px;padding:11px 14px;border:1px solid var(--line);border-radius:10px;font-size:.95rem;background:var(--card)}}
.chipbtn{{border:1px solid var(--line);background:var(--card);border-radius:99px;padding:9px 16px;font-size:.87rem;
font-weight:600;cursor:pointer;color:var(--ink)}}
.chipbtn.on{{background:var(--dark);color:#fff;border-color:var(--dark)}}
.group{{display:flex;gap:8px;flex-wrap:wrap}}
.groupwrap{{border-top:1px solid var(--line);margin-top:26px}}
.grouphead{{max-width:1320px;margin:auto;padding:26px 22px 0;border-left:5px solid transparent}}
.grouphead h2{{font-size:1.65rem;margin:0 0 4px;display:flex;align-items:center;gap:11px;letter-spacing:-.01em}}
.grouphead p{{color:var(--muted);margin:0;max-width:720px;font-size:.92rem}}
.gcount{{font-size:.85rem;color:#fff;border-radius:99px;padding:4px 13px;font-weight:700;background:var(--dark)}}
.tone-open .gcount{{background:var(--green)}}.tone-hiring .gcount{{background:#8250c8}}
.band{{max-width:1320px;margin:auto;padding:18px 22px 8px}}
.bandhead h2{{font-size:1.08rem;margin:0 0 2px;display:flex;align-items:center;gap:10px;color:var(--muted);
text-transform:uppercase;letter-spacing:.06em;font-weight:800}}
.bandhead p{{color:var(--muted);margin:0 0 16px;font-size:.9rem}}
.count{{font-size:.8rem;background:var(--dark);color:#fff;border-radius:99px;padding:3px 11px;font-weight:700}}
.band.fresh .count{{background:var(--green)}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(318px,1fr));gap:22px}}
.card{{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;display:flex;
flex-direction:column;transition:transform .13s ease,box-shadow .13s ease}}
.card:hover{{transform:translateY(-3px);box-shadow:0 12px 26px #10182615}}
.media{{position:relative;background:#eef1f4}}
.media img{{width:100%;aspect-ratio:16/9;object-fit:cover;display:block}}
.noposter{{aspect-ratio:16/9;display:grid;place-items:center;padding:16px;text-align:center;color:#fff;font-weight:700;
background:linear-gradient(135deg,#243447,#3c5570)}}
.flag{{position:absolute;top:10px;left:10px;z-index:2;font-size:.68rem;font-weight:800;letter-spacing:.09em;
padding:5px 11px;border-radius:99px;color:#fff;box-shadow:0 2px 8px #0000002e}}
.flag.new{{background:var(--green)}}.flag.old{{background:var(--grey)}}
.flag.hiring{{left:auto;right:10px;background:#8250c8}}
.body{{padding:15px 17px 17px;display:flex;flex-direction:column;gap:9px;flex:1}}
.venue{{color:var(--muted);font-size:.7rem;font-weight:700;letter-spacing:.09em}}
h3{{font-size:1.06rem;line-height:1.3;margin:0;min-height:2.6em}}
.priceline{{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap}}
.prize{{color:var(--orange);font-weight:800;font-size:1.06rem}}.prize.muted{{color:var(--muted);font-weight:600;font-size:.95rem}}
.plabel{{color:var(--muted);font-size:.66rem;letter-spacing:.09em;font-weight:700}}
.builders{{color:var(--muted);font-size:.78rem}}
.state{{margin-left:auto;font-size:.66rem;font-weight:800;letter-spacing:.06em;padding:4px 9px;border-radius:5px}}
.state.live{{background:#e7f7ef;color:var(--green)}}.state.open{{background:#fff1e9;color:var(--orange)}}
.state.closed{{background:#f1f2f4;color:var(--grey)}}.state.tba{{background:#eef2fb;color:#42618f}}
.rows{{display:flex;flex-direction:column;gap:5px;border-top:1px solid var(--line);padding-top:10px}}
.row{{display:flex;gap:10px;font-size:.83rem;align-items:baseline}}
.k{{color:var(--muted);min-width:74px;flex-shrink:0}}
.v{{color:var(--ink);overflow-wrap:anywhere}}
.v.deadline{{color:var(--orange);font-weight:700}}
.tags{{display:flex;gap:6px;flex-wrap:wrap}}
.tag{{background:#f2f4f7;border:1px solid var(--line);border-radius:6px;padding:3px 9px;font-size:.73rem;color:#42505f}}
.actions{{display:flex;gap:9px;margin-top:auto;padding-top:4px}}
.btn{{flex:1;text-align:center;padding:11px 10px;border-radius:9px;font-weight:700;font-size:.88rem}}
.btn.primary{{background:var(--orange);color:#fff}}.btn.primary:hover{{background:#d94a17}}
.btn.ghost{{background:var(--card);color:var(--ink);border:1px solid var(--line)}}.btn.ghost:hover{{border-color:var(--muted)}}
.empty{{text-align:center;color:var(--muted);padding:40px 0}}
footer{{max-width:1320px;margin:auto;padding:30px 22px 50px;color:var(--muted);font-size:.85rem;border-top:1px solid var(--line);margin-top:30px}}
@media(max-width:560px){{.grid{{grid-template-columns:1fr}}h3{{min-height:0}}}}
</style></head><body>
<div class="topbar"><div class="topinner">
  <div class="brand"><span class="mark">H</span> KLU Hackathon Tracker</div>
  <nav class="navlinks"><a href="#hackathons">Hackathons</a><a href="#hiring">Hiring challenges</a>
  <a href="hackathons_latest.xlsx">Excel</a><a href="hackathons.csv">CSV</a></nav>
</div></div>

<div class="hero">
  <h1>Hackathons &amp; competitions in India</h1>
  <p class="sub">Every event below is in India, inside the {esc(str(summary.get('window_start')))} to
  {esc(str(summary.get('window_end')))} window. Newly found events are at the top; ones seen in an
  earlier run are further down. Confirm dates and eligibility on the official page before applying.</p>
  <div class="stats">
    <div class="stat"><b>{len(hackathons)}</b><span>Hackathons</span></div>
    <div class="stat"><b>{len(hiring)}</b><span>Hiring challenges</span></div>
    <div class="stat"><b>{len(new_events)}</b><span>New</span></div>
    <div class="stat"><b>{len(old_events)}</b><span>Seen before</span></div>
    <div class="stat"><b>{sum(1 for e in events if e.poster.status in USABLE_POSTER_STATUSES)}</b><span>Posters</span></div>
  </div>
</div>

<div class="toolbar">
  <input id="q" type="search" placeholder="Search by name, college, city, domain...">
  <span class="group">
    <button class="chipbtn on" data-kind="all">Both</button>
    <button class="chipbtn" data-kind="open">Hackathons</button>
    <button class="chipbtn" data-kind="hiring">Hiring only</button>
  </span>
  <span class="group">
    <button class="chipbtn on" data-filter="all">All</button>
    <button class="chipbtn" data-filter="NEW">New only</button>
    <button class="chipbtn" data-filter="OLD">Old only</button>
  </span>
</div>

{group_block("hackathons", "Hackathons &amp; competitions",
             "Open contests you enter to build something and win a prize.", hackathons, "tone-open")}
{group_block("hiring", "Hiring challenges",
             "Run by companies to recruit. You compete for a job, often against working professionals - "
             "check the experience requirements before spending a weekend on one.", hiring, "tone-hiring")}
<p class="empty" id="noresults" hidden>Nothing matches that search.</p>

<footer>Generated {esc(generated)} &middot; {esc(str(summary.get('coverage', 'India only')))} &middot;
{len(summary.get('errors', []))} source errors. Posters are fetched and checked before being shown.
Always verify details on the official page before applying or paying.</footer>

<script>
const cards = [...document.querySelectorAll('.card')];
const search = document.getElementById('q');
const statusButtons = [...document.querySelectorAll('.chipbtn[data-filter]')];
const kindButtons = [...document.querySelectorAll('.chipbtn[data-kind]')];
const noresults = document.getElementById('noresults');
let mode = 'all';
let kind = 'all';

function apply() {{
  const term = search.value.trim().toLowerCase();
  let shown = 0;
  cards.forEach(card => {{
    const okMode = mode === 'all' || card.dataset.status === mode;
    const okKind = kind === 'all' || card.dataset.kind === kind;
    const okTerm = !term || card.dataset.search.includes(term);
    const show = okMode && okKind && okTerm;
    card.style.display = show ? '' : 'none';
    if (show) shown++;
  }});
  // Hide a band, then its whole group, when nothing inside survives the filter.
  document.querySelectorAll('.band').forEach(band => {{
    band.hidden = ![...band.querySelectorAll('.card')].some(c => c.style.display !== 'none');
  }});
  document.querySelectorAll('.groupwrap').forEach(group => {{
    group.hidden = ![...group.querySelectorAll('.card')].some(c => c.style.display !== 'none');
  }});
  noresults.hidden = shown > 0;
}}

function wire(buttons, setter) {{
  buttons.forEach(button => button.addEventListener('click', () => {{
    buttons.forEach(other => other.classList.toggle('on', other === button));
    setter(button);
    apply();
  }}));
}}
search.addEventListener('input', apply);
wire(statusButtons, b => {{ mode = b.dataset.filter; }});
wire(kindButtons, b => {{ kind = b.dataset.kind; }});
</script>
</body></html>"""


# ============================================================================
# Main
# ============================================================================


def collect(fetcher: Fetcher, chosen: set[str], quiet: bool) -> tuple[list[Event], dict[str, int]]:
    events: list[Event] = []
    per_source: dict[str, int] = {}
    for name, function in SOURCES:
        if chosen and name.lower() not in chosen:
            continue
        log.info("[source] %s", name)
        try:
            found = function(fetcher)
        except Exception as exc:  # one broken site must not end the run
            fetcher.errors.append(f"{name}: {type(exc).__name__}: {exc}")
            log.warning("  %s failed: %s: %s", name, type(exc).__name__, exc)
            continue
        per_source[name] = len(found)
        events.extend(found)
        log.info("  %s: %d events", name, len(found))
    return events, per_source


def deduplicate(events: list[Event]) -> list[Event]:
    """Same event from two sites collapses into the entry carrying more detail."""
    best: dict[str, Event] = {}
    for event in events:
        fingerprint = re.sub(r"[^a-z0-9]+", "", event.title.lower())[:40]
        anchor = event.next_date()
        key = f"{fingerprint}|{anchor.isoformat() if anchor != date.max else ''}"
        current = best.get(key)
        if current is None or _detail_score(event) > _detail_score(current):
            best[key] = event
    return sorted(best.values(), key=lambda e: (e.next_date(), e.title.lower()))


def _detail_score(event: Event) -> int:
    return sum(
        bool(value)
        for value in (event.start, event.deadline, event.registration_url, event.organizer,
                      event.prize, event.location, event.poster.url, event.eligibility)
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Track India-relevant hackathons and competitions; write Excel with NEW/OLD marks.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--days", type=int, default=DEFAULT_WINDOW_DAYS, help="date window from today")
    parser.add_argument("--scope", action="append", default=[], choices=[*SCOPES, "all"],
                        help="repeatable; default keeps every scope")
    parser.add_argument("--source", action="append", default=[],
                        help="only these sources (repeatable), e.g. --source Unstop")
    parser.add_argument("--kind", choices=["all", "open", "hiring"], default="all",
                        help="'open' for hackathons only, 'hiring' for recruitment challenges only")
    parser.add_argument("--include-global", action="store_true",
                        help="also keep global online events with no Indian tie (default: India only)")
    parser.add_argument("--no-posters", action="store_true", help="skip poster download and verification")
    parser.add_argument("--keep-undated", action="store_true", help="keep events with no usable date")
    parser.add_argument("--reset", action="store_true", help="forget history, so every event is NEW")
    parser.add_argument("--ignore-robots", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--quiet", action="store_true", help="only print the final summary")
    args = parser.parse_args(argv)

    if not 1 <= args.days <= 400:
        parser.error("--days must be between 1 and 400")

    logging.basicConfig(
        level=logging.WARNING if args.quiet else logging.INFO,
        format="%(message)s",
        handlers=[logging.StreamHandler(sys.stdout), logging.FileHandler(LOG_FILE, encoding="utf-8")],
    )

    today = date.today()
    window_end = today + timedelta(days=args.days)
    wanted_scopes = set(SCOPES) if (not args.scope or "all" in args.scope) else set(args.scope)
    chosen_sources = {name.lower() for name in args.source}

    log.info("India Hackathon & Competition Tracker")
    log.info("Window: %s to %s (%d days)", today, window_end, args.days)
    log.info("Folder: %s", HERE)

    if args.reset and STATE_FILE.exists():
        STATE_FILE.unlink()
        log.info("History cleared - every event this run will be marked NEW.")

    fetcher = Fetcher(obey_robots=not args.ignore_robots)
    events, per_source = collect(fetcher, chosen_sources, args.quiet)
    log.info("Collected %d raw entries", len(events))

    kept: list[Event] = []
    for event in events:
        if not event.title or not event.url:
            continue
        classify(event)
        # Sensible fallbacks so every card on the page has a link and a tag to show.
        event.registration_url = event.registration_url or event.url
        event.domains = event.domains or event.categories
        event.eligibility = event.eligibility or "Not stated - check the official page"
        if event.scope not in wanted_scopes:
            continue
        if args.kind != "all" and event.kind != args.kind:
            continue
        if not is_in_india(event, include_global=args.include_global):
            continue
        dates = [d for d in (event.deadline, event.start, event.end) if d]
        if dates:
            if not any(today - timedelta(days=1) <= d <= window_end for d in dates):
                continue
        elif not (args.keep_undated or event.source in ALWAYS_KEEP_SOURCES):
            continue
        kept.append(event)

    kept = deduplicate(kept)
    log.info("Kept %d events after filtering and de-duplication", len(kept))

    if not args.no_posters:
        log.info("Checking posters...")
        POSTER_DIR.mkdir(parents=True, exist_ok=True)
        for event in kept:
            if not event.poster.url:
                continue
            safe_name = re.sub(r"[^a-z0-9]+", "-", event.title.lower())[:50].strip("-") or "poster"
            target = POSTER_DIR / f"{safe_name}.img"
            event.poster = verify_poster(event.poster.url, fetcher, save_as=target)
            if event.poster.file and event.poster.kind:
                renamed = target.with_suffix(f".{event.poster.kind}")
                try:
                    target.replace(renamed)
                    event.poster.file = str(renamed.relative_to(OUTPUT_DIR)).replace("\\", "/")
                except OSError:
                    pass
        verified = sum(1 for e in kept if e.poster.status == "ok")
        thumbs = sum(1 for e in kept if e.poster.status == "thumbnail")
        log.info("  %d posters verified, %d thumbnails only, of %d events", verified, thumbs, len(kept))

    state = load_state()
    new_count, old_count = apply_history(kept, state)
    save_state(state)

    summary = {
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "window_start": today.isoformat(),
        "window_end": window_end.isoformat(),
        "total": len(kept),
        "new": new_count,
        "old": old_count,
        "posters_ok": sum(1 for e in kept if e.poster.status == "ok"),
        "posters_thumbnail": sum(1 for e in kept if e.poster.status == "thumbnail"),
        "per_source": per_source,
        "per_scope": {scope: sum(1 for e in kept if e.scope == scope) for scope in SCOPES},
        "per_kind": {kind: sum(1 for e in kept if e.kind == kind) for kind in KINDS},
        "coverage": "India only" if not args.include_global else "India plus global online events",
        "errors": fetcher.errors,
    }
    problems = write_outputs(kept, summary, args.quiet)

    print()
    print("=" * 62)
    print(f"  Events in window : {len(kept)}")
    print(f"    Hackathons     : {summary['per_kind']['open']}")
    print(f"    Hiring         : {summary['per_kind']['hiring']}")
    print(f"  NEW this run     : {new_count}")
    print(f"  OLD (seen before): {old_count}")
    print(f"  Posters verified : {summary['posters_ok']} (+{summary['posters_thumbnail']} thumbnails)")
    print(f"  Source errors    : {len(fetcher.errors)}")
    print(f"  Excel            : {OUTPUT_DIR / 'hackathons_latest.xlsx'}")
    print(f"  Folder           : {OUTPUT_DIR}")
    for problem in problems:
        print(f"  ! {problem}")
    print("=" * 62)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
