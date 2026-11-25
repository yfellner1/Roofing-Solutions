import { json, getUser, readDb } from './_lib.js';
import { loadUsers, peopleList } from './_users.js';

export default {
  async fetch(request) {
    if (!(await getUser(request))) return json({ error: 'Sign in required' }, 401);
    const { db } = await readDb();
    // The people list rides along so new or renamed accounts show up everywhere within seconds.
    const people = peopleList(await loadUsers()).map(({ name, title, color, active }) => ({ name, title, color, active }));
    return json({ ...db, people });
  },
};
