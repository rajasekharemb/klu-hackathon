# KLU Hackathon Portal - setup guide

Students sign in with their college email and see the hackathon list. A job refreshes the
data at 2:00 AM every day. Three services, each doing one job:

| Service | Job |
|---|---|
| **Supabase** | student accounts + the events table |
| **Vercel** | hosts the website |
| **GitHub Actions** | runs the Python tracker at 2:00 AM and writes results into Supabase |

Vercel is not running the scraper. Its functions time out after 60 seconds (300 on Pro) and
the scan takes about 3.5 minutes, so it would be killed halfway through most nights.
GitHub Actions has a 6-hour limit and is free for public repositories.

```
klu-hackathon/
├── supabase/schema.sql                  run this once in the SQL editor
├── web/                                 the Next.js site -> Vercel
├── tracker/publish_to_supabase.py       pushes a scan into the database
└── tracker/bulk_create_students.py      optional: pre-create accounts
```

The 2:00 AM job lives at **`.github/workflows/daily-refresh.yml` in the repository root**, one
level above this folder. GitHub only reads workflows from the root `.github/workflows/`
directory - a copy inside a subfolder is ignored silently, and the Actions tab just shows
"Get started with GitHub Actions" as though no workflow existed.

---

## Before you start

Install these on your PC - none of them are present right now:

- **Node.js 20+** - <https://nodejs.org> (gives you `node` and `npm`)
- **Git** - <https://git-scm.com/download/win>

Then close and reopen PowerShell so the commands are on your PATH:

```bash
node --version && git --version
```

---

## Step 1 - Supabase: create the tables

1. Open your project: <https://supabase.com/dashboard/project/cxkinufcaefbdmszghtt>
2. **SQL Editor** -> **New query**
3. Paste the whole of `supabase/schema.sql` and press **Run**

That creates `profiles`, `events`, `saved_events` and `refresh_runs`, switches on Row Level
Security, and adds the trigger that makes a profile row whenever somebody registers.

### Restrict sign-ups to your college

The schema already rejects anything that is not `@kluniversity.in` or `@klu.ac.in`. To change
the allowed domains, edit the `allowed_email_domain()` function at the top of the file and
the `ALLOWED_DOMAINS` array in `web/app/signup/page.tsx`. Keep the two in step.

### Decide about email confirmation

**Authentication -> Providers -> Email**

- *Confirm email* **on** (default) - students must click a link before their first sign-in.
  Safer, and it proves the address is real.
- *Confirm email* **off** - they are signed in the moment they register. Easier for a
  classroom demo. The domain restriction still applies.

### Copy your keys

**Project Settings -> API**. You need two of the three values:

| Value | Goes where | Safe in the browser? |
|---|---|---|
| Project URL | Vercel + GitHub | yes |
| `anon` / public key | Vercel | yes - RLS is what protects the data |
| `service_role` key | **GitHub secrets only** | **no - it bypasses RLS entirely** |

Never put the `service_role` key in `web/`, in `.env.local`, or in any file you commit.
Anyone holding it can read and change every row in your database.

---

## Step 2 - Push the code to GitHub

From `E:\Hackthon`:

```bash
git init
```

```bash
git add HackathonTracker klu-hackathon
```

```bash
git commit -m "KLU hackathon portal: tracker, website, nightly refresh"
```

Create an empty repository on GitHub (no README), then:

```bash
git remote add origin https://github.com/<your-username>/klu-hackathon.git
```

```bash
git push -u origin main
```

`.gitignore` already keeps `.env`, `students.csv`, `node_modules/` and the tracker's output
out of the repository.

---

## Step 3 - Vercel: host the site

1. <https://vercel.com/klu-hackathon> -> **Add New** -> **Project** -> import the repository
2. **Root Directory**: click *Edit* and choose **`klu-hackathon/web`** - this matters, the
   repository root is not the app
3. Framework preset: **Next.js** (detected automatically)
4. **Environment Variables** - add both, for Production *and* Preview:

   | Name | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | `https://cxkinufcaefbdmszghtt.supabase.co` |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | your anon key |

5. **Deploy**

### Point Supabase back at the deployed site

**Supabase -> Authentication -> URL Configuration**

- Site URL: your Vercel production URL
- Redirect URLs: add `https://<your-app>.vercel.app/**`

Without this, confirmation links bounce students to `localhost`.

---

## Step 4 - GitHub Actions: the 2:00 AM refresh

In your GitHub repository: **Settings -> Secrets and variables -> Actions -> New repository
secret**. Add two:

| Secret | Value |
|---|---|
| `SUPABASE_URL` | `https://cxkinufcaefbdmszghtt.supabase.co` |
| `SUPABASE_SERVICE_KEY` | the **service_role** key |

The workflow is at `.github/workflows/daily-refresh.yml` in the **repository root**, not inside
`klu-hackathon/`. Its paths (`HackathonTracker/...`, `klu-hackathon/tracker`) are all relative
to that root.

**About the schedule.** GitHub cron is UTC only. IST is UTC+5:30, so 2:00 AM IST is
**20:30 UTC the previous day** - which is why the file says `30 20 * * *`. Changing it to
`0 2 * * *` would run the job at 7:30 AM IST.

GitHub also queues scheduled jobs when it is busy, so expect it to start a few minutes late.
Nothing downstream cares.

**Run it once by hand now**: Actions tab -> *Daily hackathon refresh* -> **Run workflow**.
It takes about 4 minutes. Then check `events` in the Supabase table editor.

---

## Step 5 - Try it

1. Open your Vercel URL -> you land on `/login`
2. **Register with your college email** -> confirm by email if you left that on
3. You land on the dashboard: hackathons and hiring challenges, new ones at the top

---

## Admin access

