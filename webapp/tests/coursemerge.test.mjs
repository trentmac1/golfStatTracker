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
  assert.equal(describeChanges(s), '2 greens, 1 tee, 1 par, 9 new holes');
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
