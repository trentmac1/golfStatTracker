// Geometry helpers: distances, local east/north projection and miss direction.
// All distances are in metres. Points are {lat, lon} in degrees.

const R = 6371008.8; // mean Earth radius, m
const rad = (d) => (d * Math.PI) / 180;

export function distance(a, b) {
  if (!a || !b) return null;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Project p to local east (x) / north (y) metres around origin.
// Equirectangular is accurate to well under 1 cm over a golf hole.
export function toLocal(origin, p) {
  return {
    x: rad(p.lon - origin.lon) * Math.cos(rad(origin.lat)) * R,
    y: rad(p.lat - origin.lat) * R,
  };
}

export function fromLocal(origin, v) {
  return {
    lat: origin.lat + (v.y / R) * (180 / Math.PI),
    lon: origin.lon + (v.x / (R * Math.cos(rad(origin.lat)))) * (180 / Math.PI),
  };
}

export function median(values) {
  const v = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export function quantile(values, q) {
  const v = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

// Miss maths from the build plan.
// S = shot start, T = target, E = where the ball finished.
// long  = d·û − |T−S|   (negative = short)
// right = d_x·û_y − d_y·û_x (negative = left)
export function miss(S, T, E) {
  if (!S || !T || !E) return null;
  const t = toLocal(S, T);
  const e = toLocal(S, E);
  const len = Math.hypot(t.x, t.y);
  if (len < 1) return null; // target on top of the start: undefined direction
  const ux = t.x / len;
  const uy = t.y / len;
  const long = e.x * ux + e.y * uy - len;
  const right = e.x * uy - e.y * ux;
  return { long, right, off: Math.hypot(long, right) };
}

// Turn a miss into words, e.g. "Short-right 8 m".
// A component counts when it is at least `tol` metres and at least a third
// of the larger component, so a 20 m short with 2 m right reads "Short 20 m".
export function missLabel(m, tol = 3) {
  if (!m) return '';
  const a = Math.abs(m.long);
  const b = Math.abs(m.right);
  const big = Math.max(a, b);
  const parts = [];
  if (a >= tol && a >= big / 3) parts.push(m.long < 0 ? 'short' : 'long');
  if (b >= tol && b >= big / 3) parts.push(m.right < 0 ? 'left' : 'right');
  if (!parts.length) return 'On target';
  const s = parts.join('-');
  return `${s[0].toUpperCase()}${s.slice(1)} ${Math.round(m.off)} m`;
}

// Eight-way bucket for the "most common miss" stat.
export function missBucket(m, tol = 3) {
  if (!m) return null;
  const label = missLabel(m, tol);
  if (label === 'On target') return null;
  return label.split(' ')[0].toLowerCase();
}

// Bearing in degrees clockwise from north, used to rotate the map so the hole
// plays "up the screen".
export function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
