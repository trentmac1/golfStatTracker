// Past rounds typed in from a scorecard, and putter shots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveRound, deriveHole, clubDistances } from '../js/stats.js';
import { teeOptions, roundRating } from '../js/views/pastround.js';
import { differential } from '../js/handicap.js';

const course = { holes: Array.from({ length: 18 }, (_, i) => ({ n: i + 1, par: i % 9 === 2 ? 3 : 4, si: i + 1, green: null })), rating: 68, slope: 120, tee: 'White' };

test('a score-only round leaves greens and putting unknown', () => {
  const holes = Object.fromEntries(course.holes.map((h) => [h.n, { score: h.par + 1, putts: null }]));
  const r = deriveRound(course, { holes, holeList: course.holes.map((h) => h.n) }, []);
  assert.equal(r.holesPlayed, 18);
  assert.equal(r.score, 70 + 18);
  assert.equal(r.girChances, 0);
  assert.equal(r.girPct, null);
  assert.equal(r.puttHoles, 0);
  assert.equal(r.scrambleChances, 0);
  // with putts, GIR works as before
  const withPutts = deriveHole(course.holes[0], { score: 4, putts: 2 }, []);
  assert.equal(withPutts.gir, true);
  const missed = deriveHole(course.holes[0], { score: 5, putts: 1 }, []);
  assert.equal(missed.gir, false);
});

test('tees: the round\'s own rating and slope win, and tee lists stay unique', () => {
  const c = { ...course, teeSets: [{ name: 'Blue', rating: 70.1, slope: 128 }, { name: 'white', rating: 67.5, slope: 118 }] };
  const names = teeOptions(c).map((t) => t.name);
  assert.deepEqual(names, ['Blue', 'white']); // the course's own "White" is the same tees as "white"
  assert.deepEqual(roundRating({ tee: { name: 'Blue', rating: 70.1, slope: 128 } }, c), { rating: 70.1, slope: 128 });
  assert.deepEqual(roundRating({}, c), { rating: 68, slope: 120 });
  assert.deepEqual(teeOptions({ holes: [] }), []);
  const scores = course.holes.map((h) => ({ par: h.par, si: h.si, score: h.par + 1 }));
  assert.equal(differential({ ...roundRating({ tee: { rating: 70.1, slope: 128 } }, c), holes: scores }).diff, Math.round((113 / 128) * (88 - 70.1) * 10) / 10);
});

test('putter shots from off the green are left out of club distances', () => {
  const hole = { shots: [
    { club: '7i', dist: 150, endKind: 'shot' },
    { club: 'Putter', dist: 12, endKind: 'shot' },
  ] };
  const d = clubDistances([hole]);
  assert.deepEqual(d.map((x) => x.club), ['7i']);
});
