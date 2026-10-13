// Hole maps: smoothing, matching fairways to holes, and lies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fromLocal, toLocal } from '../js/geo.js';
import { smoothRing, smoothPathD, matchFeatures, lieAt } from '../js/holemap.js';
import { deriveHole } from '../js/stats.js';
import { holeSG } from '../js/sg.js';

const O = { lat: -27.44, lon: 152.96 };
const at = (x, y) => fromLocal(O, { x, y });
const rect = (x0, y0, x1, y1) => [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)];
const way = (golf, pts, tags = {}) => ({ type: 'way', tags: { golf, ...tags }, geometry: pts });
const ring = (pts) => pts.map((p) => [p.lat, p.lon]);

test('smoothing rounds corners without moving long edges', () => {
  const sq = rect(0, 0, 40, 40);
  const s = smoothRing(sq).map((p) => toLocal(O, p));
  // no point beyond the original square, corners pulled in, edges still near 0 and 40
  assert.ok(s.every((p) => p.x >= -0.01 && p.x <= 40.01 && p.y >= -0.01 && p.y <= 40.01));
  const corner = Math.min(...s.map((p) => Math.hypot(p.x, p.y)));
  assert.ok(corner > 1 && corner < 6, `corner cut ${corner}`);
  const mids = s.filter((p) => Math.abs(p.y - 20) < 2);
  assert.ok(mids.some((p) => p.x < 0.1) && mids.some((p) => p.x > 39.9));
  // turning angle between neighbours stays small: no pointy edges
  const ang = (a, b, c) => { const u = [b.x - a.x, b.y - a.y], v = [c.x - b.x, c.y - b.y]; return Math.abs(Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1])); };
  const maxTurn = Math.max(...s.map((p, i) => ang(s[(i - 1 + s.length) % s.length], p, s[(i + 1) % s.length])));
  assert.ok(maxTurn < 0.25, `max turn ${maxTurn}`);
  const d = smoothPathD([[0, 0], [10, 0], [10, 10], [0, 10]]);
  assert.match(d, /^M.*Q.*Z$/);
  assert.ok(!d.includes('L'));
});

// Hole 1 runs north from (0,0) to (0,300); hole 2 runs south 60 m east of it.
const course = {
  holes: [
    { n: 1, par: 4, tee: at(0, 0), green: at(0, 300), shape: { polygon: ring(rect(-12, 288, 12, 312)) } },
    { n: 2, par: 4, tee: at(60, 300), green: at(60, 0) },
  ],
};
const osm = { elements: [
  way('hole', [at(0, 0), at(0, 300)], { ref: '1' }),
  way('fairway', rect(-15, 120, 15, 280)),
  way('fairway', rect(45, 20, 75, 180)),     // hole 2's
  way('tee', rect(-5, -5, 5, 5)),
  way('bunker', rect(18, 220, 26, 232)),
  way('water_hazard', rect(-60, 150, -30, 200)),
] };

test('features are matched to the hole whose line runs through them', () => {
  const m = matchFeatures(course, osm);
  assert.equal(m[1].fairways.length, 1);
  assert.equal(m[2].fairways.length, 1);
  assert.ok(Math.abs(m[1].fairways[0][0][1] - at(-15, 0).lon) < 1e-6);
  assert.equal(m[1].tees.length, 1);
  assert.equal(m[1].bunkers.length, 1);
  assert.equal(m[1].water.length, 1);
  assert.equal(m[2].tees.length, 0);
});

test('lies and the automatic fairway result', () => {
  const m = matchFeatures(course, osm);
  const h = { ...course.holes[0], features: m[1] };
  assert.equal(lieAt(at(0, 200), h), 'fairway');
  assert.equal(lieAt(at(25, 200), h), 'rough');
  assert.equal(lieAt(at(22, 226), h), 'bunker');
  assert.equal(lieAt(at(0, 300), h), 'green');
  assert.equal(lieAt(at(-45, 170), h), 'water');
  assert.equal(lieAt(at(0, 200), course.holes[1]), null); // no map, no guess

  const shots = [{ id: 'a', seq: 1, lat: at(0, 0).lat, lon: at(0, 0).lon }, { id: 'b', seq: 2, ...at(-25, 210) }];
  const d = deriveHole(h, { putts: 2 }, shots);
  assert.equal(d.shots[0].endLie, 'rough');
  assert.equal(d.shots[1].startLie, 'rough');
  assert.equal(d.fairway, 'left');
  assert.equal(d.fairwayAuto, true);
  const sg = holeSG(d, { putts: 2 });
  assert.equal(sg.shots[1].lie, 'rough');

  const hit = deriveHole(h, { putts: 2 }, [shots[0], { id: 'b', seq: 2, ...at(3, 210) }]);
  assert.equal(hit.fairway, 'hit');
  // the player's tap still wins
  assert.equal(deriveHole(h, { putts: 2, fairway: 'right' }, shots).fairway, 'right');
});

