// Small drawings of a hole from its map: fairways (mapped, or a rough
// estimate), tees, water, bunkers and the green, all with rounded outlines.
// Used by the course screen's hole previews and the round's hole tiles.
import { toLocal } from '../geo.js';
import { previewRing, smoothPathD, holeLine, estimateFairway } from '../holemap.js';
import { greenRadius } from '../stats.js';

const f = (n) => n.toFixed(1);

// SVG for a hole's surfaces. `S` maps {lat, lon} to screen [x, y].
// Returns { under, green, estimated } so callers can stack shots in between.
export function holeLayers(courseHole, S) {
  const fe = courseHole?.features;
  const ring = (r) => previewRing(r).map(S);
  const shapes = (rings, cls) => (rings ?? []).map((r) => `<path d="${smoothPathD(ring(r), f)}" class="${cls}"/>`).join('');
  const est = estimateFairway(courseHole);
  let under = est ? shapes([est], 'ht-fairway est') : '';
  if (fe) under += shapes(fe.fairways, 'ht-fairway') + shapes(fe.tees, 'ht-tee') + shapes(fe.water, 'ht-water');
  under += shapes(fe?.bunkers ?? courseHole?.shape?.bunkers, 'ht-bunker');
  const green = courseHole?.shape?.polygon ? `<path d="${smoothPathD(ring(courseHole.shape.polygon), f)}" class="ht-green"/>` : '';
  return { under, green, estimated: !!est };
}

// A preview of a whole hole, tee at the bottom and green at the top.
// Returns '' when the hole has no tee and green to draw between.
export function holePreview(courseHole) {
  const line = holeLine(courseHole);
  if (!line) return { svg: '', estimated: false, length: null };
  const O = courseHole.green ?? line.at(-1);
  const v = toLocal(line[0], line.at(-1));
  const th = Math.atan2(v.x, v.y);
  const cos = Math.cos(th), sin = Math.sin(th);
  const S = (p) => { const q = toLocal(O, p); return [q.x * cos - q.y * sin, -(q.x * sin + q.y * cos)]; };
  const lp = line.map(S);
  const { under, green, estimated } = holeLayers(courseHole, S);
  // Frame the line of play and the green, plus a margin for the fairway.
  const pts = [...lp, ...(courseHole.shape?.polygon ? previewRing(courseHole.shape.polygon).map(S) : [])];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  let x0 = Math.min(...xs) - 30, x1 = Math.max(...xs) + 30, y0 = Math.min(...ys) - 18, y1 = Math.max(...ys) + 18;
  const w = x1 - x0, h = y1 - y0;
  if (w / h > 0.75) { const nh = w / 0.75; y0 -= (nh - h) / 2; y1 = y0 + nh; } else { const nw = h * 0.75; x0 -= (nw - w) / 2; x1 = x0 + nw; }
  const r = greenRadius(courseHole);
  const greenMark = green || (courseHole.green ? `<circle cx="0" cy="0" r="${f(r)}" class="ht-green"/>` : '');
  const playLine = `<path d="M${lp.map((p) => `${f(p[0])},${f(p[1])}`).join('L')}" class="ht-line"/>`;
  const len = lp.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - lp[i][0], p[1] - lp[i][1]), 0);
  return {
    svg: `<svg viewBox="${f(x0)} ${f(y0)} ${f(x1 - x0)} ${f(y1 - y0)}" class="ht-svg" aria-hidden="true">${under}${greenMark}${playLine}</svg>`,
    estimated, length: Math.round(len),
  };
}
