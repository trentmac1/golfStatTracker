// 3D green: the LiDAR height grid saved with each green, trimmed to the green,
// a strip of fringe and nearby bunkers, drawn with WebGL. Heights are
// exaggerated so gentle slopes show. Drag to turn, pinch to zoom, double-tap
// to reset.
//
// buildGreenMesh is pure (no DOM) so it can be tested in Node; mountGreen3d
// does the drawing.
import { toLocal } from './geo.js';
import { heightAt } from './greens.js';
import { smoothed } from './holemap.js';

const COLLAR_M = 4;      // ground drawn around the green, fading out to its edge
const BUNKER_NEAR_M = 9; // bunkers within this distance of the green are drawn
const BG = [0.141, 0.251, 0.169]; // the view's background colour

// Nearest point on a ring of {x, y} to p, and its distance in metres.
function nearestOnRing(p, ring) {
  let best = { d: Infinity, x: 0, y: 0 };
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const ex = b.x - a.x, ey = b.y - a.y, L2 = ex * ex + ey * ey;
    const t = L2 ? Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / L2)) : 0;
    const x = a.x + ex * t, y = a.y + ey * t, d = Math.hypot(p.x - x, p.y - y);
    if (d < best.d) best = { d, x, y };
  }
  return best;
}
const edgeDist = (p, ring) => nearestOnRing(p, ring).d;
const insideXY = (p, ring) => {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) ins = !ins;
  }
  return ins;
};

// Colour for a point on the green: one hue, lighter is higher (as in the top
// view), and a little darker on steeper ground.
function greenColour(t) {
  const l = 0.30 + 0.42 * t;
  return hsl(128 / 360, 0.42, l);
}
function hsl(h, s, l) {
  const k = (n) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)];
}
// Height colours for the grid: blue (lowest), green (middle), then yellow,
// orange and red (highest), fading smoothly between them.
export const HEAT_STOPS = [
  [0, [0.16, 0.42, 0.98]],    // blue
  [0.5, [0.18, 0.80, 0.30]],  // green
  [0.67, [1.00, 0.90, 0.15]], // yellow
  [0.83, [1.00, 0.55, 0.10]], // orange
  [1, [0.93, 0.14, 0.12]],    // red
];
export function heatColour(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < HEAT_STOPS.length; i++) {
    const [t1, c1] = HEAT_STOPS[i];
    if (t <= t1) {
      const [t0, c0] = HEAT_STOPS[i - 1];
      const k = (t - t0) / (t1 - t0);
      return c0.map((v, j) => v + (c1[j] - v) * k);
    }
  }
  return HEAT_STOPS.at(-1)[1].slice();
}
const GRID_M = 1.5;     // spacing of the coloured grid lines
const GRID_W = 0.13;    // their width, in metres on the ground
const FRINGE = [0.20, 0.42, 0.22];
const SAND = [0.89, 0.82, 0.62];

// Marching squares on the grid for one height level: segments in grid (c, r).
function levelSegments(grid, L) {
  const { W, H, z } = grid;
  const segs = [];
  const v = (r, c) => z[r * W + c];
  for (let r = 0; r < H - 1; r++) for (let c = 0; c < W - 1; c++) {
    const q = [v(r, c), v(r, c + 1), v(r + 1, c + 1), v(r + 1, c)];
    if (q.some((x) => x == null)) continue;
    const corners = [[c, r], [c + 1, r], [c + 1, r + 1], [c, r + 1]];
    const pts = [];
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4];
      if ((a < L) !== (b < L)) {
        const t = (L - a) / (b - a);
        const [ca, ra] = corners[i], [cb, rb] = corners[(i + 1) % 4];
        pts.push([ca + t * (cb - ca), ra + t * (rb - ra)]);
      }
    }
    if (pts.length === 2) segs.push(pts);
    else if (pts.length === 4) segs.push([pts[0], pts[1]], [pts[2], pts[3]]);
  }
  return segs;
}

