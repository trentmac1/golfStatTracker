import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeShared, applyShared, localEdits, markEdited, cleanValue, describeChanges } from '../js/coursemerge.js';

const centre = { lat: -27.44, lon: 152.98 };
const P = (dlat, dlon = 0, extra = {}) => ({ lat: centre.lat + dlat, lon: centre.lon + dlon, ...extra });
const blank = () => ({ key: 'x', name: 'X', centre, holeCount: 18, holes: [] });

test('server merge: newest edit wins, rough greens never beat placed ones', () => {
  let { course, changed } = mergeShared(blank(), { holes: [{ n: 3, fields: { green: { v: P(0.001), ts: 100 }, tee: { v: P(0.002), ts: 100 } } }] }, { now: 1000 });
  assert.equal(changed, 2);
  ({ course, changed } = mergeShared(course, { holes: [{ n: 3, fields: { green: { v: P(0.0011), ts: 90 } } }] }, { now: 1000 }));
  assert.equal(changed, 0, 'older edit ignored');
  ({ course, changed } = mergeShared(course, { holes: [{ n: 3, fields: { green: { v: P(0.0012, 0, { estimated: true }), ts: 200 } } }] }, { now: 1000 }));
  assert.equal(changed, 0, 'rough green ignored');
  ({ course, changed } = mergeShared(course, { holes: [{ n: 3, fields: { green: { v: P(0.0013), ts: 5000 } } }] }, { now: 1000 }));
  assert.equal(changed, 1);
  assert.equal(course.holes[0].fields.green.ts, 1000, 'future time capped');
  ({ course, changed } = mergeShared(course, { holes: [{ n: 3, fields: { tee: { v: null, ts: 1001 } } }] }, { now: 2000 }));
  assert.equal(course.holes[0].fields.tee.v, null, 'cleared on purpose');
});

test('server merge rejects junk', () => {
  const { changed, course } = mergeShared(blank(), { holes: [
    { n: 1, fields: { green: { v: { lat: 0, lon: 0 }, ts: 1 } } },          // far from the course
    { n: 2, fields: { par: { v: 9, ts: 1 }, si: { v: 40, ts: 1 }, bogus: { v: 1, ts: 1 } } },
    { n: 99, fields: { par: { v: 4, ts: 1 } } },
    { n: 4, fields: { par: { v: 5, ts: 1 }, si: { v: 18, ts: 1 } } },
  ] });
  assert.equal(changed, 2);
  assert.deepEqual(course.holes.map((h) => h.n), [4]);
  assert.equal(cleanValue('green', { lat: 'x', lon: 1 }, centre), undefined);
});

test('phone: edits go up, others come down, own newer edits stay', () => {
  const mine = { name: 'X', centre, holes: Array.from({ length: 18 }, (_, i) => ({ n: i + 1, par: 4, si: null, green: null, front: null, back: null, tee: null })) };
  mine.holes[0].green = P(0.001, 0, { estimated: false }); markEdited(mine.holes[0], 'green');
  mine.holes[1].green = P(0.003, 0, { estimated: false, fromMap: true });
  mine.holes[1].shape = { polygon: [] };
  mine.holes[2].par = 3; mine.holes[2].parEstimated = true;
  const up = localEdits(mine);
  assert.equal(up.length, 1); assert.equal(up[0].n, 1); assert.ok(up[0].fields.green.ts > 0);
  const shared = { holeCount: 27, holes: [
    { n: 1, fields: { green: { v: P(0.005), ts: 1 } } },                         // older than mine
    { n: 2, fields: { green: { v: P(0.0034), ts: 50 }, tee: { v: P(0.006), ts: 50 } } },  // beats the map's
    { n: 3, fields: { par: { v: 4, ts: 50 } } },
    { n: 20, fields: { green: { v: P(0.008), ts: 60 } } },
  ] };
  const s = applyShared(mine, shared);
  assert.equal(mine.holes.length, 27);
  assert.equal(mine.holes[0].green.lat, centre.lat + 0.001, 'my newer green kept');
  assert.ok(Math.abs(mine.holes[1].green.lat - (centre.lat + 0.0034)) < 1e-9);
  assert.equal(mine.holes[1].shape, undefined, 'moved green drops its old outline');
  assert.equal(mine.holes[2].par, 4); assert.equal(mine.holes[2].parEstimated, undefined);
  assert.equal(s.greens, 2); assert.equal(s.tees, 1); assert.equal(s.pars, 1); assert.equal(s.holesAdded, 9);
  assert.deepEqual(s.moved, [2]);
  assert.equal(describeChanges(s), '2 greens, 1 tee, 1 par and 9 new holes');
  // Applying again changes nothing.
  assert.equal(describeChanges(applyShared(mine, shared)), '');
});

test('a rough shared green does not replace a mapped one', () => {
  const mine = { holes: [{ n: 1, par: 4, green: P(0.001, 0, { estimated: false, fromMap: true }) }] };
  const s = applyShared(mine, { holeCount: 1, holes: [{ n: 1, fields: { green: { v: P(0.002, 0, { estimated: true }), ts: 5 } } }] });
  assert.equal(s.greens, 0);
  const empty = { holes: [{ n: 1, par: 4, green: null }] };
  assert.equal(applyShared(empty, { holeCount: 1, holes: [{ n: 1, fields: { green: { v: P(0.002, 0, { estimated: true }), ts: 5 } } }] }).greens, 1);
  assert.equal(empty.holes[0].green.estimated, true);
});

