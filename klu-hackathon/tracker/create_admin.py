#!/usr/bin/env python3
"""Create (or promote) the admin account.

Two steps, both needing the service_role key:
    1. create the auth user, with its email already confirmed
    2. set profiles.role = 'admin'

Step 2 is separate on purpose. The signup trigger always writes role='student', because
user metadata comes from the browser and anyone could otherwise register as an admin.
Only the service_role key can flip the role afterwards.

Environment:
    SUPABASE_URL           https://<project-ref>.supabase.co
    SUPABASE_SERVICE_KEY   service_role key
    ADMIN_PASSWORD         the password to set (asked for interactively if unset)

Usage:
    python create_admin.py                      # username RAJASEKHAREMB
    python create_admin.py --username someone
    python create_admin.py --reset-password     # change an existing admin's password
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import sys

try:
    import requests
except ImportError:
    sys.exit("Missing dependency: requests\n  pip install requests")

DEFAULT_USERNAME = "RAJASEKHAREMB"
DEFAULT_DOMAIN = "kluniversity.in"

# Supabase Auth rejects anything shorter than 6 characters and its own guidance says
# "anything less than 8 characters is not recommended". This account can read every
# student's details, so 12 is the floor here.
MIN_PASSWORD = 12
WEAK = {
    "kl", "klu", "admin", "password", "kl_hackathon", "12345678", "qwerty",
    "admin123", "kluniversity", "rajasekhar", "rajasekharemb",
}


def env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        sys.exit(f"Environment variable {name} is not set.")
    return value.rstrip("/") if name.endswith("URL") else value


def ask_password() -> str:
    supplied = os.environ.get("ADMIN_PASSWORD", "")
    if supplied:
        return check(supplied)
    print(f"Choose the admin password (at least {MIN_PASSWORD} characters; it will not echo).")
    while True:
        first = getpass.getpass("  Password: ")
        try:
            first = check(first)
        except SystemExit as exc:
            print(f"  {exc}")
            continue
        if first != getpass.getpass("  Confirm : "):
            print("  The two entries differ; try again.")
            continue
        return first


def check(password: str) -> str:
    if len(password) < MIN_PASSWORD:
        raise SystemExit(
            f"Too short: {len(password)} characters. The admin account can read every "
            f"student's record, so this script requires at least {MIN_PASSWORD}. "
            "Supabase itself rejects anything under 6."
        )
    if password.lower() in WEAK:
        raise SystemExit("That is a guessable password. Pick something else.")
    return password


def headers(key: str) -> dict[str, str]:
    return {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}


def find_user(url: str, key: str, email: str) -> dict | None:
    response = requests.get(
        f"{url}/auth/v1/admin/users", headers=headers(key), params={"page": 1, "per_page": 200}, timeout=30
    )
    if response.status_code != 200:
        sys.exit(f"Could not list users: HTTP {response.status_code} {response.text[:200]}")
    for user in response.json().get("users", []):
        if (user.get("email") or "").lower() == email:
            return user
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--username", default=DEFAULT_USERNAME, help="login name, without the domain")
    parser.add_argument("--domain", default=DEFAULT_DOMAIN)
    parser.add_argument("--full-name", default="Administrator")
    parser.add_argument("--reset-password", action="store_true", help="account exists; just set a new password")
    args = parser.parse_args()

    url, key = env("SUPABASE_URL"), env("SUPABASE_SERVICE_KEY")
    email = f"{args.username.lower()}@{args.domain}"
    password = ask_password()

    existing = find_user(url, key, email)

    if existing and not args.reset_password:
        print(f"{email} already exists. Re-run with --reset-password to change its password.")
        user_id = existing["id"]
    elif existing:
        response = requests.put(
            f"{url}/auth/v1/admin/users/{existing['id']}",
            headers=headers(key),
            data=json.dumps({"password": password}),
            timeout=30,
        )
        if response.status_code >= 300:
            sys.exit(f"Password change failed: HTTP {response.status_code} {response.text[:300]}")
        user_id = existing["id"]
        print(f"Password updated for {email}")
    else:
        response = requests.post(
            f"{url}/auth/v1/admin/users",
            headers=headers(key),
            data=json.dumps({
                "email": email,
                "password": password,
                "email_confirm": True,
                "user_metadata": {"full_name": args.full_name, "roll_no": args.username.upper()},
            }),
            timeout=30,
        )
        if response.status_code not in (200, 201):
            sys.exit(f"Could not create the user: HTTP {response.status_code} {response.text[:300]}")
        user_id = response.json()["id"]
        print(f"Created {email}")

    # Promote. The trigger always writes 'student', so this is what makes an admin.
    promote = requests.patch(
        f"{url}/rest/v1/profiles?id=eq.{user_id}",
        headers={**headers(key), "Prefer": "return=representation"},
        data=json.dumps({"role": "admin", "full_name": args.full_name}),
        timeout=30,
    )
    if promote.status_code >= 300:
        sys.exit(f"Could not set role=admin: HTTP {promote.status_code} {promote.text[:300]}\n"
                 "Has schema.sql been run? The profiles row is created by its trigger.")

    rows = promote.json()
    if not rows:
        sys.exit("No profiles row was updated. Run supabase/schema.sql first, then re-run this.")

    print(json.dumps({"email": email, "role": rows[0].get("role"), "id": user_id}, indent=2))
    print(f"\nSign in at /login with the username {args.username.upper()} (or the full address).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
