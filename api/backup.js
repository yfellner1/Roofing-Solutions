// Backups of the board.  GET = list them.  POST {action:'now'} = save one right away.
// POST {action:'restore', name} = put a backup back (owner/office only; the current
// board is saved first as backups/before-restore-<time>.json so a restore can be undone).
import { json, getAuth, listBackups, backupNow, restoreBackup } from './_lib.js';

export default {
  async fetch(request) {
    const me = await getAuth(request);
    const by = me ? me.name : '', admin = !!me && me.role === 'admin';
    if (!by) return json({ error: 'Sign in required' }, 401);
    try {
      if (request.method === 'GET') return json({ backups: await listBackups(), canRestore: admin });
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      let b = {};
      try { b = await request.json(); } catch {}
      if (b.action === 'now') {
        const r = await backupNow();
        return r.ok ? json({ ok: true, backups: await listBackups() }) : json({ error: 'There is nothing to back up yet.' }, 400);
      }
      if (b.action === 'restore') {
        if (!admin) return json({ error: 'Only an admin can restore a backup.' }, 403);
        const r = await restoreBackup(String(b.name || ''));
        if (!r.ok) return json({ error: r.reason }, 400);
        console.warn('backup restored by', by, b.name);
        return json({ ok: true, board: r.db });
      }
      return json({ error: 'Unknown action.' }, 400);
    } catch (e) {
      console.error(e);
      return json({ error: 'Backups are not available right now. Try again.' }, 500);
    }
  },
};
