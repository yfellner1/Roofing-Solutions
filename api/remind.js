// Customer text reminders.
//   GET  — called by the Vercel cron each evening (see vercel.json). Texts every
//          customer who is on tomorrow's schedule and has not been reminded yet.
//   POST — a signed-in person previews or sends one reminder right now.
import { json, getUser, readDb, mutate, getSettings, todayYmd, addDays, weekday, str } from './_lib.js';
import { smsConfigured, sendSms, buildMessage, e164 } from './_sms.js';
import { recordReminder, recordText } from './_tickets.js';

export default {
  async fetch(request) {
    if (request.method === 'GET') {
      const secret = process.env.CRON_SECRET;
      if (!secret || request.headers.get('authorization') !== 'Bearer ' + secret) return json({ error: 'Not allowed' }, 401);
      const { db } = await readDb();
      const s = getSettings(db);
      const today = todayYmd(), tomorrow = addDays(today, 1);
      if (!smsConfigured()) return json({ ok: true, skipped: 'texting is not set up' });
      if (!s.autoSms) return json({ ok: true, skipped: 'automatic texts are turned off' });
      if (s.skipDays.includes(weekday(today))) return json({ ok: true, skipped: 'no automatic texts this evening' });
      const results = {};
      for (const [id, t] of Object.entries(db.tickets)) {
        if (t.date !== tomorrow || t.stage !== 'scheduled') continue;
        if (t.reminder && t.reminder.forDate === tomorrow && t.reminder.status === 'sent') continue;
        const c = db.customers[t.customerId];
        if (!c || c.smsOk === false || !e164(c.phone)) continue;
        results[id] = await sendSms(c.phone, buildMessage(s.smsTemplate, t, c, s));
      }
      if (Object.keys(results).length) {
        await mutate((db) => { for (const [id, res] of Object.entries(results)) if (db.tickets[id]?.date === tomorrow) recordReminder(db, id, 'Automatic reminder', res, 'auto'); });
      }
      const sent = Object.values(results).filter((r) => r.ok).length;
      return json({ ok: true, for: tomorrow, sent, failed: Object.keys(results).length - sent });
    }

    const by = getUser(request);
    if (!by) return json({ error: 'Sign in required' }, 401);
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    let b = {};
    try { b = await request.json(); } catch {}
    const { db } = await readDb();
    const t = db.tickets[b.id];
    if (!t) return json({ error: 'That ticket no longer exists.' }, 400);
    const c = db.customers[t.customerId] || {};
    const s = getSettings(db);
    const to = e164(c.phone);
    const kind = ['omw', 'thanks'].includes(b.kind) ? b.kind : 'reminder';
    const template = kind === 'omw' ? s.omwTemplate : kind === 'thanks' ? s.thanksTemplate : s.smsTemplate;
    const text = str(b.text, 600) || buildMessage(template, t, c, s);
    if (b.preview) return json({ ok: true, text, to, configured: smsConfigured(), smsOk: c.smsOk !== false });
    if (!to) return json({ error: 'This customer has no mobile number on file.' }, 400);
    if (c.smsOk === false) return json({ error: 'This customer asked not to be texted.' }, 400);
    const res = await sendSms(to, text);
    const out = await mutate((db) => { recordText(db, b.id, by, res, 'app', kind); });
    if (!res.ok) return json({ error: res.error, board: out.db }, 502);
    return json({ ok: true, board: out.db });
  },
};
