// Hole maps: fairways, tees, bunkers and water from OpenStreetMap, matched to
// each hole, plus the lie at any point (green, bunker, water, tee, fairway or
// rough). Outlines are smoothed before they are drawn or tested, so a shape a
// mapper traced with few points still shows as a soft, rounded outline.
// Pure functions, no DOM, so they can be unit tested in Node.
import { toLocal, fromLocal, distance } from './geo.js';

// ---------- smoothing ----------
// Drop a repeated closing point and points closer than ~0.3 m to the last kept.
function clean(ring) {
  const out = [];
  for (const p of ring) {
    const q = out.at(-1);
    if (!q || Math.abs(p.lat - q.lat) > 3e-6 || Math.abs(p.lon - q.lon) > 3e-6) out.push(p);
  }
  while (out.length > 3 && Math.abs(out[0].lat - out.at(-1).lat) <= 3e-6 && Math.abs(out[0].lon - out.at(-1).lon) <= 3e-6) out.pop();
  return out;
}

// Long straight edges are split first, so smoothing rounds each corner over
// up to 15 m either side (like a real fairway end) without pulling a long
// edge inwards. Shapes traced with closer points keep their detail.
const SPLIT_M = 30;
function densify(ring, maxM) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    out.push(a);
    const n = Math.floor((distance(a, b) ?? 0) / maxM);
    for (let k = 1; k <= n; k++) {
      const t = k / (n + 1);
      out.push({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t });
    }
  }
  return out;
}

// Chaikin corner cutting on a closed ring of {lat, lon}. It works directly on
// degrees because it only takes weighted averages of neighbouring points.
// Four rounds turn every corner into a smooth curve.
export function smoothRing(ring, { rounds = 4, maxEdgeM = SPLIT_M } = {}) {
  let pts = clean(ring ?? []);
  if (pts.length < 3) return pts;
  pts = densify(pts, maxEdgeM);
  for (let r = 0; r < rounds; r++) {
    const next = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      next.push({ lat: 0.75 * a.lat + 0.25 * b.lat, lon: 0.75 * a.lon + 0.25 * b.lon });
      next.push({ lat: 0.25 * a.lat + 0.75 * b.lat, lon: 0.25 * a.lon + 0.75 * b.lon });
    }
    pts = next;
  }
  return pts;
}

// SVG path through screen points [[x, y], ...] as a smooth closed curve:
// quadratic curves through the midpoints of each edge (no sharp corners).
export function smoothPathD(pts, f = (n) => n.toFixed(2)) {
  if (!pts || pts.length < 3) return '';
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const n = pts.length;
  const m0 = mid(pts[n - 1], pts[0]);
  let d = `M${f(m0[0])},${f(m0[1])}`;
  for (let i = 0; i < n; i++) {
    const c = pts[i], m = mid(c, pts[(i + 1) % n]);
    d += `Q${f(c[0])},${f(c[1])} ${f(m[0])},${f(m[1])}`;
  }
  return `${d}Z`;
}

// Stored rings are [[lat, lon], ...]; drawing and lie tests use smoothed {lat, lon}.
export const ringPts = (ring) => ring.map(([lat, lon]) => ({ lat, lon }));
const cache = new WeakMap();
export function smoothed(ring) {
  if (!ring) return [];
  let s = cache.get(ring);
  if (!s) { s = smoothRing(ringPts(ring)); cache.set(ring, s); }
  return s;
}

// For SVG previews: the cleaned ring with long edges split, ready to project
// and draw with smoothPathD (which gives the same curve Chaikin converges to).
const pcache = new WeakMap();
export function previewRing(ring) {
  if (!ring) return [];
  let s = pcache.get(ring);
  if (!s) { s = densify(clean(ringPts(ring)), SPLIT_M); pcache.set(ring, s); }
  return s;
}