// Build the green as triangles and lines in viewer space: x to the right,
// y up (exaggerated metres), z towards the viewer, with the direction of
// play running away from the viewer (into the screen).
//   h:     course hole with shape.polygon and shape.grid
//   from:  where the player looks from ({lat, lon}), for the starting view
//   ball:  ball on the green ({lat, lon}), drawn as a marker
//   exaggeration: vertical scale
//   heatGrid: drape the height-coloured grid (and dim the grass under it)
export function buildGreenMesh(h, { from, ball, exaggeration = 4, heatGrid = true } = {}) {
  const shape = h?.shape, grid = shape?.grid;
  if (!shape?.polygon || !grid) return null;
  const o = grid.origin;
  const ring = smoothed(shape.polygon).map((p) => toLocal(o, p));
  const bunkers = (shape.bunkers ?? []).map((b) => smoothed(b).map((p) => toLocal(o, p)))
    .filter((b) => b.some((p) => insideXY(p, ring) || edgeDist(p, ring) < BUNKER_NEAR_M));

  // Rotation: direction of play points into the screen (-z).
  const cx = ring.reduce((a, p) => a + p.x, 0) / ring.length, cy = ring.reduce((a, p) => a + p.y, 0) / ring.length;
  let theta = 0;
  if (from) {
    const f = toLocal(o, from);
    theta = Math.atan2(cx - f.x, cy - f.y); // bearing of play from north
  }
  const cos = Math.cos(theta), sin = Math.sin(theta);
  // local east/north metres -> viewer x (right), z (towards viewer)
  const rot = (x, y) => {
    const dx = x - cx, dy = y - cy;
    return [dx * cos - dy * sin, -(dx * sin + dy * cos)];
  };

  // Height range on the green itself sets colours and the base level.
  const top = grid.y0 + grid.H * grid.dy;
  const cellXY = (c, r) => ({ x: grid.x0 + (c + 0.5) * grid.dx, y: top - (r + 0.5) * grid.dy });
  let zmin = Infinity, zmax = -Infinity;
  for (let r = 0; r < grid.H; r++) for (let c = 0; c < grid.W; c++) {
    const z = grid.z[r * grid.W + c];
    if (z == null) continue;
    if (insideXY(cellXY(c, r), ring)) { zmin = Math.min(zmin, z); zmax = Math.max(zmax, z); }
  }
  if (!Number.isFinite(zmin)) return null;
  const relief = Math.max(0.05, zmax - zmin);
  // Keep the stretched height under about a third of the green's size, so a
  // steep green still reads as a green and not a ramp.
  const size = Math.max(...ring.map((p) => Math.hypot(p.x - cx, p.y - cy))) * 2;
  const requested = exaggeration;
  exaggeration = Math.max(1, Math.min(exaggeration, Math.floor((0.33 * size) / relief)));
  const Y = (z) => (z - zmin) * exaggeration;

  // Classify each grid point: 0 = not drawn, 1 = fringe, 2 = green, 3 = bunker.
  const N = grid.W * grid.H;
  const kind = new Uint8Array(N);
  for (let r = 0; r < grid.H; r++) for (let c = 0; c < grid.W; c++) {
    const i = r * grid.W + c;
    if (grid.z[i] == null) continue;
    const p = cellXY(c, r);
    if (insideXY(p, ring)) kind[i] = 2;
    else if (edgeDist(p, ring) <= COLLAR_M) kind[i] = bunkers.some((b) => insideXY(p, b)) ? 3 : 1;
  }

  const pos = [], col = [], idx = [], kinds = [];
  const vid = new Int32Array(N).fill(-1);
  for (let r = 0; r < grid.H; r++) for (let c = 0; c < grid.W; c++) {
    const i = r * grid.W + c;
    if (!kind[i]) continue;
    const p = cellXY(c, r);
    const [x, z] = rot(p.x, p.y);
    const zz = grid.z[i];
    let y = Y(zz);
    if (kind[i] !== 2) {
      // Ease the collar's height towards the green's edge as it fades out,
      // so the edge of the drawn ground lies flat instead of in spikes.
      const e = nearestOnRing(p, ring);
      const ze = heightAt(grid, e.x, e.y);
      const k = Math.max(0, Math.min(1, (e.d - 1.5) / (COLLAR_M - 1.5)));
      if (ze != null) y += (Y(ze) - y) * k;
    }
    vid[i] = pos.length / 3;
    pos.push(x, y, z);
    kinds.push(kind[i]);
    const t = Math.max(0, Math.min(1, (zz - zmin) / relief));
    // Under the coloured grid the grass is darker and plainer, so the colours stand out.
    if (kind[i] === 2) col.push(...(heatGrid ? greenColour(t).map((v) => v * 0.62) : greenColour(t)));
    else {
      // Collar and sand fade into the background towards the outer edge, so
      // the square grid cells don't show as a jagged border.
      const base = kind[i] === 3 ? SAND : FRINGE;
      const fade = Math.max(0, Math.min(1, (edgeDist(p, ring) - 1) / (COLLAR_M - 1)));
      const k = fade * fade;
      col.push(...base.map((v, j) => v + (BG[j] - v) * k));
    }
  }
  // Two triangles per grid cell whose four corners are all drawn.
  for (let r = 0; r < grid.H - 1; r++) for (let c = 0; c < grid.W - 1; c++) {
    const a = vid[r * grid.W + c], b = vid[r * grid.W + c + 1], d = vid[(r + 1) * grid.W + c], e = vid[(r + 1) * grid.W + c + 1];
    if (a < 0 || b < 0 || d < 0 || e < 0) continue;
    idx.push(a, d, b, b, d, e);
  }

  // Smooth normals from the triangles.
  const nrm = new Float32Array(pos.length);
  for (let k = 0; k < idx.length; k += 3) {
    const [i0, i1, i2] = [idx[k] * 3, idx[k + 1] * 3, idx[k + 2] * 3];
    const ux = pos[i1] - pos[i0], uy = pos[i1 + 1] - pos[i0 + 1], uz = pos[i1 + 2] - pos[i0 + 2];
    const vx = pos[i2] - pos[i0], vy = pos[i2 + 1] - pos[i0 + 1], vz = pos[i2 + 2] - pos[i0 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const i of [i0, i1, i2]) { nrm[i] += nx; nrm[i + 1] += ny; nrm[i + 2] += nz; }
  }
  for (let i = 0; i < nrm.length; i += 3) {
    let l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1;
    if (nrm[i + 1] < 0) l = -l; // face up
    nrm[i] /= l; nrm[i + 1] /= l; nrm[i + 2] /= l;
  }

  // Lines: contours on the green, the green's edge, and the ball marker.
  const LIFT = 0.03;
  const surfaceY = (x, y) => { const z = heightAt(grid, x, y); return z == null ? null : Y(z) + LIFT; };
  const step = relief > 1.2 ? 0.2 : 0.1;
  const contour = [];
  for (let L = Math.ceil(zmin / step) * step; L < zmax; L += step) {
    for (const [p, q] of levelSegments(grid, L)) {
      const a = cellXY(p[0], p[1]), b = cellXY(q[0], q[1]);
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (!insideXY(m, ring)) continue;
      const [ax, az] = rot(a.x, a.y), [bx, bz] = rot(b.x, b.y);
      contour.push(ax, Y(L) + LIFT, az, bx, Y(L) + LIFT, bz);
    }
  }
  const edge = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const ya = surfaceY(a.x, a.y), yb = surfaceY(b.x, b.y);
    if (ya == null || yb == null) continue;
    const [ax, az] = rot(a.x, a.y), [bx, bz] = rot(b.x, b.y);
    edge.push(ax, ya, az, bx, yb, bz);
  }
  let ballAt = null;
  if (ball) {
    const q = toLocal(o, ball);
    const y = surfaceY(q.x, q.y);
    if (y != null) { const [x, z] = rot(q.x, q.y); ballAt = [x, y, z]; }
  }

  // The coloured grid: lines every 1.5 m both ways, lined up with the view,
  // draped on the green. Each is a thin flat strip (WebGL lines are a single
  // pixel on phones) coloured by height at every point.
  const heat = { positions: [], colours: [], indices: [] };
  if (heatGrid) {
    // viewer (x, z) back to local east/north metres
    const unrot = (vx, vz) => { const a = vx, b = -vz; return { x: cx + a * cos + b * sin, y: cy - a * sin + b * cos }; };
    const vr = ring.map((p) => rot(p.x, p.y));
    const xs = vr.map((q) => q[0]), zs = vr.map((q) => q[1]);
    const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
    const GLIFT = 0.02;
    const vtx = (vx, vz) => {
      const p = unrot(vx, vz);
      const zz = heightAt(grid, p.x, p.y);
      if (zz == null) return null;
      return { y: Y(zz) + GLIFT, c: heatColour((zz - zmin) / relief), inside: insideXY(p, ring) };
    };
    // one straight line of the grid, sampled every 0.5 m, kept where it's on the green
    const run = (fixed, from, to, alongX) => {
      const pts = [];
      for (let u = from; u <= to + 1e-9; u += 0.5) {
        const [vx, vz] = alongX ? [u, fixed] : [fixed, u];
        pts.push({ vx, vz, v: vtx(vx, vz) });
      }
      const hw = GRID_W / 2;
      for (let k = 0; k < pts.length - 1; k++) {
        const a = pts[k], b = pts[k + 1];
        if (!a.v?.inside || !b.v?.inside) continue;
        const base = heat.positions.length / 3;
        // offsets across the strip (perpendicular, on the ground)
        const [ox, oz] = alongX ? [0, hw] : [hw, 0];
        for (const q of [a, b]) {
          heat.positions.push(q.vx - ox, q.v.y, q.vz - oz, q.vx + ox, q.v.y, q.vz + oz);
          heat.colours.push(...q.v.c, ...q.v.c);
        }
        heat.indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      }
    };
    for (let gx = Math.ceil(x0 / GRID_M) * GRID_M; gx <= x1; gx += GRID_M) run(gx, z0, z1, false);
    for (let gz = Math.ceil(z0 / GRID_M) * GRID_M; gz <= z1; gz += GRID_M) run(gz, x0, x1, true);
  }

  // Size, for framing the camera.
  let rad = 0, greenRad = 0;
  for (let i = 0; i < pos.length; i += 3) {
    const r = Math.hypot(pos[i], pos[i + 2]);
    rad = Math.max(rad, r);
    if (kinds[i / 3] === 2) greenRad = Math.max(greenRad, r);
  }
  return {
    positions: new Float32Array(pos), normals: nrm, colours: new Float32Array(col), indices: idx,
    kinds: Uint8Array.from(kinds), // per vertex: 1 collar, 2 green, 3 sand
    contours: new Float32Array(contour), edge: new Float32Array(edge), ball: ballAt,
    heat: { positions: new Float32Array(heat.positions), colours: new Float32Array(heat.colours), indices: heat.indices },
    radius: rad, greenRadius: greenRad, height: relief * exaggeration, relief, exaggeration, requested, zmin, zmax, contourStep: step,
  };
}

