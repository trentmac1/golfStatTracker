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
