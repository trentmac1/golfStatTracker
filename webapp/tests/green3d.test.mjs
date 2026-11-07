// 3D green mesh from the height grid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fromLocal, toLocal } from '../js/geo.js';
import { buildGreenMesh } from '../js/green3d.js';

const O = { lat: -27.44, lon: 152.96 };
const at = (x, y) => fromLocal(O, { x, y });
// 40 x 40 m grid, 1 m cells, rising 2% to the north, with a 0.5 m deep bunker east.
function makeHole() {
  const W = 40, H = 40, x0 = -20, y0 = -20;
  const z = [];
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const x = x0 + c + 0.5, y = y0 + H - r - 0.5;
    const inBunker = Math.hypot(x - 15, y) < 3;
    z.push(Math.round((50 + 0.02 * y - (inBunker ? 0.5 : 0)) * 100) / 100);
  }
  const circle = (cx, cy, rad, n = 24) => Array.from({ length: n }, (_, i) => { const p = at(cx + rad * Math.cos((2 * Math.PI * i) / n), cy + rad * Math.sin((2 * Math.PI * i) / n)); return [p.lat, p.lon]; });
  return { n: 1, par: 4, shape: { polygon: circle(0, 0, 12), bunkers: [circle(15, 0, 3, 12)], grid: { origin: O, x0, y0, dx: 1, dy: 1, W, H, z } } };
}

test('mesh covers green, fringe and bunker, with the slope running away from the player', () => {
  const h = makeHole();
  // Player south of the green, looking north (uphill): back of the green is higher.
  const m = buildGreenMesh(h, { from: at(0, -150), exaggeration: 4 });
  assert.ok(m.indices.length > 0 && m.indices.length % 3 === 0);
  assert.equal(m.positions.length, m.normals.length);
  assert.equal(m.positions.length, m.colours.length);
  // 24 m green: relief 0.48 m
  assert.ok(Math.abs(m.relief - 0.46) < 0.05, `relief ${m.relief}`);
  // Points further from the player (more negative z) are higher.
  let far = -Infinity, near = Infinity;
  for (let i = 0; i < m.positions.length; i += 3) {
    const [x, y, z] = [m.positions[i], m.positions[i + 1], m.positions[i + 2]];
    if (Math.abs(x) < 1 && z < -10) far = Math.max(far, y);
    if (Math.abs(x) < 1 && z > 10) near = Math.min(near, y);
  }
  assert.ok(far - near > 1.5, `far ${far} near ${near}`); // ~0.44 m x4
  // Normals face up and are unit length.
  for (let i = 0; i < m.normals.length; i += 3) {
    assert.ok(m.normals[i + 1] > 0);
    assert.ok(Math.abs(Math.hypot(m.normals[i], m.normals[i + 1], m.normals[i + 2]) - 1) < 1e-4);
    // the green itself (away from the bunker lip) is close to flat
    if (m.positions[i] < 8) assert.ok(m.normals[i + 1] > 0.9);
  }
  // Sand-coloured vertices for the bunker, all to the player's right (+x).
  const sand = [];
  for (let i = 0; i < m.kinds.length; i++) if (m.kinds[i] === 3) sand.push(m.positions[i * 3]);
  assert.ok(sand.length > 8 && sand.every((x) => x > 10), `sand ${sand.length}`);
  // Contours every 10 cm across a 0.46 m green, and a closed edge.
  assert.ok(m.contours.length / 6 > 20);
  assert.ok(m.edge.length / 6 > 20);
  assert.equal(m.contourStep, 0.1);
});

