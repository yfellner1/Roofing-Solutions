// Accounts.  GET = everyone (admins only).  POST actions:
//   password — the signed-in person changes their own password
//   add / update / reset — admins add a person, change name / role / title / on-off, set a new password
import { json, mutate } from './_lib.js';
import { getAuth, loadUsers, saveUsers, peopleList, ROLES, TITLES, USERNAME_RULES, normalizeUsername, isValidUsername, passwordProblem, hashPassword, checkPassword, newStamp, newId, pickColor, cookieFor } from './_users.js';
import { renameSubs } from './_push.js';

const COOKIE = 'Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax';
const text = (v, max) => String(v ?? '').trim().slice(0, max);
const activeAdmins = (data, except) => Object.entries(data.users).filter(([id, u]) => id !== except && u.active && u.role === 'admin').length;

// A renamed person keeps their work: every place the old name was stored is updated.
async function renameEverywhere(from, to) {
  await mutate((db) => {
    for (const t of Object.values(db.tasks)) { if (t.assignee === from) t.assignee = to; if (t.createdBy === from) t.createdBy = to; }
    for (const t of Object.values(db.tickets)) { if (t.assignee === from) t.assignee = to; if (t.createdBy === from) t.createdBy = to; }
    for (const n of Object.values(db.notes)) if (n.by === from) n.by = to;
    for (const p of Object.values(db.photos)) if (p.by === from) p.by = to;
    if (db.settings && db.settings.officeAssignee === from) db.settings.officeAssignee = to;
  });
  await renameSubs(from, to);
}

export default {
  async fetch(request) {
    const me = await getAuth(request);
    if (!me) return json({ error: 'Sign in required' }, 401);
    const admin = me.role === 'admin';
    try {
      if (request.method === 'GET') {
        if (!admin) return json({ error: 'Only an admin can manage users.' }, 403);
        return json({ users: peopleList(await loadUsers(true)), roles: ROLES, titles: TITLES });
      }
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      let b = {};
      try { b = await request.json(); } catch {}
      const data = await loadUsers(true);

      if (b.action === 'password') {
        const u = data.users[me.id];
        if (!checkPassword(u, String(b.current ?? ''))) { await new Promise((r) => setTimeout(r, 800)); return json({ error: "Your current password isn't right." }, 400); }
        const problem = passwordProblem(String(b.password ?? ''));
        if (problem) return json({ error: 'New password: ' + problem }, 400);
        if (checkPassword(u, String(b.password))) return json({ error: "Choose a password you haven't used here." }, 400);
        Object.assign(u, hashPassword(String(b.password)), { stamp: newStamp() });
        await saveUsers(data);
        // Other devices are signed out; this one gets a fresh sign-in.
        return json({ ok: true }, 200, { 'set-cookie': `rs_user=${cookieFor(me.id, u)}; ${COOKIE}` });
      }

      if (!admin) return json({ error: 'Only an admin can manage users.' }, 403);
      const name = text(b.name, 60);
      const role = ROLES[b.role] ? b.role : '';
      const title = TITLES.includes(b.title) ? b.title : 'Other';
      const nameTaken = (except) => Object.entries(data.users).some(([id, u]) => id !== except && u.name.toLowerCase() === name.toLowerCase());

      if (b.action === 'add') {
        const username = normalizeUsername(b.username);
        if (!name) return json({ error: "Enter the person's name." }, 400);
        if (!isValidUsername(username)) return json({ error: 'Username: ' + USERNAME_RULES }, 400);
        if (!role) return json({ error: 'Choose a role.' }, 400);
        const problem = passwordProblem(String(b.password ?? ''));
        if (problem) return json({ error: 'Password: ' + problem }, 400);
        if (Object.values(data.users).some((u) => u.username === username)) return json({ error: 'That username is already taken.' }, 400);
        if (nameTaken('')) return json({ error: 'Someone already has that name. Add an initial to tell them apart.' }, 400);
        data.users[newId()] = { username, name, title, role, active: true, color: pickColor(data), ...hashPassword(String(b.password)), stamp: newStamp(), createdAt: Date.now(), createdBy: me.name };
        await saveUsers(data);
        return json({ ok: true, users: peopleList(data), message: `Added ${name}. They sign in with the username "${username}" and the password you set.` });
      }

      const u = data.users[b.id];
      if (!u) return json({ error: 'Unknown user.' }, 400);

      if (b.action === 'update') {
        const active = b.active !== false;
        if (!name) return json({ error: "Enter the person's name." }, 400);
        if (!role) return json({ error: 'Choose a role.' }, 400);
        if (nameTaken(b.id)) return json({ error: 'Someone already has that name.' }, 400);
        if (b.id === me.id && role !== 'admin') return json({ error: "You can't remove your own admin access." }, 400);
        if (b.id === me.id && !active) return json({ error: "You can't switch off your own account." }, 400);
        if ((role !== 'admin' || !active) && !activeAdmins(data, b.id)) return json({ error: 'There has to be at least one active admin.' }, 400);
        const oldName = u.name;
        // Switching an account off (or back on) signs that person out everywhere.
        if (u.active !== active) u.stamp = newStamp();
        Object.assign(u, { name, role, title, active });
        await saveUsers(data);
        if (oldName !== name) await renameEverywhere(oldName, name);
        return json({ ok: true, users: peopleList(data), message: 'Saved.' });
      }

      if (b.action === 'reset') {
        const problem = passwordProblem(String(b.password ?? ''));
        if (problem) return json({ error: problem }, 400);
        Object.assign(u, hashPassword(String(b.password)), { stamp: newStamp(), fails: 0, lockUntil: 0 });
        await saveUsers(data);
        console.warn('password reset for', u.username, 'by', me.username);
        const headers = b.id === me.id ? { 'set-cookie': `rs_user=${cookieFor(me.id, u)}; ${COOKIE}` } : {};
        return json({ ok: true, users: peopleList(data), message: `New password set for ${u.username}.` }, 200, headers);
      }
      return json({ error: 'Unknown action.' }, 400);
    } catch (e) {
      console.error(e);
      return json({ error: 'Could not save. Try again.' }, 500);
    }
  },
};
