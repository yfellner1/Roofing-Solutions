// Address suggestions while typing: GET /api/places?q=12+main&lat=..&lng=..
// Uses Google Places when GOOGLE_MAPS_KEY is set (most accurate for house numbers),
// otherwise the free OpenStreetMap-based Photon service (no key).
import { json, getUser } from './_lib.js';

const ST = { Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', 'District of Columbia': 'DC', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT', Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY' };

async function google(q, near) {
  const body = { input: q, includedRegionCodes: ['us'] };
  if (near) body.locationBias = { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 50000 } };
  const r = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GOOGLE_MAPS_KEY },
    body: JSON.stringify(body), signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) throw new Error('places ' + r.status);
  const d = await r.json();
  return (d.suggestions || []).map((s) => s.placePrediction?.text?.text).filter(Boolean).slice(0, 6)
    .map((t) => ({ label: t.replace(/, (USA|United States)$/, '') }));
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
    if (!getUser(request)) return json({ error: 'Sign in required' }, 401);
    const url = new URL(request.url);
    const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
    if (q.length < 4) return json({ results: [] });
    const lat = parseFloat(url.searchParams.get('lat')), lng = parseFloat(url.searchParams.get('lng'));
    const near = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    try {
      if (process.env.GOOGLE_MAPS_KEY) { try { return json({ results: await google(q, near) }); } catch (e) { console.warn(e.message); } }
      return json({ results: await photon(q, near) });
    } catch (e) {
      return json({ results: [] });
    }
  },
};
