#!/usr/bin/env python3
"""Push a tracker run into Supabase.

Reads the `hackathons.json` written by hackathon_tracker.py and upserts every row into
public.events, keyed on the tracker's own stable `key`, then records the run in
public.refresh_runs so a silent failure is visible in the dashboard.

Environment (never hard-code these):
    SUPABASE_URL           https://<project-ref>.supabase.co
    SUPABASE_SERVICE_KEY   the service_role key - server-side only, never in the browser

Usage:
    python publish_to_supabase.py ../HackathonTracker/output/hackathons.json
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

try:
    import requests
except ImportError:
    sys.exit("Missing dependency: requests\n  pip install requests")

BATCH = 100
TIMEOUT = 60


def env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        sys.exit(f"Environment variable {name} is not set.")
    return value.rstrip("/") if name.endswith("URL") else value


def to_row(event: dict[str, Any]) -> dict[str, Any]:
    """Map one tracker record onto the public.events column names."""
    poster = event.get("poster") or {}
    return {
        "key": event.get("key"),
        "title": event.get("title"),
        "source": event.get("source"),
        "kind": event.get("kind") or "open",
        "scope": event.get("scope"),
        "url": event.get("url"),
        "registration_url": event.get("registration_url") or event.get("url"),
        "start_date": event.get("start") or None,
        "end_date": event.get("end") or None,
        "deadline": event.get("deadline") or None,
        "mode": event.get("mode"),
        "location": event.get("location"),
        "organizer": event.get("organizer"),
        "prize": event.get("prize"),
        "fee": event.get("fee"),
        "team_size": event.get("team_size"),
        "eligibility": event.get("eligibility"),
        "participants": str(event.get("participants") or ""),
        "description": event.get("description"),
        "domains": event.get("domains") or [],
        "categories": event.get("categories") or [],
        "poster_url": poster.get("url") or None,
        "poster_status": poster.get("status"),
        "poster_width": poster.get("width") or None,
        "poster_height": poster.get("height") or None,
        "tracker_status": event.get("status"),
        "first_seen": event.get("first_seen") or None,
        "last_seen": event.get("last_seen") or None,
        "times_seen": event.get("times_seen") or 1,
    }


def post(url: str, key: str, path: str, payload: Any, prefer: str) -> requests.Response:
    response = requests.post(
        f"{url}/rest/v1/{path}",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": prefer,
        },
        data=json.dumps(payload),
        timeout=TIMEOUT,
    )
    return response


def main(argv: list[str]) -> int:
    source = Path(argv[1]) if len(argv) > 1 else Path("../HackathonTracker/output/hackathons.json")
    if not source.exists():
        sys.exit(f"No tracker output at {source}. Run hackathon_tracker.py first.")

    url, key = env("SUPABASE_URL"), env("SUPABASE_SERVICE_KEY")
    events = json.loads(source.read_text(encoding="utf-8"))
    rows = [to_row(event) for event in events if event.get("key") and event.get("title")]
    skipped = len(events) - len(rows)

    # `key` is the upsert target. Output from a tracker older than the version that emits it
    # has none, and every row would silently collapse onto a single database record - so
    # refuse rather than corrupt the table.
    if events and not rows:
        sys.exit(
            f"None of the {len(events)} records carry a 'key'. This output predates the field.\n"
            f"Re-run hackathon_tracker.py to regenerate {source.name}, then publish again."
        )
    if skipped > len(events) // 2:
        sys.exit(f"{skipped} of {len(events)} records lack a key or title - refusing to publish a partial set.")

    print(f"Publishing {len(rows)} events from {source}" + (f" ({skipped} skipped)" if skipped else ""))

    written, failures = 0, []
    for start in range(0, len(rows), BATCH):
        chunk = rows[start : start + BATCH]
        response = post(url, key, "events?on_conflict=key", chunk,
                        "resolution=merge-duplicates,return=minimal")
        if response.status_code >= 300:
            failures.append(f"rows {start}-{start + len(chunk)}: HTTP {response.status_code} {response.text[:300]}")
            print(f"  batch {start // BATCH + 1}: FAILED {response.status_code}")
        else:
            written += len(chunk)
            print(f"  batch {start // BATCH + 1}: {len(chunk)} rows")

    log = {
        "events_total": len(rows),
        "events_new": sum(1 for row in rows if row["tracker_status"] == "NEW"),
        "events_hiring": sum(1 for row in rows if row["kind"] == "hiring"),
        "errors": len(failures),
        "ok": not failures,
        "note": "; ".join(failures)[:500] or None,
    }
    # Saved-for-later entries lapse after 30 days. They are already hidden from
    # students by the query, so this only keeps the table from growing.
    purge = requests.post(
        f"{url}/rest/v1/rpc/purge_expired_saves",
        headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        data="{}",
        timeout=TIMEOUT,
    )
    if purge.status_code < 300:
        print(f"  cleared {purge.text.strip() or 0} expired saved-for-later entries")
    else:
        print(f"  (could not clear expired saves: HTTP {purge.status_code})")

    # Registrations for events that finished more than 15 days ago. Events are
    # upserted and never deleted, so these rows would otherwise accumulate for ever.
    old_regs = requests.post(
        f"{url}/rest/v1/rpc/purge_old_registrations",
        headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        data="{}",
        timeout=TIMEOUT,
    )
    if old_regs.status_code < 300:
        print(f"  cleared {old_regs.text.strip() or 0} registrations for long-finished events")
    else:
        print(f"  (could not clear old registrations: HTTP {old_regs.status_code})")

    log_response = post(url, key, "refresh_runs", log, "return=minimal")
    if log_response.status_code >= 300:
        print(f"  (could not write refresh_runs: HTTP {log_response.status_code})")

    print(json.dumps({"written": written, "failed_batches": len(failures)}, indent=2))
    for failure in failures:
        print(f"  ! {failure}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
