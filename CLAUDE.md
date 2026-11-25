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
- `api/auth.js`  — POST username + password → sets `rs_user` cookie; GET → who am I (+ role, people list); DELETE → sign out.
- `api/board.js` — GET full board (signed-in only).
- `api/op.js`    — all writes: create, update, status, note, delete, removePhoto. Author always comes from the cookie, never the request body.
- `api/photo.js` — POST upload (client compresses to JPEG first), GET streams a private photo.
- `api/_tickets.js` — all ticket / customer / settings / route actions (called from `op.js`), the stage rules, and the task↔ticket automations. Runs inside `mutate()`, so it is synchronous.
- `api/_geo.js`  — address → lat/lng (US Census geocoder, OpenStreetMap fallback, no key) and `bestRoute` (nearest-neighbour + 2-opt).
- `api/_sms.js`  — Twilio REST call + reminder message builder.
- `api/places.js` — address suggestions while typing (GET `?q=`). Google Places if `GOOGLE_MAPS_KEY` is set, else free Photon (OpenStreetMap). A picked suggestion sends its lat/lng with the ticket (`data.geo`) so no second lookup is needed.
- `api/remind.js` — GET = nightly cron (see `vercel.json`, needs `CRON_SECRET`), POST = preview/send one reminder.
- `api/nightly.js` — the one nightly cron (`vercel.json`, needs `CRON_SECRET`): saves a dated backup, then runs the reminder texts.
- `api/backup.js` — list backups, "back up now", restore (restore is limited to `ADMINS` in `_lib.js`; the current board is saved as `backups/before-restore-*.json` first). Backups live in the same Blob store under `backups/board-YYYY-MM-DD.json`, 30 days kept. Photos are not backed up.
- `api/_push.js` / `api/push.js` — Web Push alerts (needs `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`). Device subscriptions are stored in `db/push.json`, apart from the board. `op.js` collects alerts during a save (`setNotify`) and sends them after it succeeds. `sw.js` shows them.
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
- Front end has three top tabs: **Today** (home: tiles, "my stops" with big buttons for foremen, needs-attention list, my tasks), Tasks, Jobs & Estimates. Schedule has Day / Week (by crew) / Month views.
- Drag and drop (desktop only, HTML5): cards between columns change status/stage (`goStage` still shows its dialogs); tickets dropped on a day (week strip, week grid cell, month cell) are scheduled via `dropOnDay`. Cards are `div role=button` (`cardNode`) because `<button>` can't be dragged in every browser.
- Route order: with no fixed times, `bestRoute` (or Google's optimised order); if any stop has a time, `planOrder` keeps timed stops in clock order and slots the rest in. With `GOOGLE_MAPS_KEY` + Routes API enabled, `driveRoute` stores real `leg: {mi, min, d}` per ticket; otherwise the UI shows a straight-line estimate. Manual reorder clears `leg`.
- Other customer texts: "on my way" and "thank you" (`kind` on `/api/remind` POST, logged in `ticket.texts`). `settings.autoThanks` sends the thank-you when a job is marked paid (Twilio only).
- Reminders: cron runs 23:00 UTC (6pm EST / 7pm EDT) and texts customers on tomorrow's schedule (`BUSINESS_TZ`), once per date. Without Twilio env vars the UI falls back to an `sms:` link on the user's own phone.

## Accounts and roles
- Each person signs in with a **username + password** (`api/auth.js`). Accounts live in `db/users.json` (`api/_users.js`), apart from the board, with scrypt password hashes; nothing in that file is ever sent to a browser except name, job title, colour and on/off.
- Two roles: **admin** (everything, plus Users, Settings, restoring backups, deleting tickets/customers/any task) and **editor** (everyday work; may delete only tasks they created). Checks are server-side in `op.js`, `backup.js`, `users.js`; the UI just hides what an editor can't use.
- Admins manage people in the app (account button → Manage users → `api/users.js`): add, rename, job title, role, "can sign in", set a new password. Guards: at least one active admin; you can't demote or switch off yourself. Everyone can change their own password.
- Cookie = base64url(user id) + HMAC(AUTH_SECRET, id:stamp). The stamp changes on password change/reset and on/off, which signs that person out everywhere. 8 wrong passwords lock an account for 10 minutes.
- `PEOPLE` (server) is the live list of active display names, refreshed from `users.json` on every request via `getAuth`. Work is stored by display name, so a rename rewrites assignee/author fields (`renameEverywhere` in `users.js`).
- First run only: if `users.json` does not exist, the original six are created as **editors** with usernames loriale, mayer, salcer, ben, klein, yehuda and their old 8-digit code from `USER_PINS` as the password, plus the one **admin** account `reliableos` (Reliable OS runs the board) whose password comes from `ADMIN_PASSWORD`. After that both env vars are unused.
- Job title Foreman or Crew = shown as a row in the week calendar and gets the "My stops" view.

## Develop / test / deploy
- Server logic tests (no network, mocked Blob): `node test/run.mjs`
- Safe local preview (in-memory, nothing saved): `node test/dev.mjs` → http://localhost:3000, sign in as reliableos / adminpass1 (admin), loriale / 11111111, ben / 22222222, mayer / 33333333. `FAKE_GEO=1` fakes map points.
- Local run with real storage: `npm i -g vercel`, `vercel link` (team: reliable-os, project: roofing-solutions-tasks), `vercel env pull .env.local`, `vercel dev`.
  Note: local dev writes to the SAME live Blob store — use a test task and delete it.
- Deploy: `vercel --prod` (or connect a GitHub repo to the project for auto-deploys).

## History / gotchas
- Nov 2026: saves failed with "board is busy" because the etag from `get()` didn't match the one `put()` checks once the JSON grew. Fixed by taking the etag from `head()` and letting the last retries write unguarded. Keep that behavior if refactoring.
- Hobby plan keeps runtime logs ~1 hour; check `vercel logs` soon after a reported error.
- Status columns: To do, In progress, Waiting on customer, Done. Task types and statuses are validated server-side in `api/op.js` — update both client and server lists together.

## Ideas the owner may ask for next
Recurring tasks, touch drag-and-drop, customer-facing estimate PDFs, QuickBooks invoice sync, two-way texting (customer replies), a real database (Postgres) if the JSON file gets large, finer permissions (e.g. hide dollar amounts from crews), export to CSV.
