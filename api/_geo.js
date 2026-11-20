// Address lookup + route ordering. No API key needed: the US Census geocoder is
// free for US street addresses, with OpenStreetMap as a fallback.

async function getJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'office-task-board/1.0', accept: 'application/json' }, signal: AbortSignal.timeout(4500) });
  if (!r.ok) throw new Error('geocode ' + r.status);
  return r.json();
}

// Returns { lat, lng } or null. Never throws — a ticket must save even if lookup fails.
export async function geocode(address) {
  const q = String(address || '').trim();
  if (q.length < 6) return null;
  try {
    const d = await getJson('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=' + encodeURIComponent(q));
    const c = d?.result?.addressMatches?.[0]?.coordinates;
    if (c && Number.isFinite(c.x) && Number.isFinite(c.y)) return { lat: c.y, lng: c.x };
  } catch { /* try the fallback */ }
  try {
    const d = await getJson('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=' + encodeURIComponent(q));
    const lat = parseFloat(d?.[0]?.lat), lng = parseFloat(d?.[0]?.lon);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  } catch { /* give up quietly */ }
  return null;
}

export function miles(a, b) {
  const R = 3958.8, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Orders stops into a short driving route: nearest-neighbour, then 2-opt cleanup.
// `start` (the shop) is optional. Stops without coordinates keep their order at the end.
export function bestRoute(stops, start) {
  const located = stops.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
  const rest = stops.filter((s) => !located.includes(s));
  if (located.length < 2) return [...located, ...rest];
  const hasStart = start && Number.isFinite(start.lat) && Number.isFinite(start.lng);
  const candidates = hasStart ? [null] : located.map((_, i) => i);
  let best = null, bestLen = Infinity;
  for (const first of candidates) {
    const left = located.slice();
    const path = [];
    let cur = hasStart ? start : left.splice(first, 1)[0];
    if (!hasStart) path.push(cur);
    while (left.length) {
      let bi = 0, bd = Infinity;
      left.forEach((s, i) => { const d = miles(cur, s); if (d < bd) { bd = d; bi = i; } });
      cur = left.splice(bi, 1)[0];
      path.push(cur);
    }
    const len = (p) => p.reduce((sum, s, i) => sum + miles(i ? p[i - 1] : hasStart ? start : p[0], s), 0);
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = hasStart ? 0 : 1; i < path.length - 1; i++) {
        for (let j = i + 1; j < path.length; j++) {
          const next = [...path.slice(0, i), ...path.slice(i, j + 1).reverse(), ...path.slice(j + 1)];
          if (len(next) + 1e-9 < len(path)) { path.splice(0, path.length, ...next); improved = true; }
        }
      }
    }
    const total = len(path);
    if (total < bestLen) { bestLen = total; best = path.slice(); }
  }
  return [...best, ...rest];
}

// Day order when some stops have a set arrival time: timed stops stay in clock order
// and every other stop is slotted in wherever it adds the least driving.
export function planOrder(stops, start) {
  const ok = (s) => Number.isFinite(s.lat) && Number.isFinite(s.lng);
  const timed = stops.filter((s) => s.time).sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  if (!timed.length) return bestRoute(stops, start);
  const seq = timed.slice();
  const hasStart = start && ok(start);
  const d = (a, b) => (a && b && ok(a) && ok(b) ? miles(a, b) : 0);
  for (const s of bestRoute(stops.filter((x) => !x.time && ok(x)), start)) {
    let at = seq.length, cost = Infinity;
    for (let i = 0; i <= seq.length; i++) {
      const prev = i ? seq[i - 1] : hasStart ? start : null, next = seq[i] || null;
      const add = d(prev, s) + d(s, next) - d(prev, next);
      if (add < cost) { cost = add; at = i; }
    }
    seq.splice(at, 0, s);
  }
  return [...seq, ...stops.filter((x) => !x.time && !ok(x))];
}

// Real driving times from Google (needs GOOGLE_MAPS_KEY with the Routes API enabled).
// `ordered` is the planned order; with `optimize` Google may reorder it. Returns
// { order: [ids], legs: { id: { mi, min } } } or null if Google can't be used.
export async function driveRoute(ordered, start, optimize) {
  const key = process.env.GOOGLE_MAPS_KEY;
  const pts = ordered.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
  const hasStart = start && Number.isFinite(start.lat) && Number.isFinite(start.lng);
  if (!key || pts.length < (hasStart ? 1 : 2) || pts.length > 25 || pts.length !== ordered.length) return null;
  const wp = (p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
  // With a shop and free ordering, plan a loop from the shop and back. Otherwise drive the list end to end.
  const loop = hasStart && optimize;
  const origin = hasStart ? start : pts[0];
  const destination = loop ? start : pts[pts.length - 1];
  const mid = loop ? pts : pts.slice(hasStart ? 0 : 1, -1);
  try {
    const r = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key, 'x-goog-fieldmask': 'routes.optimizedIntermediateWaypointIndex,routes.legs.duration,routes.legs.distanceMeters' },
      body: JSON.stringify({ origin: wp(origin), destination: wp(destination), intermediates: mid.map(wp), travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE', optimizeWaypointOrder: !!optimize && mid.length > 1 }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) { console.warn('routes api', r.status); return null; }
    const route = (await r.json()).routes?.[0];
    if (!route?.legs?.length) return null;
    const idx = route.optimizedIntermediateWaypointIndex;
    const midOrder = Array.isArray(idx) && idx.length === mid.length && idx.every((i) => i >= 0) ? idx.map((i) => mid[i]) : mid;
    const visit = loop ? midOrder : [...(hasStart ? [] : [pts[0]]), ...midOrder, pts[pts.length - 1]];
    const legs = {};
    // legs[i] ends at the i-th point after the origin.
    const after = hasStart ? visit : visit.slice(1);
    after.forEach((p, i) => {
      const leg = route.legs[i];
      if (leg) legs[p.id] = { mi: Math.round(((leg.distanceMeters || 0) / 1609.344) * 10) / 10, min: Math.round(parseInt(leg.duration || '0', 10) / 60) };
    });
    return { order: visit.map((p) => p.id), legs };
  } catch (e) { console.warn('routes api failed', e.message); return null; }
}