test('turning the view and stretching heights', () => {
  const h = makeHole();
  // From the east, the bunker is in front of the player (+z).
  const m = buildGreenMesh(h, { from: at(150, 0) });
  const sandZ = [];
  for (let i = 0; i < m.kinds.length; i++) if (m.kinds[i] === 3) sandZ.push(m.positions[i * 3 + 2]);
  assert.ok(sandZ.length > 8);
  assert.ok(sandZ.every((z) => z > 10));
  const m8 = buildGreenMesh(h, { from: at(0, -150), exaggeration: 8 });
  const m2 = buildGreenMesh(h, { from: at(0, -150), exaggeration: 2 });
  assert.ok(Math.abs(m8.height / m2.height - 4) < 1e-6);
  assert.equal(m8.exaggeration, 8);
  // A steep green (2 m of fall over 24 m) is held back so it isn't a ramp.
  const steep = makeHole();
  steep.shape.grid.z = steep.shape.grid.z.map((z, i) => z + 0.07 * (39 - Math.floor(i / 40)));
  const ms = buildGreenMesh(steep, { from: at(0, -150), exaggeration: 8 });
  assert.ok(ms.exaggeration < 8 && ms.exaggeration >= 1 && ms.requested === 8, `${ms.exaggeration}`);
  assert.ok(ms.height <= 0.34 * 24 + 1e-6);
  // A ball on the green sits on the surface.
  const b = buildGreenMesh(h, { from: at(0, -150), ball: at(0, 5) });
  assert.ok(b.ball && Math.abs(b.ball[1] - ((0.02 * 5 + 0.02 * 12) * 4 + 0.03)) < 0.12, `ball ${b.ball}`);
  // No grid, no mesh.
  assert.equal(buildGreenMesh({ shape: { polygon: h.shape.polygon } }), null);
});

test('height colours run blue, green, yellow, orange, red', async () => {
  const { heatColour } = await import('../js/green3d.js');
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 0.02);
  assert.ok(near(heatColour(0), [0.16, 0.42, 0.98]));   // blue, lowest
  assert.ok(near(heatColour(0.5), [0.18, 0.80, 0.30])); // green, middle
  assert.ok(near(heatColour(0.67), [1, 0.9, 0.15]));    // yellow
  assert.ok(near(heatColour(0.83), [1, 0.55, 0.1]));    // orange
  assert.ok(near(heatColour(1), [0.93, 0.14, 0.12]));   // red, highest
  assert.ok(near(heatColour(-1), heatColour(0)) && near(heatColour(2), heatColour(1)));
  // fades smoothly: halfway between two colours is their blend, no jumps
  assert.ok(near(heatColour(0.25), [0.17, 0.61, 0.64]));
  const ts = Array.from({ length: 101 }, (_, i) => i / 100).map(heatColour);
  for (let i = 1; i < ts.length; i++) assert.ok(Math.max(...ts[i].map((v, j) => Math.abs(v - ts[i - 1][j]))) < 0.06);
});

test('the coloured grid lies on the green, red at the top and blue at the bottom', () => {
  const h = makeHole();
  const m = buildGreenMesh(h, { from: at(0, -150) }); // uphill away from the player
  const { positions: P, colours: C, indices: I } = m.heat;
  assert.ok(I.length > 300 && I.length % 6 === 0);
  // every strip point is on the green (within its 12 m radius, plus the strip width)
  for (let i = 0; i < P.length; i += 3) assert.ok(Math.hypot(P[i], P[i + 2]) < 12.2);
  // far (back, higher) points are red-ish, near (front, lower) are blue-ish
  let back = null, front = null;
  for (let i = 0; i < P.length; i += 3) {
    if (!back || P[i + 2] < back.z) back = { z: P[i + 2], c: [C[i], C[i + 1], C[i + 2]] };
    if (!front || P[i + 2] > front.z) front = { z: P[i + 2], c: [C[i], C[i + 1], C[i + 2]] };
  }
  assert.ok(back.c[0] > 0.8 && back.c[2] < 0.3, `back ${back.c}`);
  assert.ok(front.c[2] > 0.8 && front.c[0] < 0.3, `front ${front.c}`);
  // strips sit just above the surface at their spot
  const off = buildGreenMesh(h, { from: at(0, -150), heatGrid: false });
  assert.equal(off.heat.indices.length, 0);
});
