// Turning alerts on/off for one device.  GET = the public key the browser needs.
// POST {sub} = remember this device for the signed-in person.  DELETE {endpoint} = forget it.
import { json, getUser } from './_lib.js';
import { pushConfigured, saveSub, removeSub } from './_push.js';

export default {
  async fetch(request) {
    const by = getUser(request);
    if (!by) return json({ error: 'Sign in required' }, 401);
    if (request.method === 'GET') return json({ configured: pushConfigured(), key: process.env.VAPID_PUBLIC_KEY || '' });
    let b = {};
    try { b = await request.json(); } catch {}
    try {
      if (request.method === 'POST') {
        if (!pushConfigured()) return json({ error: 'Alerts are not set up on the server yet.' }, 400);
        return (await saveSub(by, b.sub)) ? json({ ok: true }) : json({ error: 'This device could not be registered.' }, 400);
      }
      if (request.method === 'DELETE') { await removeSub(String(b.endpoint || '')); return json({ ok: true }); }
    } catch (e) { console.error(e); return json({ error: 'Could not save. Try again.' }, 500); }
    return json({ error: 'Method not allowed' }, 405);
  },
};
