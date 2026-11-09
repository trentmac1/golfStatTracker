// Per-round trend series for the stats page. Each metric turns one derived
// round (deriveRound output) into a value, or null when the round has nothing
// to show (no fairway chances, no putts entered…). Values are per 18 holes
// where a count would otherwise favour longer rounds.
import { sgSummary, CATEGORIES } from './sg.js';
import { median } from './geo.js';
import { countsForDistance } from './stats.js';

const pct = (a, b) => (b ? (100 * a) / b : null);
const per18 = (v, holes) => (holes ? (v / holes) * 18 : null);
const parAvg = (r, p) => {
  const hs = r.holes.filter((h) => h.complete && h.par === p);
  return hs.length ? hs.reduce((a, h) => a + h.score, 0) / hs.length : null;
};
const sgRound = (x) => sgSummary(x.r.holes.map((dh) => [dh, x.round.holes?.[dh.hole]]));

// better: which way is good ('down' = lower is better). fmt: value -> text.
// Pooled values (the tile's own number) are passed in by the view, so the
// chart's average line matches the tile exactly.
export const METRICS = {
  toPar: { label: 'Score to par', sub: 'per 18 holes', better: 'down', fmt: (v) => signedOne(v), zero: true,
    value: (x) => (x.r.holesPlayed && x.r.toPar != null ? per18(x.r.toPar, x.r.holesPlayed) : null) },
  fairways: { label: 'Fairways hit', unit: '%', better: 'up', fmt: pctFmt, min: 0, max: 100,
    value: (x) => pct(x.r.fairwaysHit, x.r.fairwayChances) },
  gir: { label: 'Greens in regulation', unit: '%', better: 'up', fmt: pctFmt, min: 0, max: 100,
    value: (x) => pct(x.r.gir, x.r.girChances) },
  putts: { label: 'Putts', sub: 'per 18 holes', better: 'down', fmt: oneFmt,
    value: (x) => per18(x.r.putts, x.r.puttHoles) },
  threePutts: { label: '3-putts', sub: 'per 18 holes', better: 'down', fmt: oneFmt, min: 0,
    value: (x) => per18(x.r.threePutts, x.r.puttHoles) },
  scrambling: { label: 'Scrambling', unit: '%', better: 'up', fmt: pctFmt, min: 0, max: 100,
    value: (x) => pct(x.r.scrambles, x.r.scrambleChances) },
  sand: { label: 'Sand saves', unit: '%', better: 'up', fmt: pctFmt, min: 0, max: 100,
    value: (x) => pct(x.r.sandSaves, x.r.sandChances) },
  penalties: { label: 'Penalties', sub: 'per 18 holes', better: 'down', fmt: oneFmt, min: 0,
    value: (x) => per18(x.r.penalties, x.r.holesPlayed) },
  parAvg: { label: 'Average on par 3 · 4 · 5', better: 'down', fmt: oneFmt,
    series: [['Par 3', (x) => parAvg(x.r, 3)], ['Par 4', (x) => parAvg(x.r, 4)], ['Par 5', (x) => parAvg(x.r, 5)]] },
  driving: { label: 'Driving distance', unit: ' m', better: 'up', fmt: mFmt,
    value: (x) => x.r.drivingDistance ?? null },
  proximity: { label: 'Approach proximity', sub: 'first putt length after an approach onto the green', unit: ' m', better: 'down', fmt: mFmt, min: 0,
    value: (x) => x.r.proximity ?? null },
  ...Object.fromEntries(CATEGORIES.map(([k, label]) => [`sg-${k}`, {
    label: `Strokes gained: ${label}`, sub: 'per 18 holes, against a tour pro', better: 'up', fmt: signedOne, zero: true,
    value: (x) => { const s = sgRound(x); return s.holes ? per18(s.by[k], s.holes) : null; },
  }])),
};

function oneFmt(v) { return v == null ? '–' : v.toFixed(1); }
function pctFmt(v) { return v == null ? '–' : `${Math.round(v)}%`; }
function mFmt(v) { return v == null ? '–' : `${Math.round(v)} m`; }
function signedOne(v) {
  if (v == null) return '–';
  const t = Math.abs(v).toFixed(1);
  return t === '0.0' ? '0.0' : v > 0 ? `+${t}` : `−${t}`;
}

