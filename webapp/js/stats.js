// Hole, round and multi-round statistics. Pure functions, no DOM or storage,
// so they can be unit tested in Node.
import { distance, miss, missLabel, missBucket, median, quantile } from './geo.js';

export const DEFAULT_GREEN_RADIUS = 12; // m, used until front/back are known
export const FAIRWAY_HALF_WIDTH = 15;   // m, for auto fairway result from a tee target
export const APPROACH_RANGE = 50;       // m, a shot ending this close to the green was aimed at it

export function greenRadius(courseHole) {
  if (courseHole?.front && courseHole?.back) {
    return Math.max(6, distance(courseHole.front, courseHole.back) / 2);
  }
  return DEFAULT_GREEN_RADIUS;
}

export function emptyHoleStat() {
  return { putts: null, chips: 0, bunker: 0, penalties: 0, fairway: null, score: null, greenPos: null };
}

export function sortShots(shots) {
  return [...shots].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || (a.time ?? 0) - (b.time ?? 0));
}

// Everything the UI and the round totals need for one hole.
export function deriveHole(courseHole, holeStat = {}, holeShots = []) {
  const hs = { ...emptyHoleStat(), ...holeStat };
  const par = courseHole?.par ?? 4;
  const green = courseHole?.green ?? null;
  const radius = greenRadius(courseHole);
  const shots = sortShots(holeShots);
  const n = shots.length;

  const out = shots.map((s, i) => {
    const start = { lat: s.lat, lon: s.lon };
    let end = null;
    let endKind = null; // 'shot' | 'ball-on-green' | 'green-centre'
    if (i < n - 1) { end = shots[i + 1]; endKind = 'shot'; }
    else if (hs.greenPos) { end = hs.greenPos; endKind = 'ball-on-green'; }
    else if (green) { end = green; endKind = 'green-centre'; }

    const dist = end ? distance(start, end) : null;
    const isTee = i === 0;
    const isLast = i === n - 1;
    const onGreen =
      endKind === 'ball-on-green' ||
      (endKind === 'green-centre' && (hs.putts ?? 0) > 0) ||
      (endKind === 'shot' && green && distance(end, green) <= radius);

    // Which point was this shot aimed at?
    let target = s.target ?? null;
    let targetKind = target ? 'tapped' : null;
    if (!target && green && !(isTee && par >= 4)) {
      const nearGreen = end && distance(end, green) <= APPROACH_RANGE;
      if (isLast || nearGreen || (isTee && par === 3)) { target = green; targetKind = 'green'; }
    }

    // Miss only when the finish point is real (not the green-centre fallback).
    let m = null;
    let result = '';
    if (target && end && endKind !== 'green-centre') {
      m = miss(start, target, end);
      if (targetKind === 'green' && onGreen) result = 'Green';
      else result = missLabel(m);
    } else if (targetKind === 'green' && onGreen) {
      result = 'Green';
    }
    if (isTee && par >= 4 && hs.fairway) {
      result = { hit: 'Fairway', left: 'Left of fairway', right: 'Right of fairway', short: 'Short of fairway' }[hs.fairway];
    }
    return {
      ...s, index: i, start, end, endKind, dist, isTee, isLast, onGreen,
      target, targetKind, miss: m, result,
      approach: targetKind === 'green',
    };
  });

  // Fairway: the user's tap wins; otherwise infer from a tapped tee target.
  let fairway = hs.fairway;
  let fairwayAuto = false;
  if (par >= 4 && !fairway && out[0]?.targetKind === 'tapped' && out[0].miss) {
    const r = out[0].miss.right;
    fairway = Math.abs(r) <= FAIRWAY_HALF_WIDTH ? 'hit' : r < 0 ? 'left' : 'right';
    fairwayAuto = true;
  }

  const putts = hs.putts;
  const strokesTaken = n + (putts ?? 0) + (hs.penalties ?? 0);
  const started = n > 0 || putts != null || hs.score != null;
  const complete = putts != null || hs.score != null;
  const score = hs.score ?? (started ? strokesTaken : null);

  let gir = null, scramble = null, sandSave = null, threePutt = null, upDownChance = false;
  if (complete && score != null) {
    gir = score - (putts ?? 0) <= par - 2;
    upDownChance = !gir;
    scramble = !gir ? score <= par : null;
    // Approximation until lies are recorded per shot: a hole with a bunker
    // shot that finished with one putt or fewer counts as a sand save.
    sandSave = hs.bunker > 0 ? (putts ?? 0) <= 1 : null;
    threePutt = (putts ?? 0) >= 3;
  }

  // Skip when the green centre was itself estimated from a ball position.
  const lastOnGreen = out.length && out[n - 1].endKind === 'ball-on-green' && green && !green.estimated ? out[n - 1] : null;
  const proximity = lastOnGreen ? distance(hs.greenPos, green) : null;

  return {
    hole: courseHole?.n, par, green, radius, shots: out, putts, score, started, complete,
    toPar: score != null ? score - par : null,
    fairway, fairwayAuto, gir, scramble, upDownChance, sandSave, threePutt,
    chips: hs.chips ?? 0, bunker: hs.bunker ?? 0, penalties: hs.penalties ?? 0,
    proximity, greenPos: hs.greenPos,
  };
}

