// Runs once every evening (see vercel.json; needs CRON_SECRET).
// 1. Saves a dated backup copy of the whole board.  2. Sends tomorrow's reminder texts.
import { json, backupNow } from './_lib.js';
import remind from './remind.js';

export default {
  async fetch(request) {
    const secret = process.env.CRON_SECRET;
    if (!secret || request.headers.get('authorization') !== 'Bearer ' + secret) return json({ error: 'Not allowed' }, 401);
    let backup;
    try { backup = await backupNow(); } catch (e) { console.error('backup failed', e); backup = { ok: false, reason: 'error' }; }
    let reminders;
    try { reminders = await (await remind.fetch(new Request(new URL('/api/remind', request.url), { headers: { authorization: 'Bearer ' + secret } }))).json(); }
    catch (e) { console.error('reminders failed', e); reminders = { ok: false }; }
    return json({ ok: true, backup: { ok: backup.ok, name: backup.name, reason: backup.reason }, reminders });
  },
};
