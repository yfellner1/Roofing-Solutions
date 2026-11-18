import { json, getUser, readDb } from './_lib.js';

export default {
  async fetch(request) {
    if (!getUser(request)) return json({ error: 'Sign in required' }, 401);
    const { db } = await readDb();
    return json(db);
  },
};
