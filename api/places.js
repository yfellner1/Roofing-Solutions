// Address suggestions while typing: GET /api/places?q=12+main&lat=..&lng=..
// Uses Google Places when GOOGLE_MAPS_KEY is set (most accurate for house numbers),
// otherwise the free OpenStreetMap-based Photon service (no key).
import { json, getUser } from './_lib.js';

const ST = { Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', 'District of Columbia': 'DC', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT', Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY' };

const G = 'https://places.googleapis.com/v1/places';
const strip = (t) => String(t || '').replace(/, (USA|United States)$/, '');

async function googleAsk(q, token, area) {
  const body = { input: q, includedRegionCodes: ['us'], ...(token ? { sessionToken: token } : {}), ...area };
  const r = await fetch(G + ':autocomplete', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GOOGLE_MAPS_KEY },
    body: JSON.stringify(body), signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) throw new Error('places ' + r.status);
  const d = await r.json();
  return (d.suggestions || []).map((s) => s.placePrediction).filter((p) => p?.text?.text && p.placeId).slice(0, 6)
    .map((p) => ({ label: strip(p.text.text), id: p.placeId }));
}
// Looks close to the shop first (about 25 miles), then about 100 miles, then the whole
// country, so a common street name brings up the local one before other states.
async function google(q, near, token) {
  for (const [dLat, dLng] of near ? [[0.4, 0.5], [1.5, 2]] : []) {
    const local = await googleAsk(q, token, { locationRestriction: { rectangle: {
      low: { latitude: near.lat - dLat, longitude: near.lng - dLng }, high: { latitude: near.lat + dLat, longitude: near.lng + dLng } } } });
    if (local.length) return local;
  }
  return googleAsk(q, token, {});
}
// The chosen suggestion's full address (with ZIP) and exact map point.
async function googleDetails(id, token) {
  const r = await fetch(G + '/' + encodeURIComponent(id) + (token ? '?sessionToken=' + encodeURIComponent(token) : ''), {
    headers: { 'x-goog-api-key': process.env.GOOGLE_MAPS_KEY, 'x-goog-fieldmask': 'formattedAddress,location' }, signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) throw new Error('place ' + r.status);
  const d = await r.json();
  const lat = d.location?.latitude, lng = d.location?.longitude;
  return { label: strip(d.formattedAddress), ...(Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : {}) };
}

async function photon(q, near) {
  // Photon ignores the house number when ranking, so ask for extra and sort ourselves.
  let u = 'https://photon.komoot.io/api/?lang=en&limit=15&q=' + encodeURIComponent(q);
  if (near) u += '&lat=' + near.lat + '&lon=' + near.lng;
  const r = await fetch(u, { headers: { 'user-agent': 'office-task-board/1.0' }, signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error('photon ' + r.status);
  const d = await r.json();
  const typed = (q.match(/^\s*(\d+)/) || [])[1] || '';
  const out = [], seen = new Set();
  for (const f of d.features || []) {
    const p = f.properties || {};
    if (p.countrycode !== 'US') continue;
    const street = p.street || (['street', 'house'].includes(p.type) ? p.name : '');
    if (!street) continue;
    // If the map knows the street but not this house number, keep the number that was typed.
    const num = p.housenumber || typed;
    const town = p.city || p.town || p.village || p.locality || p.county || '';
    const label = [[num, street].filter(Boolean).join(' '), town, [ST[p.state] || p.state || '', p.postcode || ''].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    if (seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    const [lng, lat] = f.geometry?.coordinates || [];
    const exact = !!p.housenumber && (!typed || p.housenumber === typed);
    out.push({ label, exact, ...(exact && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : {}) });
  }
  return out.sort((a, b) => b.exact - a.exact).slice(0, 6).map(({ exact, ...x }) => x);
}

export default {
  async fetch(request) {
    if (!(await getUser(request))) return json({ error: 'Sign in required' }, 401);
    const url = new URL(request.url);
    const token = (url.searchParams.get('s') || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 36);
    const id = (url.searchParams.get('id') || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 300);
    if (id) {
      if (!process.env.GOOGLE_MAPS_KEY) return json({ result: null });
      try { return json({ result: await googleDetails(id, token) }); } catch (e) { console.warn(e.message); return json({ result: null }); }
    }
    const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
    if (q.length < 4) return json({ results: [] });
    const lat = parseFloat(url.searchParams.get('lat')), lng = parseFloat(url.searchParams.get('lng'));
    const near = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    try {
      if (process.env.GOOGLE_MAPS_KEY) { try { return json({ results: await google(q, near, token) }); } catch (e) { console.warn(e.message); } }
      return json({ results: await photon(q, near) });
    } catch (e) {
      return json({ results: [] });
    }
  },
};
