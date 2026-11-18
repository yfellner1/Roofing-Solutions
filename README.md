# Roofing Solutions – Office Task Board

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
