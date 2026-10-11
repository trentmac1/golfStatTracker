// Handicap estimate following the World Handicap System (used by Golf
// Australia). It's an estimate: no playing-conditions adjustment, and it uses
// whatever rounds are on this phone.
//
//   Score differential = (113 / slope) × (adjusted gross score − course rating)
//   Adjusted gross caps each hole at net double bogey: par + 2 + strokes received.
//   Handicap index = average of the lowest differentials, per the WHS table.

// rounds on file -> [how many lowest differentials, adjustment]
const TABLE = [
  [3, 1, -2.0], [4, 1, -1.0], [5, 1, 0], [6, 2, -1.0], [7, 2, 0], [8, 2, 0],
  [9, 3, 0], [10, 3, 0], [11, 3, 0], [12, 4, 0], [13, 4, 0], [14, 4, 0],
  [15, 5, 0], [16, 5, 0], [17, 6, 0], [18, 6, 0], [19, 7, 0], [20, 8, 0],
];
export const MAX_INDEX = 54;
const NO_INDEX_CAP = 5; // with no index yet, holes are capped at par + 5

const round1 = (x) => Math.round(x * 10) / 10;

// Strokes a player receives on a hole with stroke index `si` (1 = hardest).
export function strokesOnHole(courseHcp, si, holes = 18) {
  if (!si) return courseHcp / holes; // no stroke index: spread evenly
  if (courseHcp < 0) return si > holes + courseHcp ? -1 : 0; // plus handicap gives strokes back
  return Math.floor(courseHcp / holes) + (si <= courseHcp % holes ? 1 : 0);
}

export function courseHandicap(index, slope, rating, par) {
  return Math.round(index * (slope / 113) + (rating - par));
}

// One round's differential. `scores`: [{par, si, score|null}] for all holes.
// Rounds with 14-17 holes finished count, with unplayed holes at net par.
// Returns null if the round can't be used.
export function differential({ rating, slope, holes: scores }, index = null) {
  if (!rating || !slope) return null;
  const played = scores.filter((h) => h.score != null);
  if (played.length < 14) return null;
  const par = scores.reduce((a, h) => a + h.par, 0);
  const ch = index == null ? null : courseHandicap(index, slope, rating, par);
  let ags = 0;
  for (const h of scores) {
    const strokes = ch == null ? null : strokesOnHole(ch, h.si, scores.length);
    if (h.score == null) { ags += h.par + (strokes ?? 0); continue; } // net par
    const cap = strokes == null ? h.par + NO_INDEX_CAP : h.par + 2 + Math.round(strokes);
    ags += Math.min(h.score, cap);
  }
  return { ags, diff: round1((113 / slope) * (ags - rating)), holesPlayed: played.length };
}

// Index from differentials listed oldest to newest. Uses the most recent 20.
export function indexFrom(diffs) {
  const recent = diffs.slice(-20);
  const n = recent.length;
  if (n < 3) return null;
  const [, count, adj] = TABLE.find((r) => r[0] === n);
  const lowest = [...recent].sort((a, b) => a - b).slice(0, count);
  const avg = lowest.reduce((a, b) => a + b, 0) / count;
  return { index: Math.min(MAX_INDEX, round1(avg + adj)), used: count, of: n };
}

// Full estimate for rounds oldest-first. Two passes: first cap holes at
// par + 5 (no index yet), then re-cap at net double bogey using that index.
export function estimate(rounds) {
  const usable = rounds.filter((r) => differential(r));
  if (!usable.length) return { usable: 0, index: null, diffs: [] };
  let diffs = usable.map((r) => differential(r).diff);
  let est = indexFrom(diffs);
  if (est) {
    diffs = usable.map((r) => differential(r, est.index).diff);
    est = indexFrom(diffs);
  }
  return { usable: usable.length, index: est?.index ?? null, used: est?.used ?? 0, of: est?.of ?? 0, diffs };
}
