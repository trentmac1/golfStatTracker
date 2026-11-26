// Playing the same nine twice: the second time round has its own hole numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveRound, playOrder, layoutLabel, holeFor, holeLabel, baseHoleN, REPEAT } from '../js/stats.js';

const course = { holes: Array.from({ length: 18 }, (_, i) => ({ n: i + 1, par: i === 11 ? 3 : 4, si: i + 1, green: null, tee: null })) };
const back = [10, 11, 12, 13, 14, 15, 16, 17, 18];
const round = { holeList: [...back, ...back.map((n) => n + REPEAT)], holes: {} };

test('back nine twice: 18 holes, two separate scores on each hole', () => {
  assert.equal(playOrder(course, round).length, 18);
  assert.equal(layoutLabel(course, round), '18 holes: 10–18 twice');
  // first time round: 5 on hole 12 (par 3); second time: 3
  round.holes[12] = { score: 5, putts: 2 };
  round.holes[112] = { score: 3, putts: 1 };
  const shots = [
    { id: 'a', hole: 12, seq: 1, lat: -27.44, lon: 152.96 },
    { id: 'b', hole: 112, seq: 2, lat: -27.44, lon: 152.96 },
    { id: 'c', hole: 112, seq: 3, lat: -27.4401, lon: 152.9601 },
  ];
  const r = deriveRound(course, round, shots);
  const h12 = r.holes.find((h) => h.hole === 12), h112 = r.holes.find((h) => h.hole === 112);
  assert.equal(h12.score, 5);
  assert.equal(h112.score, 3);
  assert.equal(h12.par, 3);
  assert.equal(h112.par, 3);            // uses hole 12's par
  assert.equal(h12.shots.length, 1);
  assert.equal(h112.shots.length, 2);   // shots stay with the right pass
  assert.equal(r.holesPlayed, 2);
  assert.equal(r.score, 8);
});

test('a repeat hole shows and edits as its course hole', () => {
  assert.equal(holeLabel(112), '12');
  assert.equal(holeLabel(12), '12');
  assert.equal(baseHoleN(118), 18);
  const h = holeFor(course, 112);
  assert.equal(h.n, 112);
  assert.equal(h.repeatOf, 12);
  assert.equal(h.par, 3);
  assert.equal(holeFor(course, 112), h); // same stand-in each time
  // placing the green on the second pass sets it on the course's hole 12
  h.green = { lat: -27.5, lon: 153 };
  assert.deepEqual(course.holes[11].green, { lat: -27.5, lon: 153 });
  assert.equal(holeFor(course, 12), course.holes[11]);
  assert.equal(holeFor(course, 40), undefined);
});

test('a 9-hole course played twice, and ordinary rounds are unchanged', () => {
  const nine = { holes: course.holes.slice(0, 9) };
  const twice = { holeList: [1, 2, 3, 4, 5, 6, 7, 8, 9, 101, 102, 103, 104, 105, 106, 107, 108, 109], holes: {} };
  assert.equal(playOrder(nine, twice).length, 18);
  assert.equal(layoutLabel(nine, twice), '18 holes: 1–9 twice');
  assert.equal(layoutLabel(course, { holeList: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18] }), '18 holes');
  assert.equal(layoutLabel(course, { holeList: back }), 'Back 9 (10–18)');
});
