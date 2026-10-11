// Green preview: the green from above, turned so you're looking at it from
// where you'll play, with height shading, contour lines and downhill arrows.
import * as db from '../db.js';
import { toLocal, distance } from '../geo.js';
import { analyse, describeFall, shapePolygon, buildCourseGreens, CREDITS } from '../greens.js';
import { esc, sheet, toast } from '../ui.js';

const PAD = 4; // metres around the green in the drawing

// Where a view should be taken from: you, your last shot, the hole line, the tee.
export function viewPoint({ fix, lastShot, shape, tee, green }) {
  if (fix && green && distance(fix, green) < 700) return { p: fix, label: 'From where you are' };
  if (lastShot) return { p: lastShot, label: 'From your last shot' };
  if (shape?.playFrom) return { p: shape.playFrom, label: 'From the fairway' };
  if (tee) return { p: tee, label: 'From the tee' };
  return null;
}

// Marching squares over the height grid: line segments where height = level.
function contours(grid, levels, toXY) {
  const segs = [];
  const { W, H, z } = grid;
  const v = (r, c) => z[r * W + c];
  for (let r = 0; r < H - 1; r++) for (let c = 0; c < W - 1; c++) {
    const q = [v(r, c), v(r, c + 1), v(r + 1, c + 1), v(r + 1, c)];
    if (q.some((x) => x == null)) continue;
    const corners = [[c, r], [c + 1, r], [c + 1, r + 1], [c, r + 1]];
    for (const L of levels) {
      const pts = [];
      for (let i = 0; i < 4; i++) {
        const a = q[i], b = q[(i + 1) % 4];
        if ((a < L) !== (b < L)) {
          const t = (L - a) / (b - a);
          const [ca, ra] = corners[i], [cb, rb] = corners[(i + 1) % 4];
          pts.push(toXY(ca + t * (cb - ca), ra + t * (rb - ra)));
        }
      }
      if (pts.length === 2) segs.push(pts);
      else if (pts.length === 4) segs.push([pts[0], pts[1]], [pts[2], pts[3]]);
    }
  }
  return segs;
}