const pct = (a, b) => (b ? Math.round((100 * a) / b) : null);

// Totals for one round. `course` has holes[], `round.holes` maps n -> holeStat.
export function deriveRound(course, round, shots) {
  const byHole = new Map();
  for (const s of shots) {
    if (!byHole.has(s.hole)) byHole.set(s.hole, []);
    byHole.get(s.hole).push(s);
  }
  const holes = course.holes.map((h) => deriveHole(h, round.holes?.[h.n], byHole.get(h.n) ?? []));
  const played = holes.filter((h) => h.complete);
  const sum = (arr, f) => arr.reduce((a, h) => a + (f(h) ?? 0), 0);

  const fwHoles = played.filter((h) => h.par >= 4 && h.fairway);
  const scrambleChances = played.filter((h) => h.scramble !== null);
  const sandChances = played.filter((h) => h.sandSave !== null);
  const byPar = {};
  for (const p of [3, 4, 5]) {
    const hp = played.filter((h) => h.par === p);
    byPar[p] = hp.length ? sum(hp, (h) => h.score) / hp.length : null;
  }
  const missCounts = {};
  for (const h of played) for (const s of h.shots) {
    if (!s.approach || s.onGreen || !s.miss) continue;
    const b = missBucket(s.miss);
    if (b) missCounts[b] = (missCounts[b] ?? 0) + 1;
  }
  const drives = played.flatMap((h) => h.shots.filter((s) => s.isTee && h.par >= 4 && s.dist && !s.penalty && !s.mishit));
  const driverOnly = drives.filter((s) => s.club === 'Dr');
  const driveSet = driverOnly.length ? driverOnly : drives;
  const prox = played.map((h) => h.proximity).filter((v) => v != null);

  return {
    holes,
    holesPlayed: played.length,
    score: sum(played, (h) => h.score),
    par: sum(played, (h) => h.par),
    toPar: sum(played, (h) => h.toPar),
    putts: sum(played, (h) => h.putts),
    puttsPerGir: (() => {
      const g = played.filter((h) => h.gir);
      return g.length ? sum(g, (h) => h.putts) / g.length : null;
    })(),
    fairwaysHit: fwHoles.filter((h) => h.fairway === 'hit').length,
    fairwayChances: fwHoles.length,
    fairwayPct: pct(fwHoles.filter((h) => h.fairway === 'hit').length, fwHoles.length),
    fairwayMisses: {
      left: fwHoles.filter((h) => h.fairway === 'left').length,
      right: fwHoles.filter((h) => h.fairway === 'right').length,
      short: fwHoles.filter((h) => h.fairway === 'short').length,
    },
    gir: played.filter((h) => h.gir).length,
    girPct: pct(played.filter((h) => h.gir).length, played.length),
    scrambles: scrambleChances.filter((h) => h.scramble).length,
    scrambleChances: scrambleChances.length,
    sandSaves: sandChances.filter((h) => h.sandSave).length,
    sandChances: sandChances.length,
    threePutts: played.filter((h) => h.threePutt).length,
    penalties: sum(played, (h) => h.penalties),
    chips: sum(played, (h) => h.chips),
    bunker: sum(played, (h) => h.bunker),
    avgByPar: byPar,
    drivingDistance: driveSet.length ? driveSet.reduce((a, s) => a + s.dist, 0) / driveSet.length : null,
    drivingUsesDriverOnly: driverOnly.length > 0,
    proximity: prox.length ? prox.reduce((a, b) => a + b, 0) / prox.length : null,
    missCounts,
    commonMiss: Object.entries(missCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
  };
}

// Club distances across many derived holes: median and IQR, mishits excluded.
export function clubDistances(derivedHoles) {
  const by = {};
  for (const h of derivedHoles) for (const s of h.shots) {
    if (!s.club || !s.dist || s.mishit || s.penalty) continue;
    // A last shot measured only to the green centre is a guess; leave it out.
    if (s.endKind === 'green-centre') continue;
    (by[s.club] ??= []).push(s.dist);
  }
  return Object.entries(by).map(([club, d]) => ({
    club, count: d.length, median: median(d), q1: quantile(d, 0.25), q3: quantile(d, 0.75), max: Math.max(...d),
  }));
}
