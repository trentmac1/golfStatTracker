// CSV exports. JSON backup/restore lives in db.js.
import { deriveRound } from './stats.js';

const cell = (v) => {
  if (v == null) return '';
  const s = typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const row = (arr) => arr.map(cell).join(',');

const HOLE_COLS = ['date', 'course', 'round_id', 'hole', 'par', 'score', 'to_par', 'putts', 'chips', 'bunker', 'penalties', 'fairway', 'gir', 'scramble', 'sand_save', 'proximity_m'];
const SHOT_COLS = ['date', 'course', 'round_id', 'hole', 'shot', 'club', 'lie', 'distance_m', 'result', 'long_m', 'right_m', 'penalty', 'mishit', 'source', 'lat', 'lon', 'accuracy_m', 'time'];

function roundRows(course, round, shots) {
  const r = deriveRound(course, round, shots);
  const date = round.date.slice(0, 10);
  const holes = r.holes.filter((h) => h.started).map((h) => row([
    date, course.name, round.id, h.hole, h.par, h.score, h.toPar, h.putts, h.chips, h.bunker, h.penalties,
    h.par >= 4 ? h.fairway : '', h.gir, h.scramble, h.sandSave, h.proximity,
  ]));
  const shotRows = r.holes.flatMap((h) => h.shots.map((s) => row([
    date, course.name, round.id, h.hole, s.index + 1, s.club, s.lie, s.dist, s.result, s.miss?.long, s.miss?.right,
    s.penalty, s.mishit, s.source, s.lat, s.lon, s.accuracy, new Date(s.time).toISOString(),
  ])));
  return { holes, shotRows };
}

// One file with two tables, which Numbers and Excel both open fine.
export function roundCsv(course, round, shots) {
  const { holes, shotRows } = roundRows(course, round, shots);
  return [row(HOLE_COLS), ...holes, '', row(SHOT_COLS), ...shotRows].join('\n');
}

export function allCsv(items) {
  const H = [row(HOLE_COLS)];
  const S = [row(SHOT_COLS)];
  for (const { course, round, shots } of items) {
    const { holes, shotRows } = roundRows(course, round, shots);
    H.push(...holes);
    S.push(...shotRows);
  }
  return { holes: H.join('\n'), shots: S.join('\n') };
}
