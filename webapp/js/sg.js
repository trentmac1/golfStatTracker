// Strokes gained against the PGA Tour baseline (Mark Broadie, "Every Shot
// Counts", 2004-2012 ShotLink data). Expected strokes to hole out from a
// distance and lie; strokes gained for a shot = E(start) - E(end) - 1 - penalties.
//
// Limits of this app's data, handled as follows:
// - Distances are to the green centre: the pin position isn't recorded.
// - Lies are often not tagged. Tee shots are "tee"; the shot after a par-4/5
//   tee shot uses the fairway result (Left/Right = rough); a hole's bunker count
//   goes to its last shots from inside 45 m; anything else unknown uses the
//   average of fairway and rough.
// - First putt length is the optional "1st putt" entry; without it, it's
//   estimated from where the ball sat on the green (On green) to the centre.
import { distance } from './geo.js';

const M_TO_YD = 1.0936133;
const M_TO_FT = 3.2808399;

// [yards, expected strokes]. Values under 20 yd are interpolated estimates.
const T = {
  tee: [[100, 2.92], [120, 2.99], [140, 2.97], [160, 2.99], [180, 3.05], [200, 3.12], [220, 3.17], [240, 3.25], [260, 3.45], [280, 3.65], [300, 3.71], [320, 3.79], [340, 3.86], [360, 3.92], [380, 3.96], [400, 3.99], [420, 4.02], [440, 4.08], [460, 4.17], [480, 4.28], [500, 4.41], [520, 4.54], [540, 4.65], [560, 4.74], [580, 4.79], [600, 4.82]],
  fairway: [[0, 2.0], [5, 2.1], [10, 2.18], [20, 2.40], [40, 2.60], [60, 2.70], [80, 2.75], [100, 2.80], [120, 2.85], [140, 2.91], [160, 2.98], [180, 3.08], [200, 3.19], [220, 3.32], [240, 3.45], [260, 3.58], [280, 3.69], [300, 3.78], [320, 3.84], [340, 3.88], [360, 3.95], [380, 4.03], [400, 4.11], [420, 4.15], [440, 4.20], [460, 4.29], [480, 4.40], [500, 4.53], [520, 4.66], [540, 4.78], [560, 4.86], [580, 4.94], [600, 5.01]],
  rough: [[0, 2.15], [5, 2.30], [10, 2.40], [20, 2.59], [40, 2.78], [60, 2.91], [80, 2.96], [100, 3.02], [120, 3.08], [140, 3.15], [160, 3.23], [180, 3.31], [200, 3.42], [220, 3.53], [240, 3.64], [260, 3.74], [280, 3.83], [300, 3.90], [320, 3.95], [340, 4.02], [360, 4.11], [380, 4.21], [400, 4.30], [420, 4.34], [440, 4.39], [460, 4.48], [480, 4.59], [500, 4.72], [520, 4.85], [540, 4.97], [560, 5.05], [580, 5.12], [600, 5.19]],
  sand: [[0, 2.30], [5, 2.40], [10, 2.43], [20, 2.53], [40, 2.82], [60, 3.15], [80, 3.24], [100, 3.23], [120, 3.21], [140, 3.22], [160, 3.28], [180, 3.40], [200, 3.55], [220, 3.70], [240, 3.84], [260, 3.93], [280, 4.00], [300, 4.04], [320, 4.12], [340, 4.26], [360, 4.41], [380, 4.55], [400, 4.69], [540, 5.36], [600, 5.60]],
  recovery: [[0, 3.0], [50, 3.6], [100, 3.80], [120, 3.78], [140, 3.80], [160, 3.81], [180, 3.82], [200, 3.87], [220, 3.92], [240, 3.97], [260, 4.03], [280, 4.10], [300, 4.20], [320, 4.31], [340, 4.44], [360, 4.56], [380, 4.66], [400, 4.75], [540, 5.42], [600, 5.60]],
};
// [feet, expected putts]
const PUTT = [[0, 1.0], [1, 1.0], [2, 1.01], [3, 1.04], [4, 1.13], [5, 1.23], [6, 1.34], [7, 1.42], [8, 1.50], [9, 1.56], [10, 1.61], [15, 1.78], [20, 1.87], [25, 1.93], [30, 1.98], [40, 2.06], [50, 2.14], [60, 2.21], [70, 2.27], [80, 2.34], [90, 2.40], [120, 2.55]];

