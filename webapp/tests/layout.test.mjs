// Which holes a round plays: 18 or 9, and which nines on 27-hole courses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { playOrder, layoutLabel, ninesOf, deriveRound } from '../js/stats.js';

const course = (n) => ({ holes: Array.from({ length: n }, (_, i) => ({ n: i + 1, par: i % 9 === 2 ? 3 : 4, green: null })) });

test('nines and labels', () => {
  assert.deepEqual(ninesOf(course(27)).map((x) => [x[0], x.at(-1)]), [[1, 9], [10, 18], [19, 27]]);
  const c27 = course(27);
  assert.deepEqual(playOrder(c27, {}), c27.holes.map((h) => h.n)); // old rounds play everything
  const r = { holeList: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27] };
  assert.deepEqual(playOrder(c27, r), r.holeList);
  assert.equal(layoutLabel(c27, r), '18 holes: 10–18, then 19–27');
  assert.equal(layoutLabel(course(18), { holeList: [10, 11, 12, 13, 14, 15, 16, 17, 18] }), 'Back 9 (10–18)');
  assert.equal(layoutLabel(course(18), {}), '18 holes');
  assert.deepEqual(playOrder(course(18), { holeList: [19, 20] }), course(18).holes.map((h) => h.n)); // invalid list ignored
});

test('round totals only count the holes played, in order', () => {
  const c = course(27);
  const round = { holeList: [19, 20, 21, 22, 23, 24, 25, 26, 27, 1, 2, 3, 4, 5, 6, 7, 8, 9], holes: { 19: { putts: 2, score: 5 }, 1: { putts: 1, score: 4 }, 12: { putts: 2, score: 9 } } };
  const r = deriveRound(c, round, []);
  assert.equal(r.holes.length, 18);
  assert.deepEqual([r.holes[0].hole, r.holes[9].hole], [19, 1]);
  assert.equal(r.holesPlayed, 2); // hole 12 isn't in this round
  assert.equal(r.score, 9);
});
