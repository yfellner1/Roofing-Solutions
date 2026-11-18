# Roofing Solutions – Office Board

Shared task board **plus job/estimate tickets, scheduling, routing and customer records** for Roofing Solutions LLC (roofing, siding, gutters), a Reliable OS client.
Users: Loriale (Reliable OS office staff), Mayer (owner), Mrs. Salcer (bookkeeper),
foremen Ben, Mr. Klein, Yehuda. Live at https://roofing-solutions-tasks.vercel.app

## Stack
- No framework, no build step. `index.html` is the whole front end (HTML + CSS + vanilla JS in one file).
- `api/*.js` are Vercel Node functions (Web `fetch` handler style, ESM).
- Storage: one **private** Vercel Blob store. All board data is a single JSON file `db/board.json`
  (`{ seq, tseq, tasks, notes, photos, customers, tickets, settings }`); photos are separate blobs under `img/<taskId or ticketId>/`.
  Notes and photos hang off either a task or a ticket through the same `taskId` field (ids never collide).
- Installable PWA: `manifest.webmanifest`, `sw.js` (bump `CACHE` version when shell files change).

## Files
- `api/_lib.js`  — shared: people list, sign-in cookie signing, `readDb`, `mutate` (read-modify-write with ifMatch etag guard + fallback so saves never lock up).
- `api/auth.js`  — POST code → sets `rs_user` cookie; GET → who am I; DELETE → sign out.
- `api/board.js` — GET full board (signed-in only).
- `api/op.js`    — all writes: create, update, status, note, delete, removePhoto. Author always comes from the cookie, never the request body.
- `api/photo.js` — POST upload (client compresses to JPEG first), GET streams a private photo.
- `api/_tickets.js` — all ticket / customer / settings / route actions (called from `op.js`), the stage rules, and the task↔ticket automations. Runs inside `mutate()`, so it is synchronous.
- `api/_geo.js`  — address → lat/lng (US Census geocoder, OpenStreetMap fallback, no key) and `bestRoute` (nearest-neighbour + 2-opt).
- `api/_sms.js`  — Twilio REST call + reminder message builder.
- `api/remind.js` — GET = nightly cron (see `vercel.json`, needs `CRON_SECRET`), POST = preview/send one reminder.
- `test/dev.mjs` — `npm run preview`: whole app on localhost with in-memory storage (safe; never touches live data).

## Jobs & Estimates
- A **ticket** is an estimate, repair or installation for roof / gutters / siding, tied to a saved **customer**.
  Flow: create ticket → schedule it (date, optional time, who's going) → work it through its stages.
- Job stages: `ticket` (needs scheduling) → `scheduled` → `completed` → `billed` → `paid`.
- Estimate stages: `ticket` → `scheduled` → `visited` → `sent` → `followup` → `won` | `lost`.
  Won creates a new job ticket (`fromEstimateId` / `jobId` link them) waiting to be scheduled. Lost goes to the Lost estimates list and can be reopened.
- Stage lists live in `api/_lib.js` (`JOB_STAGES`, `EST_STAGES`) and in `index.html` — update both together.
- Tasks ↔ tickets: a task may carry `ticketId`. Moving a ticket creates office tasks (visited → Send estimate, followup → Follow up on estimate,
  completed → Send invoice, billed → Follow up on payment) for `settings.officeAssignee`; finishing the Send estimate / Send invoice task moves the ticket on.
  Controlled by `settings.autoTasks`.
- Routing: tickets are geocoded when saved (network work happens in `prepare()` in `op.js`, before `mutate`). "Best route" stores `ord` on that day's scheduled tickets; the browser builds the Google Maps link.
- Reminders: cron runs 23:00 UTC (6pm EST / 7pm EDT) and texts customers on tomorrow's schedule (`BUSINESS_TZ`), once per date. Without Twilio env vars the UI falls back to an `sms:` link on the user's own phone.

## Auth model
- Each person has their own 8-digit code in env var `USER_PINS` (JSON name → code). Names must match `PEOPLE` in `api/_lib.js` and the `PEOPLE` array in `index.html`.
- Cookie = base64url(name) + HMAC(AUTH_SECRET, name:code). Changing someone's code signs only them out.
- Never commit real codes. Never trust a name sent from the browser.

## Adding a person
1. Add to `PEOPLE` in `api/_lib.js` and in `index.html` (name, role, avatar color).
2. Add their code to `USER_PINS` in Vercel, then redeploy.

## Develop / test / deploy
- Server logic tests (no network, mocked Blob): `node test/run.mjs`
- Safe local preview (in-memory, nothing saved): `node test/dev.mjs` → http://localhost:3000, codes 11111111 / 22222222 / 33333333. `FAKE_GEO=1` fakes map points.
- Local run with real storage: `npm i -g vercel`, `vercel link` (team: reliable-os, project: roofing-solutions-tasks), `vercel env pull .env.local`, `vercel dev`.
  Note: local dev writes to the SAME live Blob store — use a test task and delete it.
- Deploy: `vercel --prod` (or connect a GitHub repo to the project for auto-deploys).

## History / gotchas
- Nov 2026: saves failed with "board is busy" because the etag from `get()` didn't match the one `put()` checks once the JSON grew. Fixed by taking the etag from `head()` and letting the last retries write unguarded. Keep that behavior if refactoring.
- Hobby plan keeps runtime logs ~1 hour; check `vercel logs` soon after a reported error.
- Status columns: To do, In progress, Waiting on customer, Done. Task types and statuses are validated server-side in `api/op.js` — update both client and server lists together.

## Ideas the owner may ask for next
Push/email notifications on assignment, recurring tasks, calendar drag-and-drop, customer-facing estimate PDFs, QuickBooks invoice sync, two-way texting (customer replies), per-crew logins that only show their day, a real database (Postgres) if the JSON file gets large, per-person permissions, export to CSV.
