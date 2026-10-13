// Looking back at a round: small shot-path previews for every hole, and a
// full map of one hole at a time with the shots you played.
import * as db from '../db.js';
import { toLocal } from '../geo.js';
import { deriveRound } from '../stats.js';
import { previewRing, smoothed, LIE_LABEL } from '../holemap.js';
import { holeLayers } from './holeart.js';
import { createMap, pin, line, circle, polygon, frame, fit, hasMap, drawHoleMap } from '../map.js';
import { esc, signed } from '../ui.js';
import { scoreClass } from './card.js';

const f = (n) => n.toFixed(1);

// Points for a hole: where each shot started, then where the last one ended.
function holePath(dh) {
  const pts = dh.shots.map((s) => s.start);
  const last = dh.shots.at(-1);
  if (last?.end) pts.push(last.end);
  return pts;
}

// A small SVG of one hole's shots, turned so it plays up the tile.
export function holeThumb(dh, courseHole) {
  const pts = holePath(dh);
  const green = dh.green ?? pts.at(-1);
  if (!green || !pts.length) return '<div class="ht-empty">No shots</div>';
  const o = green;
  const from = pts[0] ?? courseHole?.tee;
  const v = from ? toLocal(from, green) : { x: 0, y: 1 };
  const th = Math.atan2(v.x, v.y);
  const cos = Math.cos(th), sin = Math.sin(th);
  const S = (p) => { const q = toLocal(o, p); return [q.x * cos - q.y * sin, -(q.x * sin + q.y * cos)]; };
  const sp = pts.map(S);
  const ring = (r) => previewRing(r).map(S);
  const outline = courseHole?.shape?.polygon ? ring(courseHole.shape.polygon) : null;
  const all = [...sp, ...(outline ?? [[-dh.radius, -dh.radius], [dh.radius, dh.radius]])];
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  // keep a 3:4 tile shape with some margin
  const pad = Math.max(12, (y1 - y0) * 0.08);
  x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
  const w = x1 - x0, h = y1 - y0;
  if (w / h > 0.75) { const nh = w / 0.75; y0 -= (nh - h) / 2; y1 = y0 + nh; } else { const nw = h * 0.75; x0 -= (nw - w) / 2; x1 = x0 + nw; }
  // Hole map underneath: fairways (mapped or estimated), tees, water, bunkers.
  const layers = holeLayers(courseHole, S);
  const greenShape = layers.green || `<circle cx="0" cy="0" r="${f(dh.radius)}" class="ht-green"/>`;
  const path = sp.length > 1 ? `<path d="M${sp.map((p) => `${f(p[0])},${f(p[1])}`).join('L')}" class="ht-path"/>` : '';
  const r = ((x1 - x0) * 0.028).toFixed(2); // about 3 px on a phone tile
  // Each dot is where a shot was played from, coloured by its lie.
  const dots = sp.slice(0, dh.shots.length).map((p, i) => `<circle cx="${f(p[0])}" cy="${f(p[1])}" r="${r}" class="ht-dot${dh.shots[i].penalty ? ' pen' : ''}${dh.shots[i].startLie && i ? ` lie-${dh.shots[i].startLie}` : ''}"/>`).join('');
  return `<svg viewBox="${f(x0)} ${f(y0)} ${f(x1 - x0)} ${f(y1 - y0)}" class="ht-svg" aria-hidden="true">${layers.under}${greenShape}${path}${dots}</svg>`;
}

// Grid of every hole in the round, for the round summary.
export function holeGrid(roundId, r, course) {
  return `<div class="hole-grid">${r.holes.map((dh) => `
    <a class="ht" href="#/round/${roundId}/review/${dh.hole}" aria-label="Hole ${dh.hole}${dh.complete ? `, ${dh.score} on a par ${dh.par}` : ''}">
      ${holeThumb(dh, course.holes[dh.hole - 1])}
      <span class="ht-n">${dh.hole}</span>
      ${dh.complete ? `<span class="ht-score sc-mark ${scoreClass(dh.toPar)}">${dh.score}</span>` : ''}
    </a>`).join('')}</div>`;
}