// Series for a metric over rounds (oldest first): [{name, points: [{i, v}]}].
export function seriesFor(metric, items) {
  const defs = metric.series ?? [[metric.label, metric.value]];
  return defs.map(([name, f]) => ({
    name,
    points: items.map((x, i) => ({ i, v: f(x) })).filter((p) => p.v != null && Number.isFinite(p.v)),
  }));
}

// Least-squares slope per round over the points, or null with under 3 points.
export function slope(points) {
  if (points.length < 3) return null;
  const n = points.length;
  const mx = points.reduce((a, p) => a + p.i, 0) / n;
  const my = points.reduce((a, p) => a + p.v, 0) / n;
  let num = 0, den = 0;
  for (const p of points) { num += (p.i - mx) * (p.v - my); den += (p.i - mx) ** 2; }
  return den ? num / den : null;
}

// Plain-words summary comparing the later half of the rounds with the earlier.
export function trendNote(metric, points) {
  if (points.length < 3) return points.length ? 'Needs 3 or more rounds with this stat to show a trend.' : '';
  const half = Math.floor(points.length / 2);
  const avg = (ps) => ps.reduce((a, p) => a + p.v, 0) / ps.length;
  const early = avg(points.slice(0, half)), late = avg(points.slice(-half));
  const diff = late - early;
  const scale = Math.max(1e-9, ...points.map((p) => Math.abs(p.v)));
  if (Math.abs(diff) < scale * 0.03) return `Steady: your last ${half} rounds average about the same as your first ${half}.`;
  const word = !metric.better ? (diff > 0 ? metric.upWord ?? 'Up' : metric.downWord ?? 'Down')
    : (metric.better === 'up' ? diff > 0 : diff < 0) ? 'Improving' : 'Slipping';
  return `${word}: your last ${half} rounds average ${metric.fmt(late)}, against ${metric.fmt(early)} for your first ${half}.`;
}

// ---------- approach misses ----------
// Share of a round's approaches (shots aimed at the green) by where they finished.
// Short and long include the corners (short-left…), as do left and right.
export function approachSplit(r) {
  const c = r.missCounts ?? {};
  const n = (r.approachHits ?? 0) + Object.values(c).reduce((a, b) => a + b, 0);
  if (!n) return null;
  const share = (f) => (100 * Object.entries(c).filter(([k]) => f(k)).reduce((a, [, v]) => a + v, 0)) / n;
  return {
    n, green: (100 * (r.approachHits ?? 0)) / n,
    short: share((k) => k.startsWith('short')), long: share((k) => k.startsWith('long')),
    left: share((k) => k.endsWith('left')), right: share((k) => k.endsWith('right')),
  };
}
const ap = (k) => (x) => approachSplit(x.r)?.[k] ?? null;
export const APPROACH = {
  green: { label: 'Approaches on the green', unit: '%', better: 'up', fmt: pctFmt, min: 0, max: 100, value: ap('green') },
  depth: { label: 'Short or long', better: 'down', fmt: pctFmt, min: 0, max: 100, series: [['Short', ap('short')], ['Long', ap('long')]] },
  line: { label: 'Left or right', better: 'down', fmt: pctFmt, min: 0, max: 100, series: [['Left', ap('left')], ['Right', ap('right')]] },
};

// ---------- one club's distances ----------
// Every shot hit with `club` that has a real measured distance, oldest first:
// [{i, x, shot}] where i is the round's index in items.
export function clubShots(items, club) {
  return items.flatMap((x, i) => x.r.holes.flatMap((h) => h.shots
    .filter((s) => s.club === club && s.dist && s.endKind !== 'green-centre')
    .map((shot) => ({ i, x, shot }))));
}

// Median distance per round, from the shots that count; every counted shot as a dot.
export function clubMetric(club) {
  return {
    label: club, sub: 'Median distance per round. Dots are single shots.', better: null, upWord: 'Longer', downWord: 'Shorter',
    fmt: mFmt, unit: ' m',
    value: (x) => {
      const d = x.r.holes.flatMap((h) => h.shots.filter((s) => s.club === club && countsForDistance(s)).map((s) => s.dist));
      return d.length ? median(d) : null;
    },
    scatter: (items) => clubShots(items, club).filter((c) => countsForDistance(c.shot)).map((c) => ({ i: c.i, v: c.shot.dist })),
    empty: `No ${club} shots with a measured distance in these rounds.`,
  };
}
