// Green outlines, height grids and slope analysis.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fromLocal, toLocal } from '../js/geo.js';
import { readTiff, analyse, describeFall, pointInPolygon, frontBack, matchGreens, heightAt, ellipseFromPoints } from '../js/greens.js';

const O = { lat: -27.23, lon: 152.97 };
const at = (x, y) => fromLocal(O, { x, y });
const circle = (r, n = 32) => Array.from({ length: n }, (_, i) => at(r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n)));

// Uncompressed little-endian float32 TIFF with one strip, like ArcGIS sends.
function makeTiff(W, H, f) {
  const entries = [[256, 4, W], [257, 4, H], [258, 3, 32], [259, 3, 1], [273, 4, 0], [277, 3, 1], [278, 4, H], [279, 4, W * H * 4], [339, 3, 3]];
  const ifdLen = 2 + 12 * entries.length + 4;
  const buf = new ArrayBuffer(8 + ifdLen + W * H * 4);
  const dv = new DataView(buf);
  dv.setUint16(0, 0x4949); dv.setUint16(2, 42, true); dv.setUint32(4, 8, true); dv.setUint16(8, entries.length, true);
  entries.forEach(([tag, type, val], k) => {
    const o = 10 + 12 * k;
    dv.setUint16(o, tag, true); dv.setUint16(o + 2, type, true); dv.setUint32(o + 4, 1, true);
    if (tag === 273) val = 8 + ifdLen;
    if (type === 3) dv.setUint16(o + 8, val, true); else dv.setUint32(o + 8, val, true);
  });
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) dv.setFloat32(8 + ifdLen + 4 * (r * W + c), f(c, r), true);
  return buf;
}

// Grid 40 x 40 m at 1 m, falling 2% towards the south (z rises to the north).
function planeGrid(pctNorth = 2, pctEast = 0) {
  const W = 40, H = 40;
  const z = (c, r) => 30 + (pctEast / 100) * (c + 0.5 - 20) + (pctNorth / 100) * (20 - (r + 0.5)); // row 0 = north
  const t = readTiff(makeTiff(W, H, z));
  return { origin: O, x0: -20, y0: -20, dx: 1, dy: 1, W: t.W, H: t.H, z: Array.from(t.z) };
}

test('reads a float32 TIFF, row 0 north', () => {
  const g = planeGrid(2);
  near(heightAt(g, 0, 10), 30.2, 0.02);
  near(heightAt(g, 0, -10), 29.8, 0.02);
});

test('plane fit finds the fall and its direction', () => {
  const a = analyse(planeGrid(2, 0), circle(12));
  near(a.plane.pct, 2, 0.05);
  assert.ok(a.plane.downhill.y < 0 && Math.abs(a.plane.downhill.x) < 1e-3); // downhill = south
  // playing from the south (looking north): the green falls towards you
  assert.equal(describeFall(a.plane, { x: 0, y: 1 }), 'Moderate fall towards you');
  // playing from the west (looking east): it falls to the right
  assert.equal(describeFall(a.plane, { x: 1, y: 0 }), 'Moderate fall to the right');
  assert.ok(a.arrows.length > 10 && a.arrows.every((r) => Math.abs(r.pct - 2) < 0.1));
  const steep = analyse(planeGrid(3, 3), circle(12));
  assert.equal(describeFall(steep.plane, { x: 0, y: 1 }), 'Steep fall towards you and to the left');
  assert.equal(describeFall(analyse(planeGrid(0.2), circle(12)).plane, { x: 0, y: 1 }), 'Nearly flat');
});

test('polygon helpers', () => {
  const c = circle(10);
  assert.ok(pointInPolygon(at(0, 0), c));
  assert.ok(!pointInPolygon(at(12, 0), c));
  const fb = frontBack(c, at(0, -150), at(0, 0));
  near(toLocal(O, fb.front).y, -10, 0.3);
  near(toLocal(O, fb.back).y, 10, 0.3);
  const e = ellipseFromPoints({ green: at(0, 0), front: at(0, -12), back: at(0, 12) });
  assert.ok(pointInPolygon(at(0, 11), e) && !pointInPolygon(at(0, 13), e));
});

