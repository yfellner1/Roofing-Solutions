import { json } from './_lib.js';
import { getAuth, loadUsers, saveUsers, cookieFor, checkPassword, normalizeUsername, peopleList } from './_users.js';
import { smsConfigured } from './_sms.js';

const COOKIE = 'Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax';
const WRONG = "That username and password don't match. Check both and try again.";
const MAX_FAILS = 8, LOCK_MS = 10 * 60 * 1000;
// What the browser needs about everyone: names, job titles, colours (no usernames, no hashes).
const people = (data) => peopleList(data).map(({ name, title, color, active }) => ({ name, title, color, active }));

export default {
  async fetch(request) {
    if (request.method === 'GET') {
      const me = await getAuth(request);
      return json({ ok: !!me, name: me ? me.name : '', role: me ? me.role : '', username: me ? me.username : '', people: me ? people(await loadUsers()) : [], sms: smsConfigured() });
    }
    if (request.method === 'DELETE') {
      return json({ ok: true }, 200, { 'set-cookie': 'rs_user=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax' });
    }
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    let body = {};
    try { body = await request.json(); } catch {}
    const username = normalizeUsername(body.username), password = String(body.password ?? '');
    if (!username || !password) return json({ error: 'Enter your username and password.' }, 400);
    const data = await loadUsers(true);
    const hit = Object.entries(data.users).find(([, u]) => u.username === username);
    const [id, u] = hit || [];
    // Wrong password, unknown username and switched-off accounts all get the same answer,
    // so the form does not reveal which usernames exist.
    if (u && (u.lockUntil || 0) > Date.now()) return json({ error: 'Too many attempts. Wait a few minutes and try again.' }, 429);
    if (!u || !u.active || !checkPassword(u, password)) {
      if (u && u.active) {
        u.fails = (u.fails || 0) + 1;
        if (u.fails >= MAX_FAILS) { u.lockUntil = Date.now() + LOCK_MS; u.fails = 0; }
        await saveUsers(data);
      }
      await new Promise((r) => setTimeout(r, 1000));
      return json({ error: WRONG }, 401);
    }
    if (u.fails || u.lockUntil) { u.fails = 0; u.lockUntil = 0; await saveUsers(data); }
    return json({ ok: true, name: u.name, role: u.role, username: u.username, people: people(data), sms: smsConfigured() }, 200, { 'set-cookie': `rs_user=${cookieFor(id, u)}; ${COOKIE}` });
  },
};