// SVG of a hole's green. `from` = where the player views from (lat/lon).
export function greenSvg(h, { from, ball } = {}) {
  const shape = h.shape;
  const grid = shape.grid;
  const polygon = shapePolygon(shape);
  const a = analyse(grid, polygon);
  const o = grid.origin;
  // Rotation so the direction of play points up the screen.
  const centre = { lat: polygon.reduce((s, p) => s + p.lat, 0) / polygon.length, lon: polygon.reduce((s, p) => s + p.lon, 0) / polygon.length };
  const v = from ? toLocal(from, centre) : { x: 0, y: 1 };
  const theta = Math.atan2(v.x, v.y); // bearing of play from north, radians
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const oc = toLocal(o, centre);
  // local (east, north) metres -> screen (right, down) metres
  const S = (x, y) => {
    const dx = x - oc.x, dy = y - oc.y;
    return [dx * cos - dy * sin, -(dx * sin + dy * cos)];
  };
  const loc = polygon.map((p) => toLocal(o, p));
  const sp = loc.map((p) => S(p.x, p.y));
  const bunkers = (shape.bunkers ?? []).map((b) => b.map(([lat, lon]) => { const q = toLocal(o, { lat, lon }); return S(q.x, q.y); }));
  const xs = sp.map((p) => p[0]), ys = sp.map((p) => p[1]);
  // Frame the green plus any bunker within about 10 m of it.
  const near = bunkers.flat().filter(([x, y]) => x > Math.min(...xs) - 10 && x < Math.max(...xs) + 10 && y > Math.min(...ys) - 10 && y < Math.max(...ys) + 10);
  const ax = [...xs, ...near.map((p) => p[0])], ay = [...ys, ...near.map((p) => p[1])];
  const minX = Math.min(...ax) - PAD, maxX = Math.max(...ax) + PAD, minY = Math.min(...ay) - PAD, maxY = Math.max(...ay) + PAD + 3;
  const vbW = maxX - minX, vbH = maxY - minY;
  const f = (n) => n.toFixed(2);
  const path = (pts) => `M${pts.map((p) => `${f(p[0])},${f(p[1])}`).join('L')}Z`;

  // Height shading: grid cells clipped to the green.
  const top = grid.y0 + grid.H * grid.dy;
  const cellXY = (c, r) => S(grid.x0 + c * grid.dx, top - r * grid.dy);
  const zr = Math.max(0.05, a.zmax - a.zmin);
  let cells = '';
  for (let r = 0; r < grid.H; r++) for (let c = 0; c < grid.W; c++) {
    const z = grid.z[r * grid.W + c];
    if (z == null || z < a.zmin - 0.5 || z > a.zmax + 0.5) continue;
    const t = Math.min(1, Math.max(0, (z - a.zmin) / zr));
    const [x0, y0] = cellXY(c, r), [x1, y1] = cellXY(c + 1, r), [x2, y2] = cellXY(c + 1, r + 1), [x3, y3] = cellXY(c, r + 1);
    // light (high) to dark (low) in one hue
    const l = Math.round(30 + t * 42);
    cells += `<path d="M${f(x0)},${f(y0)}L${f(x1)},${f(y1)}L${f(x2)},${f(y2)}L${f(x3)},${f(y3)}Z" fill="hsl(128 42% ${l}%)"/>`;
  }
  // Contours every 10 or 20 cm, measured from the lowest point.
  const step = zr > 1.2 ? 0.2 : 0.1;
  const levels = [];
  for (let L = Math.ceil(a.zmin / step) * step; L < a.zmax; L += step) levels.push(L);
  const cXY = (c, r) => S(grid.x0 + (c + 0.5) * grid.dx, top - (r + 0.5) * grid.dy);
  const segs = contours(grid, levels, cXY);
  const contourPath = segs.map(([p, q]) => `M${f(p[0])},${f(p[1])}L${f(q[0])},${f(q[1])}`).join('');

  // Downhill arrows, sized and weighted by steepness.
  const arrows = a.arrows.filter((ar) => ar.pct >= 1).map((ar) => {
    const [x, y] = S(ar.x, ar.y);
    const d = Math.hypot(ar.dx, ar.dy) || 1;
    const [ex, ey] = (() => { const q = S(ar.x + ar.dx / d, ar.y + ar.dy / d); return [q[0] - x, q[1] - y]; })();
    const len = 0.7 + Math.min(1.6, ar.pct / 3);
    const tx = x + ex * len, ty = y + ey * len;
    const bx = x - ex * len * 0.6, by = y - ey * len * 0.6;
    const hx = -ey * 0.55, hy = ex * 0.55;
    const cls = ar.pct >= 3 ? 'steep' : ar.pct >= 1.5 ? 'mod' : 'gentle';
    return `<g class="ar ${cls}"><path d="M${f(bx)},${f(by)}L${f(tx)},${f(ty)}"/><path d="M${f(tx - ex * 0.7 + hx)},${f(ty - ey * 0.7 + hy)}L${f(tx)},${f(ty)}L${f(tx - ex * 0.7 - hx)},${f(ty - ey * 0.7 - hy)}"/></g>`;
  }).join('');

  let ballMark = '';
  if (ball) { const q = toLocal(o, ball); const [x, y] = S(q.x, q.y); ballMark = `<circle cx="${f(x)}" cy="${f(y)}" r="0.9" class="gp-ball"/>`; }
  const depth = Math.max(...ys) - Math.min(...ys), width = Math.max(...xs) - Math.min(...xs);

  const svg = `<svg class="gp-svg" viewBox="${f(minX)} ${f(minY)} ${f(vbW)} ${f(vbH)}" role="img"
      aria-label="Green for hole ${h.n}: ${esc(describeFall(a.plane, v))}">
    <defs><clipPath id="gclip${h.n}"><path d="${path(sp)}"/></clipPath></defs>
    ${bunkers.map((b) => `<path d="${path(b)}" class="gp-bunker"/>`).join('')}
    <g clip-path="url(#gclip${h.n})">${cells}<path d="${contourPath}" class="gp-contour"/></g>
    <path d="${path(sp)}" class="gp-edge"/>
    ${arrows}${ballMark}
    <path d="M${f((minX + maxX) / 2 - 1.4)},${f(maxY - 0.6)}L${f((minX + maxX) / 2)},${f(maxY - 2.6)}L${f((minX + maxX) / 2 + 1.4)},${f(maxY - 0.6)}Z" class="gp-you"/>
  </svg>`;
  return { svg, a, fall: describeFall(a.plane, v), depth, width };
}

