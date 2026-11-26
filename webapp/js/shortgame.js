// Chips and putts from the tracker (beta, app 0.9.0, firmware 0.7.0+).
//
// The tracker writes a candidate for every turn of the hips that could be a
// stroke (firmware/src/stroke.cpp). These rules pick the strokes and the
// course says what they were. Tuned on the 26 Nov practice recording (26
// putts, 12 chips, indoors): 34 of 38 found, 2 false in 13 minutes, all 34
// typed right (analysis/shortgame/strokes.py). Indoors only, so expect less
// on a course: the round tells the player it's a beta and every value can be
// corrected.
import { distance, toLocal } from './geo.js';
import { pointInPolygon } from './greens.js';
import { greenRadius, holeFor as roundHole } from './stats.js';

export const STROKE = {
  peak: 18, area: 10, pre: 8, durLo: 250, durHi: 1200, // a stroke: turn size, stillness before, length
  peakMax: 150,                                        // bigger is a full swing
  gapMs: 3000,                                         // one stroke per 3 s (the biggest)
  chipSound: 11, chipPeak: 50,                         // a chip by its strike (or, with no sound, its size)
  nearGreenM: 40,                                      // chips: within 40 m of the green
  edgeM: 3,                                            // within 3 m of the edge, GPS can't tell: by its type
  practiceM: 3, practiceMs: 15000,                     // the same stroke again from the same spot: the earlier was practice
  shotM: 10, shotMs: 60000,                            // a shot already there (marked or tracker) is this stroke
  afterFullMs: 8000,                                   // nothing straight after a full swing (its follow-through)
};

export const strokeId = (logId, seq) => `stk-${(logId >>> 0).toString(16)}-${seq}`;

export function isStroke(c, R = STROKE) {
  return c.peak >= R.peak && c.area >= R.area && c.pre <= R.pre && c.durMs >= R.durLo && c.durMs <= R.durHi && c.peak <= R.peakMax;
}

// What it sounded and felt like, for when the green can't say.
export function strokeType(c, R = STROKE) {
  if (c.high > 0) return c.high >= R.chipSound ? 'chip' : 'putt';
  return c.peak >= R.chipPeak ? 'chip' : 'putt';
}

// Where p is against a hole's green: { inside, edge } (edge: metres to the
// outline either way), or null if the hole has no green. Without an outline,
// a circle of the green's radius round its centre.
export function greenPlace(courseHole, p) {
  const poly = courseHole?.shape?.polygon;
  if (poly?.length > 2) {
    const pts = poly.map(([lat, lon]) => ({ lat, lon }));
    let edge = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = toLocal(p, pts[i]), b = toLocal(p, pts[(i + 1) % pts.length]);
      const ex = b.x - a.x, ey = b.y - a.y, L2 = ex * ex + ey * ey;
      const t = L2 ? Math.max(0, Math.min(1, -(a.x * ex + a.y * ey) / L2)) : 0;
      edge = Math.min(edge, Math.hypot(a.x + t * ex, a.y + t * ey));
    }
    return { inside: pointInPolygon(p, pts), edge };
  }
  if (!courseHole?.green) return null;
  const d = distance(p, courseHole.green), r = greenRadius(courseHole);
  return { inside: d <= r, edge: Math.abs(d - r) };
}

// Chips and putts for a round. strokes: candidate records (decoded, with
// logId); shots: the round's shots (full ones count; chips found earlier are
// left out); holeAt(p, tMs): the hole in play. Returns
// { chips: [{ id, hole, lat, lon, time, hdop, c }], putts: { hole: [{ lat, lon, time }] } }.
export function planShortGame({ round, course, strokes, shots, holeAt, R = STROKE }) {
  const dismissed = new Set(round.trackerDismissed ?? []);
  const full = shots.filter((s) => s.shortGame !== 'chip' && s.time != null);
  // One per 3 s, the biggest.
  const pass = strokes.filter((c) => c.pos && c.time && isStroke(c, R)).sort((a, b) => b.peak - a.peak);
  const kept = [];
  for (const c of pass) if (!kept.some((k) => Math.abs(k.deviceMs - c.deviceMs) <= R.gapMs && k.logId === c.logId)) kept.push(c);

  const found = [];
  for (const c of kept) {
    const t = c.time * 1000;
    const hole = holeAt(c.pos, t);
    const place = greenPlace(roundHole(course, hole), c.pos);
    if (!place || (!place.inside && place.edge > R.nearGreenM)) continue;
    const kind = place.edge <= R.edgeM ? strokeType(c, R) : place.inside ? 'putt' : 'chip';
    const mine = full.filter((s) => s.hole === hole);
    const lastFull = Math.max(-Infinity, ...mine.map((s) => s.time));
    if (t < lastFull) continue;                                         // before the approach: not a stroke on this green
    if (full.some((s) => t - s.time >= 0 && t - s.time < R.afterFullMs)) continue;
    if (shots.some((s) => s.lat != null && s.shortGame !== 'chip' && distance(s, c.pos) <= R.shotM && Math.abs(s.time - t) <= R.shotMs)) continue;
    found.push({ c, t, hole, kind });
  }
  // Practice strokes: the same stroke again from the same spot.
  found.sort((a, b) => a.t - b.t);
  const out = found.filter((f, i) => !found.slice(i + 1).some((g) => g.hole === f.hole && g.kind === f.kind
    && g.t - f.t <= R.practiceMs && distance(g.c.pos, f.c.pos) <= R.practiceM));

  const chips = [], putts = {};
  for (const f of out) {
    if (f.kind === 'chip') {
      const id = strokeId(f.c.logId, f.c.seq);
      if (!dismissed.has(id)) chips.push({ id, hole: f.hole, lat: f.c.pos.lat, lon: f.c.pos.lon, time: f.t, hdop: f.c.hdop, c: f.c });
    } else (putts[f.hole] ??= []).push({ lat: f.c.pos.lat, lon: f.c.pos.lon, time: f.t });
  }
  return { chips, putts };
}
