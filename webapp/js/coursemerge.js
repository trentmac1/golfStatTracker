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

// Course-wide scorecard details.
export const CARD_FIELDS = ['tee', 'rating', 'slope', 'holes'];
export function cleanCard(field, v) {
  if (field === 'tee') { const t = String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 30); return t || null; }
  if (v === null) return null;
  if (field === 'rating') return isNum(v) && v >= 50 && v <= 85 ? Math.round(v * 10) / 10 : undefined;
  if (field === 'slope') return Number.isInteger(v) && v >= 55 && v <= 155 ? v : undefined;
  if (field === 'holes') return Number.isInteger(v) && v >= 1 && v <= MAX_HOLES ? v : undefined;
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
  course.card ??= {};
  for (const [field, edit] of Object.entries(incoming.card ?? {})) {
    if (!CARD_FIELDS.includes(field) || !edit || !isNum(edit.ts)) continue;
    const v = cleanCard(field, edit.v);
    if (v === undefined) continue;
    const inc = { v, ts: Math.min(edit.ts, now) }, cur = course.card[field];
    if (pickEdit(field, cur, inc) === inc && !(cur && sameValue(cur.v, inc.v) && cur.ts === inc.ts)) { course.card[field] = inc; changed++; }
  }
  if (course.card.holes?.v) course.holeCount = course.card.holes.v;
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

// Everything this phone knows about a course, for a full upload: every
// green, edge and tee, the pars and stroke indexes, the hole count and the
// tees/rating/slope. Values nobody edited here (from the map, built in, or
// set before sharing existed) go up as a baseline (ts 1): they fill gaps on
// the server but never replace a real edit. Values that came straight from a
// GolfCourseAPI lookup stay on the phone (its terms don't allow passing them
// on) unless the player has since typed them in themselves.
export function snapshotCard(course) {
  const card = {};
  const gca = (f) => course.fromGca?.includes?.(f) && !course.edits?.[f];
  for (const f of ['tee', 'rating', 'slope']) {
    if (course[f] == null || course[f] === '' || gca(f)) continue;
    card[f] = { v: course[f], ts: course.edits?.[f] ?? 1 };
  }
  card.holes = { v: course.holes.length, ts: course.edits?.holes ?? 1 };
  return card;
}

export function snapshotEdits(course) {
  const holes = [];
  for (const h of course.holes) {
    const fields = {};
    for (const f of POINT_FIELDS) {
      if (!h[f]) continue;
      fields[f] = { v: { lat: h[f].lat, lon: h[f].lon, ...(f === 'green' && h[f].estimated ? { estimated: true } : {}) }, ts: h.edits?.[f] ?? 1 };
    }
    for (const f of ['par', 'si']) {
      if (h[f] == null) continue;
      if (h.edits?.[f]) fields[f] = { v: h[f], ts: h.edits[f] };
      else if (!h.fromGca?.includes?.(f) && !(f === 'par' && h.parEstimated)) fields[f] = { v: h[f], ts: 1 };
    }
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
  return { holes: n, greens: has('green'), tees: has('tee'), pars: has('par'), rating: shared.card?.rating?.v ?? null, slope: shared.card?.slope?.v ?? null };
}

// Put shared edits onto a course on this phone. Edits made here that are
// newer stay. Returns a summary of what changed.
export function applyShared(course, shared, { fields: only = FIELDS } = {}) {
  const out = { greens: 0, tees: 0, edges: 0, pars: 0, sis: 0, holesAdded: 0, card: [], moved: [] };
  const count = Math.min(shared.holeCount ?? 0, MAX_HOLES);
  while (course.holes.length < count) {
    const n = course.holes.length + 1;
    course.holes.push({ n, par: 4, parEstimated: true, si: null, green: null, front: null, back: null, tee: null });
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
      if (h.fromGca) h.fromGca = h.fromGca.filter((x) => x !== f);
      (h.edits ??= {})[f] = edit.ts;
    }
  }
  if (only === FIELDS) {
    for (const f of ['tee', 'rating', 'slope']) {
      const edit = shared.card?.[f];
      if (!edit) continue;
      const localTs = course.edits?.[f] ?? 0;
      if (pickEdit(f, localTs ? { v: course[f], ts: localTs } : null, edit) !== edit) continue;
      if ((course[f] ?? null) !== (edit.v ?? null)) { course[f] = edit.v ?? (f === 'tee' ? '' : null); out.card.push(f === 'tee' ? 'tees' : f); }
      if (course.fromGca) course.fromGca = course.fromGca.filter((x) => x !== f);
      (course.edits ??= {})[f] = edit.ts;
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
  parts.push(...(s.card ?? []));
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts.join('');
}
