// Run with: node --test webapp/tests
import test from 'node:test';
import assert from 'node:assert/strict';
import { distance, fromLocal, miss, missLabel, median, quantile } from '../js/geo.js';
import { deriveHole, deriveRound, clubDistances } from '../js/stats.js';

const O = { lat: -27.4433, lon: 152.9615 };
const at = (x, y) => fromLocal(O, { x, y }); // x east, y north, metres

test('distance matches local projection', () => {
  assert.ok(Math.abs(distance(at(0, 0), at(300, 400)) - 500) < 0.5);
});

test('miss maths: short-right and long-left', () => {
  const S = at(0, 0), T = at(0, 150);
  const m1 = miss(S, T, at(8, 140)); // 10 short, 8 right
  assert.ok(Math.abs(m1.long + 10) < 0.3);
  assert.ok(Math.abs(m1.right - 8) < 0.3);
  assert.equal(missLabel(m1), 'Short-right 13 m');
  const m2 = miss(S, T, at(-5, 162));
  assert.equal(missLabel(m2), 'Long-left 13 m');
  // target pointing east: north of the line is left
  const m3 = miss(S, at(150, 0), at(150, 10));
  assert.ok(m3.right < 0);
  assert.equal(missLabel(miss(S, T, at(1, 151))), 'On target');
  assert.equal(missLabel(miss(S, T, at(2, 130))), 'Short 20 m');
});

test('median and quantiles', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(quantile([0, 10, 20, 30, 40], 0.25), 10);
});

const par4 = { n: 1, par: 4, green: at(0, 340), front: null, back: null };

test('par 4: drive, approach finishing short-left, chip, two putts', () => {
  const shots = [
    { id: 'a', seq: 1, lat: at(0, 0).lat, lon: at(0, 0).lon, club: 'Dr' },
    { id: 'b', seq: 2, lat: at(10, 230).lat, lon: at(10, 230).lon, club: '8i' },
    { id: 'c', seq: 3, lat: at(-6, 315).lat, lon: at(-6, 315).lon, club: 'SW' },
  ];
  const hs = { putts: 2, chips: 1, greenPos: at(1, 337), fairway: 'hit' };
  const h = deriveHole(par4, hs, shots);
  assert.equal(h.score, 5);
  assert.equal(h.toPar, 1);
  assert.equal(h.gir, false);
  assert.equal(h.scramble, false);
  assert.equal(h.fairway, 'hit');
  assert.ok(Math.abs(h.shots[0].dist - Math.hypot(10, 230)) < 0.5);
  // approach aimed at green, ended 25 m short, ~6 m left => miss reported
  const ap = h.shots[1];
  assert.equal(ap.approach, true);
  assert.equal(ap.onGreen, false);
  assert.match(ap.result, /^Short/);
  // chip ends at ball-on-green => hit
  assert.equal(h.shots[2].result, 'Green');
  assert.ok(Math.abs(h.proximity - Math.hypot(1, 3)) < 0.5);
  assert.equal(h.shots[0].result, 'Fairway');
});

test('GIR, 3-putt and score override', () => {
  const shots = [
    { id: 'a', seq: 1, ...at(0, 0) },
    { id: 'b', seq: 2, ...at(0, 200) },
  ];
  const h = deriveHole(par4, { putts: 3, greenPos: at(0, 345) }, shots);
  assert.equal(h.score, 5);
  assert.equal(h.gir, true);
  assert.equal(h.threePutt, true);
  assert.equal(h.scramble, null);
  const o = deriveHole(par4, { putts: 3, score: 6, greenPos: at(0, 345) }, shots);
  assert.equal(o.score, 6);
  assert.equal(o.gir, false);
});

test('penalties count toward score; incomplete hole has no GIR', () => {
  const shots = [{ id: 'a', seq: 1, ...at(0, 0) }];
  const h = deriveHole(par4, { penalties: 1 }, shots);
  assert.equal(h.complete, false);
  assert.equal(h.gir, null);
  const done = deriveHole(par4, { penalties: 1, putts: 1, greenPos: at(0, 340) }, shots);
  assert.equal(done.score, 3);
});

test('layup is not treated as an approach', () => {
  const par5 = { n: 2, par: 5, green: at(0, 480) };
  const shots = [
    { id: 'a', seq: 1, ...at(0, 0) },
    { id: 'b', seq: 2, ...at(0, 240) },
    { id: 'c', seq: 3, ...at(0, 380) },
  ];
  const h = deriveHole(par5, { putts: 2, greenPos: at(0, 478) }, shots);
  assert.equal(h.shots[1].approach, false);
  assert.equal(h.shots[1].result, '');
  assert.equal(h.shots[2].approach, true);
  assert.equal(h.gir, true);
});

test('tapped tee target infers fairway', () => {
  const shots = [
    { id: 'a', seq: 1, ...at(0, 0), target: at(0, 220) },
    { id: 'b', seq: 2, ...at(25, 215) },
  ];
  const h = deriveHole(par4, {}, shots);
  assert.equal(h.fairway, 'right');
  assert.equal(h.fairwayAuto, true);
});

test('round totals and club distances', () => {
  const course = { holes: [par4, { n: 2, par: 3, green: at(500, 340) }] };
  const round = {
    holes: { 1: { putts: 2, fairway: 'left', greenPos: at(0, 336) }, 2: { putts: 1, bunker: 1, greenPos: at(500, 342) } },
  };
  const shots = [
    { id: 'a', hole: 1, seq: 1, ...at(0, 0), club: 'Dr' },
    { id: 'b', hole: 1, seq: 2, ...at(-20, 240), club: '9i' },
    { id: 'c', hole: 2, seq: 3, ...at(500, 190), club: '7i' },
    { id: 'd', hole: 2, seq: 4, ...at(510, 330), club: 'SW' },
  ];
  const r = deriveRound(course, round, shots);
  assert.equal(r.holesPlayed, 2);
  assert.equal(r.score, 4 + 3);
  assert.equal(r.toPar, 0);
  assert.equal(r.fairwayChances, 1);
  assert.equal(r.fairwaysHit, 0);
  assert.equal(r.gir, 1);
  assert.equal(r.sandSaves, 1);
  assert.equal(r.sandChances, 1);
  assert.equal(r.scrambles, 1);
  const clubs = clubDistances(r.holes);
  const dr = clubs.find((c) => c.club === 'Dr');
  assert.ok(Math.abs(dr.median - Math.hypot(20, 240)) < 0.5);
});
