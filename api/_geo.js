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
