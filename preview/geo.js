// Small geo helpers: distance, geohash cells for the explored map.
const B32 = "0123456789bcdefghjkmnpqrstuvwxyz";
export const CELL_PREC = 7;      // ~150 m x 150 m road tiles
export const PREFIX_PREC = 5;    // one stored doc per ~5 km square

export function haversine(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function ghEncode(lat, lng, prec = CELL_PREC) {
  let idx = 0, bit = 0, even = true, out = "";
  const la = [-90, 90], lo = [-180, 180];
  while (out.length < prec) {
    const r = even ? lo : la, v = even ? lng : lat, m = (r[0] + r[1]) / 2;
    if (v >= m) { idx = idx * 2 + 1; r[0] = m; } else { idx *= 2; r[1] = m; }
    even = !even;
    if (++bit === 5) { out += B32[idx]; bit = 0; idx = 0; }
  }
  return out;
}

const boundsCache = new Map();
export function ghBounds(gh) {
  let b = boundsCache.get(gh);
  if (b) return b;
  let even = true;
  const la = [-90, 90], lo = [-180, 180];
  for (const c of gh) {
    const n = B32.indexOf(c);
    for (let i = 4; i >= 0; i--) {
      const r = even ? lo : la, m = (r[0] + r[1]) / 2;
      if ((n >> i) & 1) r[0] = m; else r[1] = m;
      even = !even;
    }
  }
  b = { s: la[0], n: la[1], w: lo[0], e: lo[1] };
  boundsCache.set(gh, b);
  return b;
}

// Area of one road tile in km² at a given latitude.
export function cellAreaKm2(lat = -26) {
  const deg = 360 / 2 ** 18; // geohash-7 is 18 lng bits / 17 lat bits → square in degrees
  const side = deg * 111.32;
  return side * side * Math.cos(lat * Math.PI / 180);
}

// Points every `step` metres along a polyline (for seeding and smoothing gaps).
export function densify(points, step = 60) {
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const n = Math.max(1, Math.ceil(haversine(a, b) / step));
    for (let k = 0; k < n; k++) out.push({ lat: a.lat + (b.lat - a.lat) * k / n, lng: a.lng + (b.lng - a.lng) * k / n });
  }
  out.push(points[points.length - 1]);
  return out;
}

export const fmtKm = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`);
export function fmtAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