// ---------- geometry ----------
export function inside(pt, poly) {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.lat > pt.lat) !== (b.lat > pt.lat) &&
        pt.lon < ((b.lon - a.lon) * (pt.lat - a.lat)) / (b.lat - a.lat) + a.lon) ins = !ins;
  }
  return ins;
}

// Distance in metres from p to a polyline of {lat, lon}, and how far along it.
function toLine(p, line) {
  let best = { d: Infinity, along: 0 };
  let run = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const a = toLocal(p, line[i]), b = toLocal(p, line[i + 1]);
    const ex = b.x - a.x, ey = b.y - a.y, L2 = ex * ex + ey * ey;
    const t = L2 ? Math.max(0, Math.min(1, -(a.x * ex + a.y * ey) / L2)) : 0;
    const d = Math.hypot(a.x + ex * t, a.y + ey * t);
    if (d < best.d) best = { d, along: run + t * Math.sqrt(L2) };
    run += Math.sqrt(L2);
  }
  return best;
}
const lineLength = (line) => line.slice(1).reduce((a, p, i) => a + distance(line[i], p), 0);

// Points every `step` metres along a polyline.
function sampleLine(line, step = 4) {
  const out = [];
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i], b = line[i + 1];
    const n = Math.max(1, Math.round(distance(a, b) / step));
    for (let k = 0; k < n; k++) out.push({ lat: a.lat + ((b.lat - a.lat) * k) / n, lon: a.lon + ((b.lon - a.lon) * k) / n });
  }
  if (line.length) out.push(line.at(-1));
  return out;
}

const wayPts = (e) => clean((e.geometry ?? []).map((g) => ({ lat: g.lat, lon: g.lon })));
const minDist = (line, poly) => Math.min(...poly.map((p) => toLine(p, line).d));
const r7 = (p) => [Math.round(p.lat * 1e7) / 1e7, Math.round(p.lon * 1e7) / 1e7];

// The line of play for a hole: the map's numbered hole line if it reaches
// near the hole's green, otherwise straight from the tee to the green.
function playLine(h, holeWays) {
  const way = holeWays.get(h.n);
  if (way?.length >= 2 && (!h.green || distance(way.at(-1), h.green) < 60)) return way;
  if (h.tee && h.green) return [h.tee, h.green];
  return null;
}

// Match OSM fairways, tees, bunkers and water to holes.
// Returns { [holeNumber]: { line, fairways, tees, bunkers, water } } with rings
// (and the line of play) as [[lat, lon]].
export function matchFeatures(course, osm) {
  const els = osm?.elements ?? [];
  const kind = (e) => {
    const g = e.tags?.golf;
    return g === 'water_hazard' || g === 'lateral_water_hazard' ? 'water' : g;
  };
  const polys = (k) => els.filter((e) => kind(e) === k).map(wayPts).filter((p) => p.length >= 3);
  const fairways = polys('fairway'), tees = polys('tee'), bunkers = polys('bunker'), water = polys('water');
  const holeWays = new Map(els.filter((e) => e.tags?.golf === 'hole' && /^\d+$/.test(e.tags.ref ?? '')).map((e) => [Number(e.tags.ref), wayPts(e)]));
  const out = {};
  for (const h of course.holes) {
    const line = playLine(h, holeWays);
    if (!line) continue;
    const len = lineLength(line);
    const samples = sampleLine(line);
    // Fairways the line of play runs through for at least 16 m.
    let fw = fairways.filter((p) => samples.filter((s) => inside(s, p)).length * 4 >= 16);
    // Doglegs where the line cuts the corner: a fairway close beside the line,
    // between tee and green. Only when nothing else matched, so a neighbouring
    // hole's fairway isn't pulled in.
    if (!fw.length && h.par >= 4) {
      fw = fairways.filter((p) => {
        const near = p.map((q) => toLine(q, line));
        const close = near.filter((n) => n.d <= 25 && n.along > 30 && n.along < len - 10);
        return close.length >= Math.max(2, near.length * 0.3);
      });
    }
    const start = line[0];
    out[h.n] = {
      line: line.map(r7),
      fairways: fw.map((p) => p.map(r7)),
      tees: tees.filter((p) => p.some((q) => distance(q, start) < 70) && minDist(line, p) < 20).map((p) => p.map(r7)),
      bunkers: bunkers.filter((p) => minDist(line, p) < 32 || (h.green && p.some((q) => distance(q, h.green) < 35))).map((p) => p.map(r7)),
      water: water.filter((p) => minDist(line, p) < 45).map((p) => p.map(r7)),
    };
  }
  return out;
}

