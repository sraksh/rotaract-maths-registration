# Registration portal — 34th Padmabai Rungta Inter-District Mathematics Competition 2026

Organiser: Rotaract Club of Chaibasa · Exam date: 22 November 2026 · Centre (tentative): Narbheram Hansraj English School, Jamshedpur

Online student registration with UPI payment-proof upload, and a protected admin portal for verifying payments, exporting lists and configuring the event.

> **Read [Verification status](#verification-status) before going live.** Automated tests were deliberately skipped, and the app has not been run against a real Supabase project.

## Architecture

```
Browser (static site)                      Supabase (separate managed services)
┌───────────────────────┐   anon key      ┌────────────────────────────────────────────┐
│ React + Vite, hash    │ ─────────────▶  │ PostgreSQL   RLS on, NO table access for   │
│ routing (#/admin …)   │  get_public_    │              browser roles; data only via  │
│ Netlify (static)      │  config() only  │              service-role-only SQL funcs   │
│ static host           │                 │ Edge Functions  register · admin · cleanup │
│                       │ ─ fetch ──────▶ │ Storage      payment-proofs (PRIVATE)      │
└───────────────────────┘                 │              payment-qr (public, QR only)  │
                                          │ Auth         admin sign-in, signups off    │
                                          └────────────────────────────────────────────┘
```

**Netlify (or any static host) serves only the static frontend.** The database, authentication, file storage and all privileged logic live in Supabase. No server code runs on the static host.

- The browser holds only the **publishable** key. The service-role key exists only inside Supabase Edge Functions (injected by the platform). The build refuses to run with a secret key (`src/lib/env.ts`) and CI fails on one.
- The browser can call exactly one database function (`get_public_config`, public event settings). Every other table/function is revoked from `anon`/`authenticated`; RLS is enabled with no policies as a second layer.
- **Registration** (`register` function): `init-upload` issues a single-use signed upload URL for a random path bound to the form's idempotency key → browser uploads the screenshot → `submit` re-validates every field server-side, re-reads the stored file and checks its magic bytes (JPEG/PNG/WEBP) and size, then creates the registration in one SQL transaction. Class→shift→times come from the `exam_schedules` table, never from the browser. The registration ID (`PRM34-XXXXXXXXXX`) is generated in the database with a unique constraint and collision retry. Retrying with the same key returns the same registration (no duplicates). Rate limited per hashed IP.
- **Admin** (`admin` function): every request verifies the Supabase access token **and** an active row in `admin_users`. Payment proofs are served through 60-second signed URLs, and every view is audited. Payment status changes use optimistic concurrency (a stale update gets `STATUS_CONFLICT`). `audit_log` is append-only (triggers + revoked privileges).
- **Cleanup** (`cleanup` function): removes uploads that never became registrations, prunes rate-limit rows. Protected by a shared secret.

## Local development

Requirements: Node 22+.

```bash
npm ci
cp .env.example .env.local      # fill VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY
npm run dev                     # http://localhost:5173/  (admin: http://localhost:5173/#/admin)
npm run check                   # lint + type-check + production build
```

Add `http://localhost:5173` to the `ALLOWED_ORIGINS` secret so the browser may call the functions.

## Supabase project setup (one-time)

Install the [Supabase CLI](https://supabase.com/docs/guides/cli), then:

1. **Create a project** at supabase.com. Note the project ref, the project URL and the *publishable* key (Project Settings → API Keys).
2. **Link and migrate**
   ```bash
   supabase login
   supabase link --project-ref <ref>
   supabase db push            # applies supabase/migrations/* in order
   ```
   Migration 6 creates the two storage buckets: `payment-proofs` (**private**, 5 MB, images only, no storage policies → no browser access) and `payment-qr` (public; it only holds the QR image meant to be shown to payers). In the dashboard → Storage, confirm `payment-proofs` shows as *Private*.
3. **Auth settings** (dashboard → Authentication): turn **off** “Allow new users to sign up”. Email/password stays on. (`supabase/config.toml` only affects local `supabase start`.)
4. **Secrets**
   ```bash
   supabase secrets set \
     ALLOWED_ORIGINS="https://<your-site>.netlify.app" \
     IP_HASH_SALT="$(openssl rand -hex 32)" \
     CLEANUP_SECRET="$(openssl rand -hex 32)"
   ```
   `ALLOWED_ORIGINS` is origins only (no path). Optional tuning: `RATE_LIMIT_INIT_PER_10_MIN`, `RATE_LIMIT_SUBMIT_PER_10_MIN` (default 30 each per IP — raise if many students share one school network).
5. **Deploy the functions** (they authenticate inside the code, so JWT verification at the gateway is off, as in `supabase/config.toml`):
   ```bash
   supabase functions deploy register admin cleanup --no-verify-jwt
   ```
6. **Schedule cleanup** (hourly; SQL editor). Requires the `pg_cron` and `pg_net` extensions:
   ```sql
   select cron.schedule('cleanup-orphan-uploads', '17 * * * *', $$
     select net.http_post(
       url := 'https://<ref>.supabase.co/functions/v1/cleanup',
       headers := jsonb_build_object('Content-Type','application/json','x-cleanup-secret','<CLEANUP_SECRET>'),
       body := '{}'::jsonb) $$);
   ```

### Provision administrators

Nobody can become an admin from the public app. For each organiser:

1. Dashboard → Authentication → Users → **Add user** (email + strong password, tick auto-confirm).
2. SQL editor:
   ```sql
   insert into public.admin_users (user_id, email, created_by)
   select id, email, 'operator' from auth.users where email = 'organiser@example.org';
   ```
3. To revoke: `update public.admin_users set active = false where email = '…';`

A signed-in user who is not in `admin_users` sees “Not authorised”, and the functions reject them with 403.

## GitHub repository and deployment (Netlify)

The site is hosted on **Netlify** (static site); the code lives on GitHub (owner **sraksh**). `.github/workflows/checks.yml` runs lint, type-check and build on every push/PR; `netlify.toml` configures the Netlify build.

1. **Push to GitHub** (from a computer logged in to your account):
   ```bash
   gh repo create sraksh/rungta-registration --private --source=. --push
   ```
   (Netlify works with private repos. GitHub Pages is no longer used.)
2. **Netlify → Add new site → Import an existing project → GitHub →** pick the repo. Build command `npm run build`, publish directory `dist` (already in `netlify.toml`).
3. **Netlify → Site configuration → Environment variables:** add `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (public values; never the secret key). Trigger a deploy.
4. Take the resulting site origin (e.g. `https://<name>.netlify.app`, or your custom domain) and set it as the Supabase secret `ALLOWED_ORIGINS`:
   ```bash
   supabase secrets set ALLOWED_ORIGINS="https://<name>.netlify.app"
   ```
   Without this, the browser's calls to the functions are blocked by CORS.
5. Optionally add the same two variables under GitHub → Settings → Secrets and variables → Actions → *Variables* so the CI build step uses real values.

Hash routing (`#/admin`) means reloads and deep links work with no rewrite rules.

### Why Netlify rather than GitHub Pages

GitHub's Pages terms discourage sites that facilitate commercial transactions or handle sensitive transactions, and this app collects payment proof. *(I could not retrieve GitHub's live page during development; check the current wording yourself.)* Netlify serves the same static files. In both cases student data goes straight to Supabase and never touches the host or the repository.

## Configuring the event (admin → Settings)

Sign in at `#/admin`. The Settings page shows what is still missing. **Registration cannot be opened and no payment details are shown to students until all of these are set** (the server enforces this too).

| What | Where | Notes |
|---|---|---|
| Registration fee | Settings → Payment | Organisers decide; nothing is assumed. |
| UPI payee name, UPI ID | Settings → Payment | Exactly as on the official account. |
| Official QR image | Settings → Official UPI QR image | JPG/PNG/WEBP ≤ 2 MB. Used as supplied; never generated. |
| School list | Settings → Schools | One per line. Empty = students type the school. When filled, they must pick from it. |
| Examination centre | Settings → Event | Untick “centre is final” to show “tentative”; tick once confirmed. |
| Exam schedule | Settings → Examination schedule | Seeded with the four required class/shift rows. Editing updates existing registrations too. |
| Open registration | Settings → Registration status | Last step. |

Also see [`docs/ORGANISER_CHECKLIST.md`](docs/ORGANISER_CHECKLIST.md).

## Admin portal

Dashboard (live counts, by class, by school, needs-attention) · Registrations (search by ID/name/school/mobile; filter by class, school, payment status, IST date range; pagination) · Registration detail (full record, 60-second proof viewer, verify / reject-with-reason, internal note, audit history) · Reports (class-wise or school-wise participant lists with shift and timing; print / save as PDF; CSV) · Settings.

Exports (CSV and Excel) follow the active filters. Internal notes are excluded unless “Include internal notes” is ticked. CSV cells starting with `= + - @`, tab or CR are prefixed with `'`; Excel files store every value as a text cell; the mobile number is exported as 10 digits. Exports are audit-logged. Limit: 20,000 rows per export (the UI warns if truncated).

## Repository layout

```
src/                       React app (pages/, admin/, components/, lib/)
supabase/migrations/       versioned SQL: schema, RLS/grants, functions, storage
supabase/functions/        register · admin · cleanup (+ _shared handlers, validation, schedule)
.github/workflows/         checks.yml (lint → typecheck → build)
netlify.toml               Netlify build + security headers
docs/ORGANISER_CHECKLIST.md
```

`supabase/functions/_shared/schedule.ts` is the single source of schedule text; the form, confirmation, reports and exports all format from it. The database seed in migration 1 mirrors it.

## Verification status

Honest account of what was and was not checked while building this:

**Run and passing:** `eslint .` (0 problems), `tsc --noEmit` (0 errors), `vite build` (checked with a `/rungta-registration/` sub-path; Netlify uses `/`; asset URLs are correctly prefixed; the admin code is a separate lazy chunk; no secret key in the output). All six migrations were applied in order to a scratch **PostgreSQL 16** server (with stand-ins for Supabase's `auth`/`storage` schemas). On it, `admin_update_config` with a school list worked (case-insensitive de-duplication; removed schools deactivated; audit rows written), and the `anon` role could call `get_public_config()` but was denied `registrations` and `admin_stats`. These were manual SQL checks, not a kept test suite. An earlier one-off check also ran the real admin handler against an in-process PGlite database.

**Not done / not verified:**
- **No automated tests exist.** Unit, integration and Playwright end-to-end tests were skipped at the project owner's request, so none of the reliability scenarios in the original specification (idempotent retries, upload-then-DB-failure, concurrent IDs, forged class/shift, spoofed files, auth denial, CSV injection, mobile layout) have been demonstrated by tests. The code was written to handle them (see Architecture) but treat that as unproven.
- **The UI has never been opened in a browser** by the developer, on desktop or mobile. Expect to find layout or interaction bugs.
- **Never run against a real Supabase project:** Edge Functions (Deno runtime), Storage signed-upload/signed-URL behaviour, Auth sign-in, `pg_cron` scheduling, and `supabase/config.toml` (hand-written, not validated by the CLI) are untested end to end.
- **Concurrency** (many simultaneous submissions racing on IDs/idempotency keys) was never exercised.
- Registration creation, upload verification, payment verification and exports were **not** exercised end to end (only the checks listed above).
- No CAPTCHA is implemented; abuse protection is the per-IP rate limit. Consider Cloudflare Turnstile if abused.
- Nothing has been deployed; no live URL exists.

**Suggested before launch:** do a full dry run on a staging Supabase project — register as a student (all four classes), verify/reject as an admin, export, print, and try a double-tap, a bad file and a dropped connection.