The admin username is **`RAJASEKHAREMB`**, which resolves to
`rajasekharemb@kluniversity.in`. The login box accepts either form - anything without an `@`
gets the college domain appended, so students can type just their roll number too.

Create the account after running the schema:

```bash
cd klu-hackathon/tracker
```

```bash
python create_admin.py
```

It asks for the password without echoing it, then creates the user and sets
`profiles.role = 'admin'`. To change the password later, `python create_admin.py --reset-password`.

### About the password

`KL` cannot be used. Supabase Auth enforces a minimum of 6 characters and will reject it
outright - this is a limit in the service, not a rule the app adds. Supabase's own guidance
is that "anything less than 8 characters is not recommended".

This script requires **at least 12**, because the admin account can read every student's
name, roll number, branch and email. An admin login is also the first thing an attacker
tries, and unlike a student account it is worth brute-forcing. A short password on this
account puts everyone's data at risk, not just yours.

### What the admin can see

`/admin` shows every registered student, the last ten nightly refreshes with their error
counts, and a breakdown of events by source. A banner appears if the 2:00 AM job has not
run for more than 30 hours, so a silently broken cron is visible.

Deleting or exporting accounts is deliberately not in the UI. Do that in the Supabase
dashboard, where the action is tied to your account.

### How the role is enforced

Three layers, because the first two are only about what gets rendered:

1. `middleware.ts` redirects non-admins away from `/admin`
2. the page checks the role again server-side
3. **Row Level Security** in Postgres is the real boundary - `is_admin()` gates the policy
   that lets one account read another's profile

Roles cannot be self-assigned. The signup trigger always writes `role = 'student'`, because
user metadata comes straight from the browser and honouring a `role` claim there would let
anyone register as an admin. A trigger also reverts any attempt to change `role` or `email`
through the normal update policy. Only the `service_role` key can promote an account.

## Accounts and passwords

You chose **self-registration**, so each student picks their own password and the shared
`Kl_hackathon` password is not used at all. That is the safer arrangement: there is no window
where accounts exist with a password everyone knows.

If you later want accounts pre-created - for a lab session, say - `tracker/bulk_create_students.py`
does it:

```bash
python tracker/bulk_create_students.py students.csv --dry-run
```

CSV format:

```csv
email,full_name,roll_no,branch,year
2200030123@kluniversity.in,A Student,2200030123,CSE,3
```

Every account it makes is flagged `must_change_password`, and `middleware.ts` refuses to let
that student see anything until they have set their own password.

**Be aware of what the shared password means.** Between creating the accounts and each student
changing their password, anybody who knows `Kl_hackathon` and a roll number can sign in as that
student. Create them shortly before they are needed, not weeks ahead.

---

## Running the site locally

```bash
cd klu-hackathon/web
```

```bash
npm install
```

Copy `.env.example` to `.env.local` and fill in the two values, then:

```bash
npm run dev
```

<http://localhost:3000>. Add `http://localhost:3000/**` to the Supabase redirect URLs.

---

## When something is wrong

| Symptom | Cause |
|---|---|
| Dashboard is empty | The nightly job has not run. Trigger it by hand from the Actions tab. |
| "Only college email addresses may register" | The address is outside `allowed_email_domain()`. |
| Confirmation link goes to localhost | Site URL is unset in Supabase -> Authentication -> URL Configuration. |
| Build fails on Vercel | Root Directory is not `klu-hackathon/web`. |
| Workflow fails at "Publish to Supabase" | `SUPABASE_SERVICE_KEY` is missing, or it is the anon key by mistake. |
| Stuck on the change-password screen | `must_change_password` is still true. It clears once the new password saves. |
| Everything says NEW every morning | The tracker memory cache was not restored. Check the cache steps in the workflow log. |

`refresh_runs` records every nightly run, and the dashboard footer shows the last one, so a
job that quietly stops working is visible rather than silent.

---

## What has actually been tested

| Part | State |
|---|---|
| Python tracker | run many times against the live sites |
| `npm install` + `npm run build` | passes - 6 routes and middleware compile |
| Login / signup / admin pages | render correctly in a browser |
| Auth gate | `/dashboard` and `/admin` redirect to `/login?next=...` when signed out |
| Username login | the box accepts a bare username and appends the college domain |
| College-domain check | rejects `someone@gmail.com` with the right message |
| `publish_to_supabase.py` row mapping | checked against `schema.sql` - every column matches, no extras, keys unique |
| Git repository | initialised and committed, with secrets excluded |

**Not yet run: the SQL itself, and anything that needs your real Supabase keys** - registering a
student, signing in, and the dashboard reading live rows. Those need the schema executed in your
project and the anon key in `.env.local`. The build placeholder was enough to prove the pages
compile and render, not that the database round-trip works.

Two bugs were found and fixed by building it:

1. **Browser and server Supabase clients in one file.** Any Client Component importing the
   browser client also pulled in `next/headers`, and the build failed. They are now three
   separate modules under `lib/supabase/` - do not merge them back.
2. **`useSearchParams()` without a Suspense boundary.** Prerendering `/login` failed. The form
   is now `LoginForm.tsx`, wrapped in `<Suspense>` by `page.tsx`.
3. **A privilege-escalation hole in the first draft of the admin work.** The signup trigger
   read `role` out of `raw_user_meta_data`, which is supplied by the browser - so any student
   could have registered as an admin by passing `data: { role: 'admin' }` to `signUp()`. The
   trigger now hardcodes `'student'`, and a second trigger reverts role changes made through
   the normal update policy.

Next.js was also moved off 14.2.15, which npm flags as having a security vulnerability, onto
14.2.35. Staying on 14.x is deliberate: Next 15 made `cookies()` async, which would break
`lib/supabase/server.ts`.
