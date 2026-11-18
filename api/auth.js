import { json, getUser, userForPin, cookieFor } from './_lib.js';
import { smsConfigured } from './_sms.js';

const COOKIE = 'Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax';

export default {
  async fetch(request) {
    if (request.method === 'GET') {
      const name = getUser(request);
      return json({ ok: !!name, name, sms: smsConfigured() });
    }
    if (request.method === 'DELETE') {
      return json({ ok: true }, 200, { 'set-cookie': 'rs_user=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax' });
    }
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    let body = {};
    try { body = await request.json(); } catch {}
    const name = userForPin(String(body.pin || '').trim());
    if (!name) {
      await new Promise((r) => setTimeout(r, 1000));
      return json({ error: 'That code is not right. Check it and try again.' }, 401);
    }
    return json({ ok: true, name, sms: smsConfigured() }, 200, { 'set-cookie': `rs_user=${cookieFor(name)}; ${COOKIE}` });
  },
};