// Full-screen look at one hole of a finished (or in-progress) round.
export async function reviewView(root, { roundId, hole }) {
  const round = await db.get('rounds', roundId);
  if (!round) { root.innerHTML = '<p class="empty">That round isn\'t on this phone.</p>'; return {}; }
  const course = await db.get('courses', round.courseId);
  const shots = await db.shotsForRound(roundId);
  const r = deriveRound(course, round, shots);
  const i = Math.max(0, r.holes.findIndex((h) => h.hole === hole));
  const dh = r.holes[i];
  const ch = course.holes[dh.hole - 1];
  const prev = r.holes[i - 1], next = r.holes[i + 1];
  const name = dh.complete ? (dh.toPar === 0 ? 'Par' : dh.toPar === -1 ? 'Birdie' : dh.toPar === -2 ? 'Eagle' : dh.toPar === 1 ? 'Bogey' : dh.toPar === 2 ? 'Double bogey' : signed(dh.toPar)) : 'Not finished';

  root.innerHTML = `
  <section class="review">
    <header class="hole-head">
      <a class="nav-btn" href="#/round/${roundId}/review/${prev?.hole ?? dh.hole}" aria-label="Previous hole" ${prev ? '' : 'aria-disabled="true"'}>‹</a>
      <div class="hole-title">
        <span class="hole-no">${dh.hole}</span>
        <span class="hole-meta"><b>Par ${dh.par}${ch?.metres ? ` <small>· ${ch.metres} m</small>` : ''}</b><span>${dh.complete ? `${dh.score} · ${name}` : name}</span></span>
      </div>
      <a class="nav-btn" href="#/round/${roundId}/review/${next?.hole ?? dh.hole}" aria-label="Next hole" ${next ? '' : 'aria-disabled="true"'}>›</a>
    </header>
    <div class="map-wrap review-map"><div id="map" class="map"></div>
      <a class="back-chip" href="#/round/${roundId}/card" data-back="grid">‹ Round</a></div>
    <div class="review-body">
      <div class="review-stats">
        <span><b>${dh.putts ?? '–'}</b>Putts</span>
        ${dh.par >= 4 ? `<span><b>${{ hit: 'Hit', left: 'Left', right: 'Right', short: 'Short' }[dh.fairway] ?? '–'}</b>Fairway</span>` : ''}
        <span><b>${dh.gir == null ? '–' : dh.gir ? 'Yes' : 'No'}</b>Green in reg.</span>
        <span><b>${dh.penalties || 0}</b>Penalties</span>
      </div>
      <ol class="shot-list">${dh.shots.length ? dh.shots.map((s) => `
        <li class="shot-row static">
          <span class="shot-n">${s.index + 1}</span>
          <span class="shot-club ${s.club ? '' : 'unset'}">${esc(s.club ?? '–')}</span>
          <span class="shot-dist">${s.dist ? `${Math.round(s.dist)} m` : '–'}</span>
          <span class="shot-res ${s.onGreen && s.approach ? 'good' : ''}">${s.endLie ? `<em class="lie lie-${s.endLie}">${LIE_LABEL[s.endLie]}</em> ` : ''}${esc(s.result || '')}${s.penalty ? ' <em class="pen">Penalty</em>' : ''}${s.mishit ? ' <em>Mishit</em>' : ''}</span>
        </li>`).join('') : '<li class="shot-empty">No shots marked on this hole.</li>'}
        ${dh.putts ? `<li class="shot-empty">Then ${dh.putts} putt${dh.putts === 1 ? '' : 's'}.</li>` : ''}
      </ol>
      <div class="hole-foot">
        <a class="btn ghost" href="#/round/${roundId}/card">Scorecard</a>
        <a class="btn ghost" href="#/round/${roundId}/hole/${dh.hole}">Edit hole</a>
      </div>
    </div>
  </section>`;

  let map = null;
  if (hasMap()) {
    const pts = holePath(dh);
    const green = dh.green ?? pts.at(-1) ?? course.centre;
    map = createMap(root.querySelector('#map'), green ?? { lat: -27.45, lon: 153 }, 17, { rotate: true });
    const layer = window.L.layerGroup().addTo(map);
    drawHoleMap(ch, layer);
    if (ch?.shape?.polygon) polygon(smoothed(ch.shape.polygon), 'green-outline').addTo(layer);
    else if (dh.green) circle(dh.green, dh.radius, 'green-ring').addTo(layer);
    if (dh.green) pin(dh.green, 'flag', '<span></span>', { interactive: false }).addTo(layer);
    if (pts.length > 1) line(pts, 'shot-line').addTo(layer);
    for (const s of dh.shots) {
      if (s.end && s.dist) {
        const mid = { lat: (s.start.lat + s.end.lat) / 2, lon: (s.start.lon + s.end.lon) / 2 };
        pin(mid, 'seg-label', `<span>${Math.round(s.dist)}</span>`, { interactive: false }).addTo(layer);
      }
      pin(s.start, `shot ${s.source}${s.index && s.startLie ? ` lie-${s.startLie}` : ''}`, `${s.index + 1}`, { interactive: false }).addTo(layer);
    }
    if (dh.greenPos) pin(dh.greenPos, 'ball', '', { interactive: false }).addTo(layer);
    // Face down the hole, from the first shot (or tee) to the green.
    const from = pts[0] ?? ch?.tee;
    requestAnimationFrame(() => {
      map.invalidateSize();
      if (from && green && pts.length) frame(map, from, green, { padTop: 30, padBottom: 30 });
      else fit(map, [...pts, green]);
    });
  } else {
    root.querySelector('#map').innerHTML = '<p class="map-off">The map needs signal the first time.</p>';
  }
  // Coming back from a hole: land on the hole grid, not the top of the page.
  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-back="grid"]')) { try { sessionStorage.setItem('scrollTo', 'holeGrid'); } catch { /* fine */ } }
  });
  return { destroy() { map?.remove(); } };
}
