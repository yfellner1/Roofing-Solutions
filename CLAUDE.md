# Roofing Solutions – Office Task Board

Shared task board for Roofing Solutions LLC (roofing, siding, gutters), a Reliable OS client.
Users: Loriale (Reliable OS office staff), Mayer (owner), Mrs. Salcer (bookkeeper),
foremen Ben, Mr. Klein, Yehuda. Live at https://roofing-solutions-tasks.vercel.app

## Stack
- No framework, no build step. `index.html` is the whole front end (HTML + CSS + vanilla JS in one file).
- `api/*.js` are Vercel Node functions (Web `fetch` handler style, ESM).
- Storage: one **private** Vercel Blob store. All board data is a single JSON file `db/board.json`
  (`{ seq, tasks, notes, photos }`); photos are separate blobs under `img/<taskId>/`.
- Installable PWA: `manifest.webmanifest`, `sw.js` (bump `CACHE` version when shell files change).

## Files
- `api/_lib.js`  — shared: people list, sign-in cookie signing, `readDb`, `mutate` (read-modify-write with ifMatch etag guard + fallback so saves never lock up).
- `api/auth.js`  — POST code → sets `rs_user` cookie; GET → who am I; DELETE → sign out.
- `api/board.js` — GET full board (signed-in only).
- `api/op.js`    — all writes: create, update, status, note, delete, removePhoto. Author always comes from the cookie, never the request body.
- `api/photo.js` — POST upload (client compresses to JPEG first), GET streams a private photo.

## Auth model
- Each person has their own 8-digit code in env var `USER_PINS` (JSON name → code). Names must match `PEOPLE` in `api/_lib.js` and the `PEOPLE` array in `index.html`.
- Cookie = base64url(name) + HMAC(AUTH_SECRET, name:code). Changing someone's code signs only them out.
- Never commit real codes. Never trust a name sent from the browser.

## Adding a person
1. Add to `PEOPLE` in `api/_lib.js` and in `index.html` (name, role, avatar color).
2. Add their code to `USER_PINS` in Vercel, then redeploy.

## Develop / test / deploy
- Server logic tests (no network, mocked Blob): `node test/run.mjs`
- Local run with real storage: `npm i -g vercel`, `vercel link` (team: reliable-os, project: roofing-solutions-tasks), `vercel env pull .env.local`, `vercel dev`.
  Note: local dev writes to the SAME live Blob store — use a test task and delete it.
- Deploy: `vercel --prod` (or connect a GitHub repo to the project for auto-deploys).

## History / gotchas
- Nov 2026: saves failed with "board is busy" because the etag from `get()` didn't match the one `put()` checks once the JSON grew. Fixed by taking the etag from `head()` and letting the last retries write unguarded. Keep that behavior if refactoring.
- Hobby plan keeps runtime logs ~1 hour; check `vercel logs` soon after a reported error.
- Status columns: To do, In progress, Waiting on customer, Done. Task types and statuses are validated server-side in `api/op.js` — update both client and server lists together.

## Ideas the owner may ask for next
Push/email notifications on assignment, recurring tasks, a real database (Postgres) if the JSON file gets large, per-person permissions, export to CSV.
