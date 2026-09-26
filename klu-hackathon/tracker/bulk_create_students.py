#!/usr/bin/env python3
"""OPTIONAL - pre-create student accounts with the shared default password.

You chose self-registration, so you do not need this. It exists for the case where you
want accounts to exist before students arrive (a lab session, an orientation).

Every account created here is flagged `must_change_password`, and the app refuses to let
the student browse until they have set a password of their own.

SECURITY: while these accounts sit on the shared password, anyone who knows it can sign in
as any student on the list. Create them shortly before the students will use them, not
weeks in advance, and prefer self-registration where you can.

Input CSV (header row required):
    email,full_name,roll_no,branch,year
    2200030123@kluniversity.in,A Student,2200030123,CSE,3

Environment:
    SUPABASE_URL           https://<project-ref>.supabase.co
    SUPABASE_SERVICE_KEY   service_role key - never commit this, never ship it to a browser

Usage:
    python bulk_create_students.py students.csv
    python bulk_create_students.py students.csv --dry-run
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from pathlib import Path

try:
    import requests
except ImportError:
    sys.exit("Missing dependency: requests\n  pip install requests")

DEFAULT_PASSWORD = "Kl_hackathon"
ALLOWED_DOMAINS = ("kluniversity.in", "klu.ac.in")


def env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        sys.exit(f"Environment variable {name} is not set.")
    return value.rstrip("/") if name.endswith("URL") else value


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("csv_file", type=Path)
    parser.add_argument("--password", default=DEFAULT_PASSWORD, help="shared starting password")
    parser.add_argument("--dry-run", action="store_true", help="show what would happen, create nothing")
    args = parser.parse_args()

    if not args.csv_file.exists():
        sys.exit(f"No such file: {args.csv_file}")

    url, key = env("SUPABASE_URL"), env("SUPABASE_SERVICE_KEY")
    rows = list(csv.DictReader(args.csv_file.open(encoding="utf-8-sig")))
    if not rows:
        sys.exit("The CSV has no data rows.")

    created, skipped, failed = 0, 0, []
    for row in rows:
        email = (row.get("email") or "").strip().lower()
        if not email:
            skipped += 1
            continue
        if not any(email.endswith(f"@{domain}") for domain in ALLOWED_DOMAINS):
            failed.append(f"{email}: not a college address")
            continue

        if args.dry_run:
            print(f"  would create {email}")
            created += 1
            continue

        response = requests.post(
            f"{url}/auth/v1/admin/users",
            headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            data=json.dumps({
                "email": email,
                "password": args.password,
                "email_confirm": True,          # no confirmation mail for pre-made accounts
                "user_metadata": {
                    "full_name": (row.get("full_name") or "").strip(),
                    "roll_no": (row.get("roll_no") or email.split("@")[0]).strip(),
                    "branch": (row.get("branch") or "").strip(),
                    "year": (row.get("year") or "").strip(),
                    "must_change_password": True,
                },
            }),
            timeout=30,
        )
        if response.status_code in (200, 201):
            created += 1
            print(f"  created {email}")
        elif response.status_code == 422 and "already" in response.text.lower():
            skipped += 1
            print(f"  exists  {email}")
        else:
            failed.append(f"{email}: HTTP {response.status_code} {response.text[:160]}")
            print(f"  FAILED  {email} ({response.status_code})")

    print(json.dumps({"created": created, "skipped": skipped, "failed": len(failed)}, indent=2))
    for failure in failed:
        print(f"  ! {failure}")
    if created and not args.dry_run:
        print(f"\nStudents sign in with their college email and: {args.password}")
        print("They must set their own password before the portal lets them in.")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