// ---------- drawing ----------

const VS = `
attribute vec3 p; attribute vec3 n; attribute vec3 c;
uniform mat4 m; varying vec3 vc; varying vec3 vn;
void main(){ gl_Position = m * vec4(p, 1.0); vc = c; vn = n; }`;
const FS = `
precision mediump float; varying vec3 vc; varying vec3 vn;
uniform vec3 l;
void main(){ float d = max(dot(normalize(vn), l), 0.0); gl_FragColor = vec4(vc * (0.45 + 0.65 * d), 1.0); }`;
const LVS = `attribute vec3 p; uniform mat4 m; uniform float s; void main(){ gl_Position = m * vec4(p, 1.0); gl_PointSize = s; }`;
const LFS = `precision mediump float; uniform vec4 k; uniform float rnd;
void main(){ if (rnd > 0.5 && length(gl_PointCoord - 0.5) > 0.5) discard; gl_FragColor = k; }`;

function program(gl, vs, fs) {
  const sh = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

// 4x4 matrices, column-major.
const mul = (a, b) => {
  const o = new Float32Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
    o[i * 4 + j] = s;
  }
  return o;
};
const perspective = (fov, asp, near, far) => {
  const f = 1 / Math.tan(fov / 2), nf = 1 / (near - far);
  return new Float32Array([f / asp, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
};
const lookAt = (eye, at) => {
  const z = norm([eye[0] - at[0], eye[1] - at[1], eye[2] - at[2]]);
  const x = norm(cross([0, 1, 0], z));
  const y = cross(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export const hasWebGL = () => {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl') || c.getContext('experimental-webgl')); } catch { return false; }
};

// Draw a mesh from buildGreenMesh into a canvas. Returns { setMesh, reset, destroy }.
export function mountGreen3d(canvas, mesh) {
  const gl = canvas.getContext('webgl', { antialias: true }) || canvas.getContext('experimental-webgl');
  if (!gl) throw new Error('3D isn\'t available on this device');
  const surf = program(gl, VS, FS), line = program(gl, LVS, LFS);
  const ext = gl.getExtension('OES_element_index_uint');
  const buf = {};
  const view = { yaw: 0, pitch: 0.7, dist: 1 };
  let M = mesh;

  function upload(m) {
    for (const b of Object.values(buf)) if (b instanceof WebGLBuffer) gl.deleteBuffer(b);
    const arr = (data, target = gl.ARRAY_BUFFER) => { const b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, data, gl.STATIC_DRAW); return b; };
    buf.p = arr(m.positions); buf.n = arr(m.normals); buf.c = arr(m.colours);
    const big = m.positions.length / 3 > 65535 && ext;
    buf.i = arr(big ? new Uint32Array(m.indices) : new Uint16Array(m.indices), gl.ELEMENT_ARRAY_BUFFER);
    buf.itype = big ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    buf.count = big || m.positions.length / 3 <= 65535 ? m.indices.length : 0;
    buf.contour = arr(m.contours.length ? m.contours : new Float32Array(6));
    const hv = m.heat?.positions.length ? m.heat : null;
    buf.hp = hv ? arr(hv.positions) : null;
    buf.hc = hv ? arr(hv.colours) : null;
    buf.hn = hv ? arr(new Float32Array(hv.positions.length).map((_, i) => (i % 3 === 1 ? 1 : 0))) : null;
    const hbig = hv && hv.positions.length / 3 > 65535 && ext;
    buf.hi = hv ? arr(hbig ? new Uint32Array(hv.indices) : new Uint16Array(hv.indices), gl.ELEMENT_ARRAY_BUFFER) : null;
    buf.htype = hbig ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    buf.hcount = hv && (hbig || hv.positions.length / 3 <= 65535) ? hv.indices.length : 0;
    buf.edge = arr(m.edge.length ? m.edge : new Float32Array(6));
    buf.ball = m.ball ? arr(new Float32Array([...m.ball, m.ball[0], m.ball[1] + Math.max(0.6, m.height * 0.5), m.ball[2]])) : null;
  }
  upload(M);
  const reset = () => { view.yaw = 0; view.pitch = 0.7; view.dist = 1; draw(); };

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  function draw() {
    resize();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(BG[0], BG[1], BG[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    // Frame the green itself (the collar fades out anyway).
    const R = Math.max(6, M.greenRadius ?? M.radius);
    const asp = canvas.width / canvas.height;
    const d = R * (asp < 1 ? 2.6 / asp : 2.4) * view.dist;
    const target = [0, M.height * 0.45, 0];
    const eye = [
      target[0] + d * Math.cos(view.pitch) * Math.sin(view.yaw),
      target[1] + d * Math.sin(view.pitch),
      target[2] + d * Math.cos(view.pitch) * Math.cos(view.yaw),
    ];
    const P = perspective(0.75, canvas.width / canvas.height, d * 0.05, d * 4);
    const MV = mul(P, lookAt(eye, target));

    gl.useProgram(surf);
    const at = (prog, name, b, size = 3) => { const loc = gl.getAttribLocation(prog, name); if (loc < 0) return; gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0); };
    at(surf, 'p', buf.p); at(surf, 'n', buf.n); at(surf, 'c', buf.c);
    gl.uniformMatrix4fv(gl.getUniformLocation(surf, 'm'), false, MV);
    gl.uniform3fv(gl.getUniformLocation(surf, 'l'), norm([-0.4, 1, 0.5]));
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf.i);
    // Push the ground back a touch so the grid strips lying on it always win.
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(2, 2);
    gl.drawElements(gl.TRIANGLES, buf.count, buf.itype, 0);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    if (buf.hcount) {
      at(surf, 'p', buf.hp); at(surf, 'n', buf.hn); at(surf, 'c', buf.hc);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf.hi);
      gl.drawElements(gl.TRIANGLES, buf.hcount, buf.htype, 0);
    }
    // Free the surface attributes before the line program uses slot 0.
    for (const n of ['n', 'c']) { const loc = gl.getAttribLocation(surf, n); if (loc >= 0) gl.disableVertexAttribArray(loc); }

    gl.useProgram(line);
    gl.uniformMatrix4fv(gl.getUniformLocation(line, 'm'), false, MV);
    const lines = (b, count, rgba, mode = gl.LINES, size = 1) => {
      if (!b || !count) return;
      at(line, 'p', b);
      gl.uniform4fv(gl.getUniformLocation(line, 'k'), rgba);
      gl.uniform1f(gl.getUniformLocation(line, 's'), size);
      gl.uniform1f(gl.getUniformLocation(line, 'rnd'), mode === gl.POINTS ? 1 : 0);
      gl.drawArrays(mode, 0, count);
    };
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    lines(buf.contour, M.contours.length / 3, M.heat?.positions.length ? [0.02, 0.06, 0.03, 0.35] : [0.04, 0.12, 0.06, 0.55]);
    lines(buf.edge, M.edge.length / 3, [1, 1, 1, 0.95]);
    if (buf.ball) {
      lines(buf.ball, 2, [1, 1, 1, 1]);
      gl.disable(gl.DEPTH_TEST);
      lines(buf.ball, 1, [1, 1, 1, 1], gl.POINTS, 9 * Math.min(2, window.devicePixelRatio || 1));
      gl.enable(gl.DEPTH_TEST);
    }
    gl.disable(gl.BLEND);
  }

  // Touch: one finger turns (left/right spins, up/down tilts), two fingers
  // zoom, double-tap resets. Mouse drag and wheel do the same.
  const pts = new Map();
  let pinch = null, lastTap = 0, raf = 0;
  const redraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };
  const down = (e) => {
    canvas.setPointerCapture?.(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), dist: view.dist }; }
    if (pts.size === 1) {
      const now = Date.now();
      if (now - lastTap < 300) reset();
      lastTap = now;
    }
  };
  const move = (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    if (pts.size === 1) {
      view.yaw -= (e.clientX - p.x) * 0.012;
      view.pitch = Math.max(0.3, Math.min(1.45, view.pitch + (e.clientY - p.y) * 0.008));
    }
    p.x = e.clientX; p.y = e.clientY;
    if (pts.size === 2 && pinch) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      view.dist = Math.max(0.35, Math.min(2.2, pinch.dist * (pinch.d / d)));
    }
    redraw();
  };
  const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; };
  const wheel = (e) => { e.preventDefault(); view.dist = Math.max(0.35, Math.min(2.2, view.dist * (1 + e.deltaY * 0.001))); redraw(); };
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', wheel, { passive: false });
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(redraw) : null;
  ro?.observe(canvas);
  draw();

  return {
    setMesh(m) { M = m; upload(m); draw(); },
    reset,
    destroy() {
      ro?.disconnect();
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('wheel', wheel);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