// The line of play as {lat, lon}: the saved map line, else tee to green.
export function holeLine(courseHole) {
  if (courseHole?.features?.line?.length >= 2) return ringPts(courseHole.features.line);
  if (courseHole?.tee && courseHole?.green) return [courseHole.tee, courseHole.green];
  return null;
}

// A rough fairway for a par 4 or 5 with none mapped: a 30 m wide strip
// along the line of play, from where a typical drive lands to just short of
// the green. Only for drawing; lies never use it.
export function estimateFairway(courseHole) {
  if (!courseHole || courseHole.par < 4 || courseHole.features?.fairways?.length) return null;
  const line = holeLine(courseHole);
  if (!line) return null;
  const len = lineLength(line);
  const from = Math.min(150, Math.max(70, len * 0.33));
  const to = len - 22;
  if (to - from < 40) return null;
  const O = line[0];
  const xy = line.map((p) => toLocal(O, p));
  // point and unit direction at distance d along the line
  const at = (d) => {
    let run = 0;
    for (let i = 0; i < xy.length - 1; i++) {
      const a = xy[i], b = xy[i + 1], L = Math.hypot(b.x - a.x, b.y - a.y);
      if (run + L >= d || i === xy.length - 2) {
        const t = L ? Math.min(1, Math.max(0, (d - run) / L)) : 0;
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, ux: (b.x - a.x) / (L || 1), uy: (b.y - a.y) / (L || 1) };
      }
      run += L;
    }
    return null;
  };
  const HALF = 15;
  const n = Math.max(2, Math.round((to - from) / 20));
  const left = [], right = [];
  for (let k = 0; k <= n; k++) {
    const p = at(from + ((to - from) * k) / n);
    // narrower at the ends, so they round off once smoothed
    const w = k === 0 || k === n ? HALF * 0.6 : HALF;
    left.push({ x: p.x - p.uy * w, y: p.y + p.ux * w });
    right.push({ x: p.x + p.uy * w, y: p.y - p.ux * w });
  }
  const ring = [...left, ...right.reverse()];
  return ring.map((q) => r7(fromLocal(O, q)));
}

// ---------- lies ----------
export const LIE_LABEL = { green: 'Green', bunker: 'Bunker', water: 'Water', tee: 'Tee', fairway: 'Fairway', rough: 'Rough' };

// What the ball is sitting in at point p, from the hole's map.
// Returns null when the hole has no map to tell (then nothing is guessed).
export function lieAt(p, courseHole) {
  if (!p || !courseHole) return null;
  const shape = courseHole.shape, f = courseHole.features;
  if (shape?.polygon && inside(p, smoothed(shape.polygon))) return 'green';
  const any = (rings) => (rings ?? []).some((r) => inside(p, smoothed(r)));
  if (any(f?.bunkers) || any(shape?.bunkers)) return 'bunker';
  if (!f) return null;
  if (any(f.water)) return 'water';
  if (any(f.fairways)) return 'fairway';
  if (any(f.tees)) return 'tee';
  // Off every mapped surface. Only call it rough when the hole's fairway is
  // mapped (or it's a par 3, which has none), otherwise we can't know.
  return f.fairways?.length || courseHole.par === 3 ? 'rough' : null;
}