// Bottom sheet with the preview, or a prompt to fetch the data.
export function openGreenSheet({ course, hole, from, fromLabel, ball, onUpdated }) {
  const h = course.holes[hole - 1];
  if (!h.shape?.grid) {
    sheet(`
      <h3 class="sheet-title">Green ${hole}</h3>
      <p class="sheet-sub">No green shape or slope saved for ${esc(course.name)} yet.</p>
      <p class="sheet-msg">Download outlines from OpenStreetMap and LiDAR heights from the Queensland Government for all 18 greens. Do it once on Wi-Fi; after that it works without signal.</p>
      <div class="sheet-row"><button class="btn ghost" data-g="close">Not now</button><button class="btn primary" data-g="get">Get green data</button></div>
      <p class="sheet-note" id="gprog"></p>`,
    (el, close) => {
      el.addEventListener('click', async (e) => {
        const g = e.target.closest('[data-g]')?.dataset.g;
        if (g === 'close') close();
        if (g === 'get') {
          e.target.disabled = true;
          const ok = await downloadGreens(course, (msg) => { el.querySelector('#gprog').textContent = msg; });
          if (ok) { close(); onUpdated?.(); openGreenSheet({ course, hole, from, fromLabel, ball, onUpdated }); }
          else e.target.disabled = false;
        }
      });
    });
    return;
  }
  let g;
  try { g = greenSvg(h, { from, ball }); } catch (err) { toast(`Couldn't draw this green: ${err.message}`, 'warn'); return; }
  const { a } = g;
  const year = h.shape.survey?.year;
  sheet(`
    <h3 class="sheet-title">Green ${hole}</h3>
    <p class="gp-fall"><b>${esc(g.fall)}</b>${a.plane.pct >= 0.6 ? ` · ${a.plane.pct.toFixed(1)}%` : ''}</p>
    <p class="sheet-sub">${Math.round(g.depth)} m deep × ${Math.round(g.width)} m wide · ${a.relief.toFixed(1)} m between the high and low points${a.steepShare > 0.3 ? ' · tiers or steep sections' : ''}</p>
    <div class="gp-wrap">${g.svg}</div>
    <div class="gp-legend">
      <span><i class="lg-ar gentle"></i>1–1.5%</span><span><i class="lg-ar mod"></i>1.5–3%</span><span><i class="lg-ar steep"></i>over 3%</span>
      <span><i class="lg-shade"></i>lighter is higher</span>
    </div>
    <p class="sheet-note">${esc(fromLabel ?? 'Looking from the front')}: arrows point downhill (none where it's under 1%); lines are 10 cm height steps${a.zmax - a.zmin > 1.2 ? ' (20 cm here)' : ''}.
      A guide to the main tilt, not every break: LiDAR${year ? ` from ${year}` : ''} at about 1 m, ${h.shape.source === 'estimate' ? 'outline estimated from your front and back points' : 'outline from OpenStreetMap'}.</p>
    <p class="sheet-note">${CREDITS}</p>
    <div class="sheet-row"><button class="btn ghost" data-g="refresh">Refresh data</button><button class="btn primary" data-g="close">Done</button></div>
    <p class="sheet-note" id="gprog"></p>`,
  (el, close) => {
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-g]');
      if (!b) return;
      if (b.dataset.g === 'close') close();
      if (b.dataset.g === 'refresh') {
        b.disabled = true;
        const ok = await downloadGreens(course, (msg) => { el.querySelector('#gprog').textContent = msg; });
        b.disabled = false;
        if (ok) { close(); onUpdated?.(); openGreenSheet({ course, hole, from, fromLabel, ball, onUpdated }); }
      }
    });
  });
}

// Fetch and save green data for a whole course. Returns true on success.
export async function downloadGreens(course, say = () => {}) {
  try {
    let osmData = null;
    if (course.seedKey) {
      try { const r = await fetch(`data/osm/${course.seedKey}.json`); if (r.ok) osmData = await r.json(); } catch { /* fall back to Overpass */ }
    }
    say(osmData ? 'Using saved outlines…' : 'Getting green outlines from OpenStreetMap…');
    const { ok, problems } = await buildCourseGreens(course, {
      osmData, onProgress: (d, t, label) => say(`${label}: ${d} of ${t}`),
    });
    await db.put('courses', course);
    const msg = ok ? `Saved ${ok} green${ok === 1 ? '' : 's'}.${problems.length ? ` No data for hole${problems.length === 1 ? '' : 's'} ${problems.join(', ')}.` : ''}` : 'No greens found for this course.';
    say(msg); toast(msg, problems.length ? 'warn' : '');
    return ok > 0;
  } catch (err) {
    say(err.message); toast(err.message, 'warn');
    return false;
  }
}