function interp(table, x) {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i];
    if (x <= x1) {
      const [x0, y0] = table[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return table[table.length - 1][1];
}

const LIES = { tee: 'tee', fairway: 'fairway', rough: 'rough', bunker: 'sand', sand: 'sand', other: 'recovery', recovery: 'recovery' };

// Expected strokes to hole out from `metres` away in `lie`.
export function expected(lie, metres) {
  if (lie === 'green') return interp(PUTT, metres * M_TO_FT);
  const yd = metres * M_TO_YD;
  if (lie === 'unknown') return (interp(T.fairway, yd) + interp(T.rough, yd)) / 2;
  if (lie === 'tee' && yd < 100) return interp(T.fairway, yd); // short par 3 tee plays like fairway
  return interp(T[LIES[lie] ?? 'fairway'], yd);
}

export const AROUND_GREEN_M = 45; // about 50 yards, Broadie's short-game cut-off
export const CATEGORIES = [
  ['tee', 'Off the tee'],
  ['approach', 'Approach'],
  ['around', 'Around the green'],
  ['putting', 'Putting'],
];

// Typical first putt when nothing better is known: ball on the green but no
// position or length recorded.
const DEFAULT_FIRST_PUTT_M = 7;
// Average spread of pins around the green centre, used when estimating putt
// length from ball-to-centre distance.
const PIN_SPREAD_M = 5;

function firstPuttMetres(dh, hs) {
  if (hs?.firstPutt) return hs.firstPutt;
  if (dh.greenPos && dh.green) return Math.hypot(distance(dh.greenPos, dh.green), PIN_SPREAD_M);
  return DEFAULT_FIRST_PUTT_M;
}

// Strokes gained for one derived hole (from stats.deriveHole).
// Returns null when the hole isn't usable (unfinished, no green, no shots,
// or a hand-edited score that doesn't match the shots).
export function holeSG(dh, hs = {}) {
  if (!dh?.complete || !dh.green || !dh.shots.length) return null;
  const putts = dh.putts ?? 0;
  const counted = dh.shots.length + putts + (dh.penalties ?? 0);
  if (hs.score != null && hs.score !== counted) return null;

  const n = dh.shots.length;
  const toGreen = dh.shots.map((s) => distance(s.start, dh.green));
  // Lies
  const lies = dh.shots.map((s, i) => {
    if (i === 0) return 'tee';
    if (s.lie && s.lie !== 'tee') return s.lie;
    // From the hole map: a ball on a tee box or the fringe plays like the
    // fairway, and one dropped out of water like a recovery.
    const mapped = { fairway: 'fairway', rough: 'rough', bunker: 'bunker', tee: 'fairway', green: 'fairway', water: 'recovery' }[s.startLie];
    if (mapped) return mapped;
    if (i === 1 && dh.par >= 4 && dh.fairway) return dh.fairway === 'left' || dh.fairway === 'right' ? 'rough' : 'fairway';
    return 'unknown';
  });
  let bunkerLeft = Math.max(0, (dh.bunker ?? 0) - lies.filter((l) => l === 'bunker' || l === 'sand').length);
  for (let i = n - 1; i > 0 && bunkerLeft > 0; i--) {
    if (lies[i] === 'unknown' && toGreen[i] <= AROUND_GREEN_M) { lies[i] = 'bunker'; bunkerLeft--; }
  }
  // Penalties: shots flagged with one, then any others on the tee shot
  // (on a par 3 that is also the approach).
  const pens = dh.shots.map((s) => (s.penalty ? 1 : 0));
  const extra = Math.max(0, (dh.penalties ?? 0) - pens.reduce((a, b) => a + b, 0));
  pens[0] += extra;

  const putt1 = putts > 0 ? firstPuttMetres(dh, hs) : 0;
  const shots = dh.shots.map((s, i) => {
    const eStart = expected(lies[i], toGreen[i]);
    let eEnd;
    if (i < n - 1) eEnd = expected(lies[i + 1], toGreen[i + 1]);
    else eEnd = putts > 0 ? expected('green', putt1) : 0;
    const category = i === 0 && dh.par >= 4 ? 'tee' : toGreen[i] <= AROUND_GREEN_M ? 'around' : 'approach';
    return {
      id: s.id, club: s.club, category, lie: lies[i], from: toGreen[i], mishit: !!s.mishit,
      penalty: pens[i], sg: eStart - eEnd - 1 - pens[i], miss: s.miss, approach: s.approach, onGreen: s.onGreen,
    };
  });
  const putting = putts > 0 ? expected('green', putt1) - putts : 0;
  const by = { tee: 0, approach: 0, around: 0, putting };
  for (const s of shots) by[s.category] += s.sg;
  const total = by.tee + by.approach + by.around + by.putting;
  return { hole: dh.hole, par: dh.par, shots, by, total, putt1, expectedFromTee: expected('tee', toGreen[0]) };
}

// Totals across many {derivedHole, holeStat} pairs.
export function sgSummary(pairs) {
  const by = { tee: 0, approach: 0, around: 0, putting: 0 };
  const shots = [];
  let holes = 0;
  for (const [dh, hs] of pairs) {
    const r = holeSG(dh, hs);
    if (!r) continue;
    holes += 1;
    for (const k in by) by[k] += r.by[k];
    shots.push(...r.shots.map((s) => ({ ...s, hole: r.hole })));
  }
  const total = by.tee + by.approach + by.around + by.putting;
  return { holes, by, total, shots };
}

// Clubs ranked by strokes gained per shot (worst first). `min` shots needed.
export function clubReport(shots, min = 3) {
  const by = {};
  for (const s of shots) {
    if (!s.club) continue;
    (by[s.club] ??= []).push(s);
  }
  return Object.entries(by).map(([club, list]) => {
    const sg = list.reduce((a, s) => a + s.sg, 0);
    const mishits = list.filter((s) => s.mishit).length;
    const missCount = {};
    for (const s of list) {
      if (!s.approach || s.onGreen || !s.miss) continue;
      const k = Math.abs(s.miss.long) >= Math.abs(s.miss.right) ? (s.miss.long < 0 ? 'short' : 'long') : (s.miss.right < 0 ? 'left' : 'right');
      missCount[k] = (missCount[k] ?? 0) + 1;
    }
    const topMiss = Object.entries(missCount).sort((a, b) => b[1] - a[1])[0];
    return {
      club, count: list.length, sg, perShot: sg / list.length,
      mishitPct: Math.round((100 * mishits) / list.length),
      penalties: list.reduce((a, s) => a + s.penalty, 0),
      topMiss: topMiss && topMiss[1] >= 2 ? topMiss[0] : null,
      enough: list.length >= min,
    };
  }).sort((a, b) => a.perShot - b.perShot);
}