import { snapshotEdits, sharedCounts } from '../js/coursemerge.js';

test('full upload sends every green and tee, unedited ones as a baseline', () => {
  const course = { holes: Array.from({ length: 18 }, (_, i) => ({ n: i + 1, par: 4, si: null, green: P(0.001 * i, 0, i === 2 ? { estimated: true, fromHoleLine: true } : { estimated: false }), front: null, back: null, tee: i < 10 ? P(0.001 * i, 0.002) : null })) };
  markEdited(course.holes[0], 'green', 'par');
  course.holes[17].green = null; markEdited(course.holes[17], 'green');   // cleared here
  const up = snapshotEdits(course);
  assert.equal(up.length, 18);
  assert.ok(up[0].fields.green.ts > 1e12 && up[0].fields.par.v === 4);
  assert.equal(up[1].fields.green.ts, 1); assert.deepEqual(up[1].fields.par, { v: 4, ts: 1 }, 'pars go up as a baseline');
  assert.equal(up[2].fields.green.v.estimated, true);
  assert.equal(up[17].fields.green.v, null);
  // On the server: a baseline fills gaps but doesn't beat a real edit.
  const stored = { key: 'x', name: 'X', centre, holeCount: 18, holes: [{ n: 2, fields: { green: { v: P(0.05), ts: 500 } } }] };
  const { course: srv } = mergeShared(stored, { holeCount: 18, holes: up }, { now: Date.now() });
  assert.ok(Math.abs(srv.holes.find((h) => h.n === 2).fields.green.v.lat - (centre.lat + 0.05)) < 1e-9);
  assert.deepEqual(sharedCounts(srv), { holes: 18, greens: 17, tees: 10, pars: 18, rating: null, slope: null });
});

test('pulling only positions leaves pars alone', () => {
  const mine = { holes: [{ n: 1, par: 4, green: null, tee: null }] };
  applyShared(mine, { holeCount: 1, holes: [{ n: 1, fields: { par: { v: 3, ts: 9 }, green: { v: P(0.001), ts: 9 }, tee: { v: P(0.002), ts: 9 } } }] }, { fields: ['green', 'front', 'back', 'tee'] });
  assert.equal(mine.holes[0].par, 4); assert.ok(mine.holes[0].green && mine.holes[0].tee);
});

import { snapshotCard } from '../js/coursemerge.js';
import { applyScorecard } from '../js/scorecards.js';

test('pars, hole count and card details are shared; GolfCourseAPI values are not', () => {
  const course = { name: 'X', tee: 'White', rating: 68.8, slope: 125, holes: Array.from({ length: 18 }, (_, i) => ({ n: i + 1, par: i % 3 ? 4 : 3, si: i + 1, green: null, tee: null })) };
  let up = snapshotEdits(course), card = snapshotCard(course);
  assert.equal(up.length, 18); assert.equal(up[0].fields.par.v, 3); assert.equal(up[0].fields.par.ts, 1);
  assert.deepEqual(Object.keys(card).sort(), ['holes', 'rating', 'slope', 'tee']);
  assert.equal(card.holes.v, 18);
  // A GolfCourseAPI card replaces pars, rating, slope and tee: none of those go up now.
  applyScorecard(course, { id: 1, name: 'X' }, { name: 'Blue', rating: 70.1, slope: 130, holes: Array(18).fill({ par: 5, metres: 300 }) });
  up = snapshotEdits(course); card = snapshotCard(course);
  assert.ok(up.every((h) => !h.fields.par && h.fields.si), 'API pars stay home; typed stroke indexes still go');
  assert.deepEqual(Object.keys(card), ['holes']);
  // Typed in by the player afterwards: shared again.
  course.rating = 70.1; markEdited(course, 'rating');
  course.holes[4].par = 4; markEdited(course.holes[4], 'par');
  up = snapshotEdits(course); card = snapshotCard(course);
  assert.deepEqual(up.filter((h) => h.fields.par).map((h) => h.n), [5]); assert.ok(card.rating.ts > 1);
});

test('server keeps the card; phones take it, newest edit wins', () => {
  let { course: srv, changed } = mergeShared(blank(), { holes: [], card: { tee: { v: 'White', ts: 1 }, rating: { v: 68.8, ts: 1 }, slope: { v: 125, ts: 1 }, holes: { v: 27, ts: 1 } } });
  assert.equal(changed, 4); assert.equal(srv.holeCount, 27);
  ({ course: srv, changed } = mergeShared(srv, { holes: [], card: { rating: { v: 99, ts: 5 }, slope: { v: 126, ts: 5 } } }));
  assert.equal(changed, 1, 'bad rating refused'); assert.equal(srv.card.slope.v, 126);
  const mine = { tee: '', rating: null, slope: null, edits: { slope: 10 }, holes: [{ n: 1, par: 4 }] };
  const s = applyShared(mine, srv);
  assert.equal(mine.holes.length, 27); assert.equal(mine.rating, 68.8); assert.equal(mine.tee, 'White');
  assert.equal(mine.slope, null, 'my newer slope edit stays');
  assert.deepEqual(s.card, ['tees', 'rating']);
  assert.equal(describeChanges(s), '26 new holes, tees and rating');
});
