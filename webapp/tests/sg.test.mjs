// Strokes gained and handicap estimate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fromLocal } from '../js/geo.js';
import { deriveHole } from '../js/stats.js';
import { expected, holeSG, clubReport, sgSummary } from '../js/sg.js';
import { differential, indexFrom, estimate, strokesOnHole, courseHandicap } from '../js/handicap.js';

const O = { lat: -27.23, lon: 152.97 };
const at = (x, y) => fromLocal(O, { x, y });
const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test('baseline matches published Broadie values', () => {
  const yd = (y) => y / 1.0936133;
  near(expected('tee', yd(400)), 3.99);
  near(expected('fairway', yd(100)), 2.80);
  near(expected('rough', yd(200)), 3.42);
  near(expected('bunker', yd(100)), 3.23);
  near(expected('green', 10 / 3.2808399), 1.61);
});

test('hole strokes gained adds up to tour expectation minus score', () => {
  const ch = { n: 1, par: 4, green: at(0, 350) };
  const shots = [
    { id: 'a', seq: 1, ...at(0, 0), club: 'Dr' },
    { id: 'b', seq: 2, ...at(-25, 230), club: '7i', mishit: true },
    { id: 'c', seq: 3, ...at(-5, 330), club: 'SW' },
  ];
  const hs = { putts: 2, fairway: 'left', greenPos: at(2, 345), penalties: 0 };
  const dh = deriveHole(ch, hs, shots);
  const r = holeSG(dh, hs);
  near(r.total, r.expectedFromTee - dh.score, 1e-9);
  assert.equal(r.shots[0].category, 'tee');
  assert.equal(r.shots[1].lie, 'rough'); // fairway result Left
  assert.equal(r.shots[1].category, 'approach');
  assert.equal(r.shots[2].category, 'around');
});

test('penalty strokes land on the flagged shot; first putt length is used', () => {
  const ch = { n: 2, par: 3, green: at(0, 150) };
  const shots = [{ id: 'a', seq: 1, ...at(0, 0), club: '7i', penalty: true }, { id: 'b', seq: 2, ...at(0, 140) }];
  const hs = { putts: 1, penalties: 1, firstPutt: 1.5 };
  const dh = deriveHole(ch, hs, shots);
  const r = holeSG(dh, hs);
  assert.equal(r.shots[0].penalty, 1);
  near(r.putt1, 1.5, 1e-9);
  near(r.total, r.expectedFromTee - 4, 1e-9);
});

test('edited score that disagrees with shots is skipped', () => {
  const ch = { n: 3, par: 4, green: at(0, 300) };
  const shots = [{ id: 'a', seq: 1, ...at(0, 0) }];
  const hs = { putts: 2, score: 6 };
  assert.equal(holeSG(deriveHole(ch, hs, shots), hs), null);
});

test('club report ranks worst clubs first', () => {
  const shots = [
    { club: '7i', sg: -0.9 }, { club: '7i', sg: -0.7 }, { club: '7i', sg: -0.8 },
    { club: 'PW', sg: -0.1 }, { club: 'PW', sg: 0.1 }, { club: 'PW', sg: -0.2 },
  ];
  const r = clubReport(shots);
  assert.equal(r[0].club, '7i');
  assert.ok(r[0].enough);
});

test('WHS differential, caps and index table', () => {
  // 18 holes, par 4s with SI 1..18, score 7 everywhere (cap par+5 = 9 does nothing)
  const holes = Array.from({ length: 18 }, (_, i) => ({ par: 4, si: i + 1, score: 7 }));
  const d = differential({ rating: 70.0, slope: 113, holes });
  assert.equal(d.ags, 126);
  near(d.diff, 56.0, 1e-9);
  // index 22, slope 113, rating 70, par 72 -> course handicap 20: one stroke
  // a hole plus a second on SI 1-2, so caps are 7 (and 8 on SI 1-2)
  const capped = differential({ rating: 70.0, slope: 113, holes: holes.map((h) => ({ ...h, score: 9 })) }, 22);
  assert.equal(capped.ags, 18 * 7 + 2);
  assert.equal(strokesOnHole(20, 1), 2);
  assert.equal(strokesOnHole(20, 3), 1);
  assert.equal(courseHandicap(16.6, 129, 68.8, 70), 18);
  assert.equal(indexFrom([20, 22]), null);
  assert.deepEqual(indexFrom([20, 22, 24]), { index: 18.0, used: 1, of: 3 });
  assert.equal(indexFrom([20, 22, 24, 21, 19, 18, 25, 26, 23, 30]).index, round1((18 + 19 + 20) / 3));
  assert.equal(estimate([{ rating: null, slope: null, holes }]).usable, 0);
});
const round1 = (x) => Math.round(x * 10) / 10;
