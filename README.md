# Roofing Solutions – Office Board (tasks + jobs & estimates)

Live: https://roofing-solutions-tasks.vercel.app (Vercel team `reliable-os`, project `roofing-solutions-tasks`)

Open this folder in Claude Code — `CLAUDE.md` explains how everything fits together.

Quick start:
```
npm install -g vercel
vercel link            # pick reliable-os / roofing-solutions-tasks
vercel env pull .env.local
node test/run.mjs      # server tests, no network
vercel dev             # local run (uses the live storage)
vercel --prod          # deploy
```

## Try it safely first
```
node test/dev.mjs      # http://localhost:3000 – in-memory copy, nothing is saved, live data untouched
```
Sign in with 11111111 (Loriale), 22222222 (Ben) or 33333333 (Mayer).

## Turning on automatic reminder texts (optional)
1. Create a Twilio account, buy a local number, and complete Twilio's A2P 10DLC registration (US carriers require it for business texting).
2. In Vercel → Settings → Environment Variables add `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` and a random `CRON_SECRET`, then redeploy.
3. In the app: Jobs & Estimates → Settings → set the company phone, shop address and message wording.

Texts go out around 6–7pm Eastern the evening before a scheduled visit. Until this is set up, the **Text reminder** button opens your phone's own Messages app with the text filled in.
