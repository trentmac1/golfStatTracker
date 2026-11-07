import test from 'node:test';
import assert from 'node:assert/strict';
import { METRICS, seriesFor, slope, trendNote } from '../js/trends.js';

const R = (o) => ({ round: { date: '2026-10-01', holes: {} }, course: { name: 'C', holes: [] }, r: { holes: [], holesPlayed: 18, ...o } });

test('per-round values: per 18 and percentages, null when nothing to count', () => {
  const nine = R({ holesPlayed: 9, toPar: 6, putts: 16, puttHoles: 9, fairwaysHit: 3, fairwayChances: 6, penalties: 1 });
  assert.equal(METRICS.toPar.value(nine), 12);
  assert.equal(METRICS.putts.value(nine), 32);
  assert.equal(METRICS.fairways.value(nine), 50);
  assert.equal(METRICS.penalties.value(nine), 2);
  assert.equal(METRICS.sand.value(R({ sandSaves: 0, sandChances: 0 })), null);
  assert.equal(METRICS.putts.value(R({ putts: 0, puttHoles: 0 })), null);
});

test('series skip rounds without the stat; par averages give three series', () => {
  const items = [R({ proximity: 12 }), R({ proximity: null }), R({ proximity: 9 })];
  const [s] = seriesFor(METRICS.proximity, items);
  assert.deepEqual(s.points, [{ i: 0, v: 12 }, { i: 2, v: 9 }]);
  const h = (par, score) => ({ complete: true, par, score });
  const par = seriesFor(METRICS.parAvg, [R({ holes: [h(3, 4), h(4, 5), h(4, 4)] })]);
  assert.deepEqual(par.map((x) => x.name), ['Par 3', 'Par 4', 'Par 5']);
  assert.equal(par[1].points[0].v, 4.5);
  assert.equal(par[2].points.length, 0);
});

test('trend note respects which direction is better', () => {
  const pts = (vs) => vs.map((v, i) => ({ i, v }));
  assert.match(trendNote(METRICS.putts, pts([36, 35, 32, 31])), /^Improving/);
  assert.match(trendNote(METRICS.fairways, pts([60, 55, 40, 35])), /^Slipping/);
  assert.match(trendNote(METRICS.putts, pts([32, 32, 32])), /^Steady/);
  assert.match(trendNote(METRICS.putts, pts([32, 30])), /Needs 3/);
  assert.equal(slope(pts([1, 2, 3])), 1);
});