test('a rough fairway is estimated only where none is mapped', async () => {
  const { estimateFairway, holeLine } = await import('../js/holemap.js');
  const h = { n: 1, par: 4, tee: at(0, 0), green: at(0, 340) };
  const est = estimateFairway(h).map(([lat, lon]) => toLocal(O, { lat, lon }));
  const ys = est.map((p) => p.y), xs = est.map((p) => p.x);
  assert.ok(Math.min(...ys) > 100 && Math.min(...ys) < 125, `starts ${Math.min(...ys)}`);
  assert.ok(Math.max(...ys) > 310 && Math.max(...ys) < 325, `ends ${Math.max(...ys)}`);
  assert.ok(Math.max(...xs) <= 15.01 && Math.min(...xs) >= -15.01);
  assert.equal(estimateFairway({ ...h, par: 3 }), null);
  assert.equal(estimateFairway({ ...h, features: { fairways: [ring(rect(-15, 120, 15, 280))] } }), null);
  assert.equal(estimateFairway({ n: 1, par: 4, tee: at(0, 0) }), null);
  assert.equal(holeLine(h).length, 2);
});

test('fairways follow the OSM hole line, one hole each', () => {
  // Two parallel holes 45 m apart. The map numbers them the other way round
  // from the card, and hole 2's fairway sits close beside hole 1's line.
  const c = { holes: [
    { n: 1, par: 4, green: at(0, 300) },
    { n: 2, par: 4, green: at(45, 300) },
  ] };
  const o = { elements: [
    way('hole', [at(0, 0), at(-20, 150), at(0, 300)], { ref: '2' }),   // dogleg left
    way('hole', [at(45, 0), at(45, 300)], { ref: '1' }),
    way('fairway', rect(-35, 110, -5, 260)),                               // hole 1, inside the dogleg
    way('fairway', rect(32, 110, 58, 280)),                                // hole 2
  ] };
  const m = matchFeatures(c, o);
  assert.equal(m[1].fromHoleWay, true);
  assert.ok(Math.abs(m[1].line[1][1] - at(-20, 150).lon) < 1e-6, 'hole 1 uses the line ending at its green');
  assert.equal(m[1].fairways.length, 1);
  assert.equal(m[2].fairways.length, 1);
  assert.ok(Math.abs(m[1].fairways[0][0][1] - at(-35, 0).lon) < 1e-6);
  assert.ok(Math.abs(m[2].fairways[0][0][1] - at(32, 0).lon) < 1e-6);
});

test('shots on a mapped hole are marked fairway or rough automatically', async () => {
  const { applyAutoLie, holeMapped } = await import('../js/holemap.js');
  const m = matchFeatures(course, osm);
  const h = { ...course.holes[0], features: m[1] };
  assert.equal(holeMapped(h), true);
  assert.equal(holeMapped(course.holes[1]), false);

  const fw = { ...at(0, 200), lie: null };
  assert.equal(applyAutoLie(fw, h, false), true);
  assert.deepEqual([fw.lie, fw.lieAuto], ['fairway', true]);
  // dragged into the rough: re-marked
  Object.assign(fw, at(25, 200));
  applyAutoLie(fw, h, false);
  assert.equal(fw.lie, 'rough');
  // into the bunker
  Object.assign(fw, at(22, 226));
  applyAutoLie(fw, h, false);
  assert.equal(fw.lie, 'bunker');
  // onto the green: the map's mark is cleared, nothing guessed
  Object.assign(fw, at(0, 300));
  applyAutoLie(fw, h, false);
  assert.deepEqual([fw.lie, fw.lieAuto], [null, false]);

  // the player's choice and the tee shot are never touched
  const hand = { ...at(25, 200), lie: 'fairway', lieByHand: true };
  assert.equal(applyAutoLie(hand, h, false), false);
  assert.equal(hand.lie, 'fairway');
  const tee = { ...at(0, 0), lie: 'tee' };
  assert.equal(applyAutoLie(tee, h, true), false);
  assert.equal(tee.lie, 'tee');
  // unmapped hole: left alone
  const un = { ...at(25, 200), lie: null };
  assert.equal(applyAutoLie(un, course.holes[1], false), false);
  assert.equal(un.lie, null);
});

test('a lie set by hand in an older round is kept', async () => {
  const { applyAutoLie } = await import('../js/holemap.js');
  const h = { ...course.holes[0], features: matchFeatures(course, osm)[1] };
  const old = { ...at(25, 200), lie: 'fairway' };
  assert.equal(applyAutoLie(old, h, false), false);
  assert.equal(old.lie, 'fairway');
});
