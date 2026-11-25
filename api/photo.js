import { json, getUser, mutate, readDb, uid, addActivity, put, get, removeBlob } from './_lib.js';

const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export default {
  async fetch(request) {
    const by = await getUser(request);
    if (!by) return json({ error: 'Sign in required' }, 401);
    const url = new URL(request.url);

    if (request.method === 'GET') {
      const id = url.searchParams.get('id') || '';
      const { db } = await readDb();
      const p = db.photos[id];
      if (!p) return new Response('Not found', { status: 404 });
      const r = await get(p.path, { access: 'private' });
      if (!r || r.statusCode !== 200) return new Response('Not found', { status: 404 });
      return new Response(r.stream, {
        headers: {
          'content-type': r.blob.contentType || 'image/jpeg',
          'x-content-type-options': 'nosniff',
          'cache-control': 'private, max-age=31536000, immutable',
        },
      });
    }

    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const taskId = url.searchParams.get('taskId') || '';
    const ctype = (request.headers.get('content-type') || '').split(';')[0].trim();
    const ext = TYPES[ctype];
    if (!ext) return json({ error: 'Only JPEG, PNG or WebP photos can be added.' }, 415);
    const buf = Buffer.from(await request.arrayBuffer());
    if (!buf.length || buf.length > 4_000_000) return json({ error: 'That photo is too large.' }, 413);

    const id = uid();
    const path = `img/${taskId.replace(/[^a-z0-9]/gi, '')}/${id}.${ext}`;
    await put(path, buf, { access: 'private', contentType: ctype, addRandomSuffix: false });
    try {
      const { db, result } = await mutate((db) => {
        if (!db.tasks[taskId] && !db.tickets[taskId]) return { error: 'That no longer exists.' };
        db.photos[id] = { taskId, by, at: Date.now(), path };
        addActivity(db, taskId, by, 'added a photo');
        return { id };
      });
      if (result.error) { await removeBlob(path); return json({ error: result.error }, 400); }
      return json({ ok: true, board: db });
    } catch (e) {
      await removeBlob(path);
      console.error(e);
      return json({ error: 'Could not save the photo. Try again.' }, 500);
    }
  },
};