test('matches OSM greens to holes, preferring a placed green over the hole line', () => {
  const way = (golf, pts, tags = {}) => ({ type: 'way', tags: { golf, ...tags }, geometry: pts.map((p) => ({ lat: p.lat, lon: p.lon })) });
  const gA = circle(10).map((p) => toLocal(O, p)).map((p) => fromLocal(O, { x: p.x, y: p.y + 300 }));
  const gB = circle(10).map((p) => toLocal(O, p)).map((p) => fromLocal(O, { x: p.x + 100, y: p.y + 300 }));
  const osm = { elements: [way('green', gA), way('green', gB), way('hole', [at(0, 0), at(0, 150), at(0, 300)], { ref: '1' }), way('hole', [at(100, 0), at(100, 300)], { ref: '2' })] };
  const course = { holes: [{ n: 1, green: null }, { n: 2, green: { ...at(0, 302) } }] };
  const m = matchGreens(course, osm);
  // hole 2's placed green sits on green A, so it takes A; hole 1's line also ends on A, which is taken, so it gets nothing within 40 m
  assert.ok(pointInPolygon(at(0, 300), m[2].polygon));
  assert.equal(m[1], undefined);
});

function near(a, b, tol) { assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`); }

test('builds holes from the map: pars, tees and count', async () => {
  const fs = await import('node:fs');
  const { holesFromOsm } = await import('../js/greens.js');
  const osm = JSON.parse(fs.readFileSync(new URL('../data/osm/ashgrove.json', import.meta.url)));
  const holes = holesFromOsm(osm);
  assert.equal(holes.length, 18);
  assert.equal(holes.map((h) => h.par).join(''), '443543443344354434'); // Ashgrove card, par 68
  assert.ok(holes.every((h) => h.tee && h.mapped));
  assert.equal(holesFromOsm({ elements: [] }), null);
  // a nine-hole layout with one hole missing from the map
  const nine = { elements: [1, 2, 3, 4, 5, 6, 7, 9].map((n) => ({ tags: { golf: 'hole', ref: String(n), par: '3' }, geometry: [{ lat: -27, lon: 153 }, { lat: -27.001, lon: 153 }] })) };
  const h9 = holesFromOsm(nine);
  assert.equal(h9.length, 9);
  assert.equal(h9[7].mapped, false);
  assert.equal(h9[7].par, 4);
});

test('forgiving course names', async () => {
  const { nameScore } = await import('../js/greens.js');
  assert.ok(nameScore('kaperra', 'Keperra Golf Course') > 0);       // misspelt
  assert.ok(nameScore('wantima golf', 'Wantima Country Club') > 0); // "golf" not in the name
  assert.ok(nameScore('pine rivers', 'Pine Rivers Golf Club') > nameScore('pine', 'Pine Rivers Golf Club'));
  assert.equal(nameScore('north lakes', 'Rowville Lakes Public Golf Course'), 0);
  assert.equal(nameScore('kaperra', 'Carbrook Golf Club'), 0);
});

test('pars estimated from hole length when the map has none', async () => {
  const { holesFromOsm, parFromLength } = await import('../js/greens.js');
  assert.deepEqual([150, 224, 226, 350, 399, 415, 520].map(parFromLength), [3, 3, 4, 4, 4, 5, 5]);
  const m = (lat) => ({ lat, lon: 153 });
  const osm = { elements: [
    { tags: { golf: 'hole', ref: '1' }, geometry: [m(-27), m(-27 - 160 / 111195)] },            // 160 m, no par
    { tags: { golf: 'hole', ref: '2', par: '5' }, geometry: [m(-27), m(-27 - 300 / 111195)] },  // mapped par wins
    { tags: { golf: 'hole', ref: '3' }, geometry: [m(-27), m(-27 - 250 / 111195), m(-27 - 480 / 111195)] }, // 480 m with a bend
  ] };
  const h = holesFromOsm(osm);
  assert.deepEqual(h.map((x) => x.par), [3, 5, 5]);
  assert.deepEqual(h.map((x) => x.parEstimated), [true, false, true]);
});
