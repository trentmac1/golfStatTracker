// Shared course data: the rules both the app and the course server use to
// merge green, tee and card edits from different players. Pure functions, no
// browser or Node APIs, so the Pi server imports this same file.
//
// A shared course keeps, per hole and field, the value and when it was set:
//   { key, name, centre, holeCount, holes: [{ n, fields: { green: { v, ts }, ... } }] }
// The newest edit wins, except that a rough green (from the first ball on
// the green, `estimated`) never replaces one somebody placed properly.

export const POINT_FIELDS = ['green', 'front', 'back', 'tee'];
export const FIELDS = [...POINT_FIELDS, 'par', 'si'];
export const MAX_HOLES = 36;
const MAX_FROM_CENTRE_M = 6000;   // anything further out is a mistake (or spam)

function metres(a, b) {
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
export const validPoint = (p) => !!p && isNum(p.lat) && isNum(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;

// Normalise one field value, or return undefined if it isn't acceptable.
export function cleanValue(field, v, centre, holeCount = MAX_HOLES) {
  if (v === null) return null;                       // cleared on purpose
  if (POINT_FIELDS.includes(field)) {
    if (!validPoint(v)) return undefined;
    if (centre && validPoint(centre) && metres(centre, v) > MAX_FROM_CENTRE_M) return undefined;
    const p = { lat: Math.round(v.lat * 1e7) / 1e7, lon: Math.round(v.lon * 1e7) / 1e7 };
    if (field === 'green' && v.estimated) p.estimated = true;
    return p;
  }
  if (field === 'par') return Number.isInteger(v) && v >= 3 && v <= 6 ? v : undefined;
  if (field === 'si') return Number.isInteger(v) && v >= 1 && v <= holeCount ? v : undefined;
  return undefined;
}

// Which of two {v, ts} edits to keep.
export function pickEdit(field, cur, inc) {
  if (!inc) return cur;
  if (!cur) return inc;
  if (!(inc.ts > cur.ts)) return cur;
  if (field === 'green' && inc.v?.estimated && cur.v && !cur.v.estimated) return cur;
  return inc;
}

export function sameValue(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a !== 'object') return a === b;
  return Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7 && !!a.estimated === !!b.estimated;
}

// Merge incoming hole edits into a stored shared course (server side, or a
// test). `now` caps timestamps so a phone with a wrong clock can't win forever.
// Returns { course, changed } where changed counts fields that took the edit.
export function mergeShared(stored, incoming, { now = Date.now() } = {}) {
  const course = structuredClone(stored);
  course.holes ??= [];
  if (incoming.holeCount && Number.isInteger(incoming.holeCount) && incoming.holeCount > (course.holeCount ?? 0) && incoming.holeCount <= MAX_HOLES) {
    course.holeCount = incoming.holeCount;
  }
  let changed = 0;
  for (const ih of incoming.holes ?? []) {
    const n = ih?.n;
    if (!Number.isInteger(n) || n < 1 || n > MAX_HOLES) continue;
    let h = course.holes.find((x) => x.n === n);
    for (const [field, edit] of Object.entries(ih.fields ?? {})) {
      if (!FIELDS.includes(field) || !edit || !isNum(edit.ts)) continue;
      const v = cleanValue(field, edit.v, course.centre, Math.max(course.holeCount ?? 18, n));
      if (v === undefined) continue;
      const inc = { v, ts: Math.min(edit.ts, now) };
      if (!h) { h = { n, fields: {} }; course.holes.push(h); }
      const cur = h.fields[field];
      const win = pickEdit(field, cur, inc);
      if (win === inc && !(cur && sameValue(cur.v, inc.v) && cur.ts === inc.ts)) { h.fields[field] = inc; changed++; }
    }
    if (n > (course.holeCount ?? 0)) course.holeCount = n;
  }
  course.holes.sort((a, b) => a.n - b.n);
  return { course, changed };
}

// ---------- app side: a course on this phone <-> shared edits ----------

// Edits made on this phone that the server hasn't seen yet.
export function localEdits(course, since = 0) {
  const holes = [];
  for (const h of course.holes) {
    const fields = {};
    for (const [f, ts] of Object.entries(h.edits ?? {})) {
      if (!FIELDS.includes(f) || !(ts > since)) continue;
      fields[f] = { v: POINT_FIELDS.includes(f) ? (h[f] ? { lat: h[f].lat, lon: h[f].lon, ...(f === 'green' && h[f].estimated ? { estimated: true } : {}) } : null) : (h[f] ?? null), ts };
    }
    if (Object.keys(fields).length) holes.push({ n: h.n, fields });
  }
  return holes;
}

// Everything this phone knows about a course's positions, for a full upload:
// every green, edge and tee it has, plus pars and stroke indexes typed in.
// Positions nobody edited here (from the map, or set before sharing existed)
// go up as a baseline (ts 1): they fill gaps on the server but never replace
// a real edit.
export function snapshotEdits(course) {
  const holes = [];
  for (const h of course.holes) {
    const fields = {};
    for (const f of POINT_FIELDS) {
      if (!h[f]) continue;
      fields[f] = { v: { lat: h[f].lat, lon: h[f].lon, ...(f === 'green' && h[f].estimated ? { estimated: true } : {}) }, ts: h.edits?.[f] ?? 1 };
    }
    for (const f of ['par', 'si']) if (h.edits?.[f] && h[f] != null) fields[f] = { v: h[f], ts: h.edits[f] };
    // A position cleared here on purpose.
    for (const f of POINT_FIELDS) if (!h[f] && h.edits?.[f]) fields[f] = { v: null, ts: h.edits[f] };
    if (Object.keys(fields).length) holes.push({ n: h.n, fields });
  }
  return holes;
}

// How many holes of a shared course have a green / tee.
export function sharedCounts(shared) {
  const n = shared.holeCount ?? 18;
  const has = (f) => (shared.holes ?? []).filter((h) => h.n <= n && h.fields?.[f]?.v).length;
  return { holes: n, greens: has('green'), tees: has('tee') };
}

// Put shared edits onto a course on this phone. Edits made here that are
// newer stay. Returns a summary of what changed.
export function applyShared(course, shared, { fields: only = FIELDS } = {}) {
  const out = { greens: 0, tees: 0, edges: 0, pars: 0, sis: 0, holesAdded: 0, moved: [] };
  const count = Math.min(shared.holeCount ?? 0, MAX_HOLES);
  while (course.holes.length < count) {
    const n = course.holes.length + 1;
    course.holes.push({ n, par: 4, si: null, green: null, front: null, back: null, tee: null });
    out.holesAdded++;
  }
  for (const sh of shared.holes ?? []) {
    const h = course.holes[sh.n - 1];
    if (!h) continue;
    for (const [f, edit] of Object.entries(sh.fields ?? {})) {
      if (!only.includes(f)) continue;
      const localTs = h.edits?.[f] ?? 0;
      const local = h[f] ?? null;
      // A value from the map (OSM) or a rough guess has no edit time, so any
      // shared edit beats it, except a rough green over a proper one.
      const cur = localTs ? { v: local, ts: localTs } : (local != null && f === 'green' && !local.estimated ? { v: local, ts: -1 } : null);
      if (pickEdit(f, cur, edit) !== edit) continue;
      if (sameValue(local, edit.v)) { (h.edits ??= {})[f] = edit.ts; continue; }
      if (POINT_FIELDS.includes(f)) {
        const before = h[f];
        h[f] = edit.v ? { ...edit.v, ...(f === 'green' ? { estimated: !!edit.v.estimated, shared: true } : {}) } : null;
        if (f === 'green') {
          out.greens++;
          // The outline and slopes belonged to the old spot; fetch them again.
          if (h.shape && (!edit.v || !before || metres(before, edit.v) > 12)) { delete h.shape; out.moved.push(h.n); }
        } else if (f === 'tee') out.tees++;
        else out.edges++;
      } else if (f === 'par') { h.par = edit.v ?? h.par; delete h.parEstimated; out.pars++; }
      else if (f === 'si') { h.si = edit.v; out.sis++; }
      (h.edits ??= {})[f] = edit.ts;
    }
  }
  return out;
}

// Note an edit made on this phone.
export function markEdited(hole, ...fields) {
  const ts = Date.now();
  hole.edits ??= {};
  for (const f of fields) hole.edits[f] = ts;
}

// Short words for a summary like "3 greens, 2 tees".
export function describeChanges(s) {
  const parts = [];
  const add = (n, one, many) => { if (n) parts.push(`${n} ${n === 1 ? one : many}`); };
  add(s.greens, 'green', 'greens'); add(s.tees, 'tee', 'tees'); add(s.edges, 'green edge', 'green edges');
  add(s.pars, 'par', 'pars'); add(s.sis, 'stroke index', 'stroke indexes'); add(s.holesAdded, 'new hole', 'new holes');
  return parts.join(', ');
}
