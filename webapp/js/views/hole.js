// Hole view: map, Mark ball, On green, shot list and the hole's stats.
import * as db from '../db.js';
import * as gps from '../gps.js';
import { distance } from '../geo.js';
import { deriveHole, deriveRound, emptyHoleStat } from '../stats.js';
import { createMap, pin, line, circle, polygon, fit, ll, hasMap, frame, northUp, canRotate } from '../map.js';
import { openGreenSheet, viewPoint } from './green.js';
import { shapePolygon } from '../greens.js';
import { DEFAULT_BAG, LIES, DEFAULT_CENTRE } from '../config.js';
import { $, esc, m, signed, toast, vibrate, sheet, confirmSheet } from '../ui.js';

// First putt length buckets (metres stored at the bucket's middle).
const FIRST_PUTT = [[0.6, '<1'], [1.5, '1–2'], [3, '2–4'], [5, '4–6'], [8, '6–10'], [12, '10–15'], [18, '15+']];
const FAIRWAY = [['hit', 'Hit'], ['left', 'Left'], ['right', 'Right'], ['short', 'Short']];
const SCORE_NAMES = { '-3': 'Albatross', '-2': 'Eagle', '-1': 'Birdie', 0: 'Par', 1: 'Bogey', 2: 'Double', 3: 'Triple' };

export async function holeView(root, { roundId, hole }) {
  const round = await db.get('rounds', roundId);
  if (!round) { root.innerHTML = `<p class="empty">That round isn't on this phone.</p>`; return {}; }
  const course = await db.get('courses', round.courseId);
  let shots = await db.shotsForRound(roundId);
  const bag = await db.getSetting('bag', DEFAULT_BAG);
  const n = Math.min(Math.max(1, hole), course.holes.length);

  if (round.currentHole !== n) { round.currentHole = n; await db.put('rounds', round); }

  const ch = () => course.holes[n - 1];
  const hs = () => (round.holes[n] ??= emptyHoleStat());
  const holeShots = () => shots.filter((s) => s.hole === n);
  const derived = () => deriveHole(ch(), hs(), holeShots());

  root.innerHTML = `
  <section class="hole">
    <header class="hole-head">
      <button class="nav-btn" data-a="prev" aria-label="Previous hole" ${n === 1 ? 'disabled' : ''}>‹</button>
      <div class="hole-title">
        <span class="hole-no">${n}</span>
        <span class="hole-meta"><b>Par ${ch().par}</b><span id="roundScore"></span></span>
      </div>
      <button class="nav-btn" data-a="next" aria-label="Next hole">›</button>
    </header>
    <div class="map-wrap">
      <div id="map" class="map"></div>
      <div class="yardage" id="yardage" aria-live="polite"></div>
      <button class="map-btn" data-a="locate" aria-label="Show my position">◎</button>
      <button class="map-btn fourth" data-a="greenview" aria-label="Green preview"><svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><ellipse cx="12" cy="16" rx="9" ry="5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 16V3l6 3-6 3" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg></button>
      <button class="map-btn third" data-a="rotate" aria-label="Map faces the hole" aria-pressed="true" hidden><span class="compass-n">N</span></button>
      <button class="map-btn second" data-a="fullscreen" aria-label="Full-screen map" aria-pressed="false"><svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <div class="map-hint" id="mapHint" hidden></div>
      <div class="measure-card" id="measure" hidden></div>
      <div class="measure-tip" id="measureTip">Tap the map to measure</div>
    </div>
    <div class="actions">
      <button class="btn mark" data-a="mark"><span class="mark-label">Mark ball</span><small id="markSub">Stand at your ball before you hit</small></button>
      <button class="btn on-green" data-a="ongreen">On green</button>
    </div>
    <ol class="shot-list" id="shots"></ol>
    <div class="hole-stats" id="hstats"></div>
    <div class="hole-foot">
      <a class="btn ghost" href="#/round/${roundId}/card">Scorecard</a>
      <button class="btn primary" data-a="next">${n === course.holes.length ? 'Finish' : `Hole ${n + 1}`}</button>
    </div>
  </section>`;

  // ---------- map ----------
  let map = null;
  let layer = null;
  let me = null;
  let meAcc = null;
  let targetFor = null; // shot id waiting for a target tap
  let fittedToFix = false;
  let measure = null; // a tapped point: distance to it and on to the green
  let measureLayer = null;

  let autoRotate = await db.getSetting('mapRotate', true);
  let lastFrom = null;      // where the view was last aimed from
  let userMovedAt = 0;      // last time the player panned the map by hand

  if (hasMap()) {
    map = createMap($('#map', root), course.centre ?? DEFAULT_CENTRE, 17, { rotate: true });
    map.on('dragstart', () => { userMovedAt = Date.now(); });
    map.on('rotate', drawCompass);
    if (canRotate()) $('[data-a="rotate"]', root).hidden = false;
    layer = window.L.layerGroup().addTo(map);
    measureLayer = window.L.layerGroup().addTo(map);
    map.on('click', onMapTap);
  } else {
    $('#map', root).innerHTML = `<p class="map-off">Map unavailable offline until the app has loaded once with signal. Marking still works.</p>`;
  }

  function drawMap() {
    if (!map) return;
    layer.clearLayers();
    const d = derived();
    const h = ch();
    if (h.green) {
      if (h.shape?.polygon) polygon(shapePolygon(h.shape), 'green-outline').addTo(layer);
      else circle(h.green, d.radius, 'green-ring').addTo(layer);
      pin(h.green, 'flag', '<span></span>', { draggable: true, title: 'Green centre (drag to move)' })
        .on('dragend', (e) => moveGreen(e.target.getLatLng()))
        .addTo(layer);
    }
    if (h.front) pin(h.front, 'edge', '').addTo(layer);
    if (h.back) pin(h.back, 'edge', '').addTo(layer);
    if (h.tee && !d.shots.length) pin(h.tee, 'tee', 'T').addTo(layer);

    const path = d.shots.map((s) => s.start);
    const last = d.shots[d.shots.length - 1];
    if (last?.end && last.endKind !== 'shot') path.push(last.end);
    if (path.length > 1) line(path, 'shot-line').addTo(layer);

    for (const s of d.shots) {
      if (s.target && s.targetKind === 'tapped') {
        line([s.start, s.target], 'target-line').addTo(layer);
        pin(s.target, 'target', '×').addTo(layer);
      }
      if (s.end && s.dist) {
        const mid = { lat: (s.start.lat + s.end.lat) / 2, lon: (s.start.lon + s.end.lon) / 2 };
        pin(mid, 'seg-label', `<span>${Math.round(s.dist)}</span>`, { interactive: false }).addTo(layer);
      }
      pin(s.start, `shot ${s.source}`, `${s.index + 1}`, { draggable: true, title: `Shot ${s.index + 1}` })
        .on('click', () => openShot(s.id))
        .on('dragend', (e) => moveShot(s.id, e.target.getLatLng()))
        .addTo(layer);
    }
    if (d.greenPos) {
      pin(d.greenPos, 'ball', '', { draggable: true, title: 'Ball on green' })
        .on('dragend', (e) => { const p = e.target.getLatLng(); hs().greenPos = { ...hs().greenPos, lat: p.lat, lon: p.lng }; save(); })
        .addTo(layer);
    }
    if (me) me.bringToFront?.();
  }

  // Aim the view from the player (or their last shot, or the tee) at the
  // green, so the hole plays up the screen like standing behind the ball.
  function aimPoint() {
    const fix = gps.latest();
    const g = ch().green;
    if (fix && g && distance(fix, g) < 700) return fix; // on this hole
    const last = derived().shots.at(-1);
    return last?.start ?? ch().tee ?? null;
  }

  function orient(from = aimPoint(), force = false) {
    if (!map) return false;
    const g = ch().green;
    if (!from || !g) return false;
    if (!force && Date.now() - userMovedAt < 30000) return false; // don't fight a manual pan
    lastFrom = from;
    if (autoRotate && canRotate()) frame(map, from, g);
    else { northUp(map); fit(map, [from, g, ...derived().shots.map((s) => s.start)]); }
    return true;
  }

  function initialFit() {
    if (!map) return;
    if (orient(undefined, true)) { fittedToFix = !!gps.latest(); return; }
    const h = ch();
    const d = derived();
    const pts = [...d.shots.map((s) => s.start), d.greenPos, h.green, h.tee];
    if (!fit(map, pts)) {
      const prev = course.holes[n - 2]?.green;
      if (prev) map.setView(ll(prev), 17);
    } else fittedToFix = true;
  }

  function drawCompass() {
    const b = $('[data-a="rotate"]', root);
    if (!b || !map) return;
    const deg = map.getBearing?.() ?? 0;
    b.querySelector('.compass-n').style.transform = `rotate(${deg}deg)`;
    b.classList.toggle('on', autoRotate);
    b.setAttribute('aria-pressed', String(autoRotate));
    b.setAttribute('aria-label', autoRotate ? 'Map faces the hole. Tap for north up' : 'North up. Tap to face the hole');
  }

  function onMapTap(e) {
    if (!targetFor) {
      measure = { lat: e.latlng.lat, lon: e.latlng.lng };
      vibrate(10);
      drawMeasure();
      return;
    }
    const s = shots.find((x) => x.id === targetFor);
    targetFor = null;
    $('#mapHint', root).hidden = true;
    if (!s) return;
    s.target = { lat: e.latlng.lat, lon: e.latlng.lng };
    db.put('shots', s);
    render();
    toast('Target set');
  }

  async function moveShot(id, p) {
    const s = shots.find((x) => x.id === id);
    if (!s) return;
    s.lat = p.lat; s.lon = p.lng; s.edited = true;
    await db.put('shots', s);
    render();
    toast(`Shot ${derived().shots.find((x) => x.id === id).index + 1} moved`);
  }

  async function moveGreen(p) {
    const h = ch();
    h.green = { lat: p.lat, lon: p.lng, estimated: false };
    await db.put('courses', course);
    render();
    toast('Green centre moved for this course');
  }

  // ---------- measure: me -> point -> green ----------
  // From the live GPS position, or from your last marked shot when there's no fix.
  function measureOrigin() {
    const fix = gps.latest();
    if (fix) return { p: fix, label: 'you' };
    const last = derived().shots.at(-1);
    return last ? { p: last.start, label: 'last shot' } : null;
  }

  function drawMeasure() {
    const card = $('#measure', root);
    const tip = $('#measureTip', root);
    if (tip) tip.hidden = !!measure || !map;
    if (!map) return;
    measureLayer.clearLayers();
    if (!measure) { card.hidden = true; return; }
    const o = measureOrigin();
    const g = ch().green;
    const toPt = o ? distance(o.p, measure) : null;
    const toGreen = g ? distance(measure, g) : null;
    const mid = (a, b) => ({ lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 });
    if (o) {
      line([o.p, measure], 'measure-line').addTo(measureLayer);
      pin(mid(o.p, measure), 'seg-label measure-label', `<span>${m(toPt)}</span>`, { interactive: false }).addTo(measureLayer);
    }
    if (g) {
      line([measure, g], 'measure-line second').addTo(measureLayer);
      pin(mid(measure, g), 'seg-label measure-label', `<span>${m(toGreen)}</span>`, { interactive: false }).addTo(measureLayer);
    }
    pin(measure, 'measure', '<span></span>', { draggable: true, title: 'Measure point (drag to move)' })
      .on('drag', (e) => { const p = e.target.getLatLng(); measure = { lat: p.lat, lon: p.lng }; drawMeasureCard(); })
      .on('dragend', () => drawMeasure())
      .addTo(measureLayer);
    drawMeasureCard();
  }

  function drawMeasureCard() {
    const card = $('#measure', root);
    const o = measureOrigin();
    const g = ch().green;
    const toPt = o ? distance(o.p, measure) : null;
    const toGreen = g ? distance(measure, g) : null;
    card.hidden = false;
    card.innerHTML = `
      <div class="mc-cell"><b>${o ? m(toPt) : '–'}</b><i>${o ? `From ${o.label}` : 'No GPS fix'}</i></div>
      ${g ? `<div class="mc-cell"><b>${m(toGreen)}</b><i>Then to green</i></div>` : ''}
      <button class="mc-close" data-a="clearmeasure" aria-label="Clear measure point">×</button>`;
  }

  // ---------- live position + yardage ----------
  const unsub = gps.subscribe((fix, err) => {
    if (err) {
      if (err.code === 1) $('#yardage', root).innerHTML = `<div class="yd-note">Location is off for this site. Allow it in Settings › Privacy › Location Services › Safari Websites.</div>`;
      return;
    }
    if (map) {
      if (!me) {
        meAcc = window.L.circle(ll(fix), { radius: fix.accuracy, className: 'me-acc', interactive: false }).addTo(map);
        me = window.L.circleMarker(ll(fix), { radius: 7, className: 'me', interactive: false }).addTo(map);
      } else { me.setLatLng(ll(fix)); meAcc.setLatLng(ll(fix)).setRadius(fix.accuracy); }
      if (!fittedToFix) {
        fittedToFix = true;
        if (!orient(undefined, true)) {
          const h = ch();
          if (!fit(map, [fix, h.green, h.tee])) map.setView(ll(fix), 18);
        }
      } else if (lastFrom && ch().green && distance(fix, ch().green) < 700 && distance(fix, lastFrom) > 30) {
        orient(fix); // walked to the ball: re-aim, unless they've just panned
      }
    }
    drawYardage();
    if (measure) drawMeasure();
  });

  function drawYardage() {
    const el = $('#yardage', root);
    const fix = gps.latest();
    const h = ch();
    if (!h.green) {
      el.innerHTML = `<div class="yd-note">No green for this hole yet. Tap <b>On green</b> when you reach it, or drag the map and set it under Courses.</div>`;
      return;
    }
    if (!fix) { el.innerHTML = `<div class="yd-note">Finding GPS…</div>`; return; }
    const c = distance(fix, h.green);
    const f = h.front ? distance(fix, h.front) : null;
    const b = h.back ? distance(fix, h.back) : null;
    el.innerHTML = `
      ${f != null ? `<div class="yd small"><span>${m(f)}</span><i>Front</i></div>` : ''}
      <div class="yd"><span>${m(c)}</span><i>${h.green.estimated ? 'Green (approx.)' : 'Centre'}</i></div>
      ${b != null ? `<div class="yd small"><span>${m(b)}</span><i>Back</i></div>` : ''}
      <div class="yd-acc">±${Math.round(fix.accuracy)} m</div>`;
  }

  // ---------- lists and stats ----------
  function drawShots() {
    const d = derived();
    const el = $('#shots', root);
    if (!d.shots.length) {
      el.innerHTML = `<li class="shot-empty">No shots yet. On the tee, tap <b>Mark ball</b>, then hit.</li>`;
      return;
    }
    el.innerHTML = d.shots.map((s) => `
      <li><button class="shot-row" data-a="shot" data-id="${s.id}">
        <span class="shot-n">${s.index + 1}</span>
        <span class="shot-club ${s.club ? '' : 'unset'}">${esc(s.club ?? 'Club')}</span>
        <span class="shot-dist">${s.dist ? `${Math.round(s.dist)} m` : '–'}${s.endKind === 'green-centre' ? '<sup>*</sup>' : ''}</span>
        <span class="shot-res ${s.onGreen && s.approach ? 'good' : ''}">${esc(s.result || '')}${s.penalty ? ' <em class="pen">Penalty</em>' : ''}${s.mishit ? ' <em>Mishit</em>' : ''}</span>
      </button></li>`).join('') +
      (d.shots.some((s) => s.endKind === 'green-centre') ? `<li class="shot-foot">* to green centre. Tap <b>On green</b> to measure to your ball.</li>` : '');
  }

  function drawStats() {
    const d = derived();
    const h = hs();
    const par = ch().par;
    const stepper = (key, label, val) => `
      <div class="stepper">
        <span class="st-label">${label}</span>
        <button class="st-btn" data-a="dec" data-k="${key}" aria-label="Less ${label}">−</button>
        <span class="st-val">${val}</span>
        <button class="st-btn" data-a="inc" data-k="${key}" aria-label="More ${label}">+</button>
      </div>`;
    const name = d.toPar != null ? SCORE_NAMES[d.toPar] ?? (d.toPar > 0 ? `+${d.toPar}` : `${d.toPar}`) : '';
    $('#hstats', root).innerHTML = `
      <div class="stat-block">
        <span class="sb-label">Putts</span>
        <div class="seg putts" role="group" aria-label="Putts">
          ${[0, 1, 2, 3, 4].map((p) => `<button data-a="putts" data-v="${p}" class="${h.putts === p ? 'on' : ''}">${p === 4 && (h.putts ?? 0) > 4 ? h.putts : p}${p === 4 ? '+' : ''}</button>`).join('')}
        </div>
      </div>
      ${(h.putts ?? 0) > 0 ? `
      <div class="stat-block">
        <span class="sb-label">First putt length <small>(optional, for putting stats)</small></span>
        <div class="seg fp" role="group" aria-label="First putt length in metres">
          ${FIRST_PUTT.map(([v, t]) => `<button data-a="fp" data-v="${v}" class="${h.firstPutt === v ? 'on' : ''}">${t}</button>`).join('')}
        </div>
      </div>` : ''}
      ${par >= 4 ? `
      <div class="stat-block">
        <span class="sb-label">Tee shot${d.fairwayAuto ? ' <small>(from target)</small>' : ''}</span>
        <div class="seg fw" role="group" aria-label="Fairway">
          ${FAIRWAY.map(([v, t]) => `<button data-a="fw" data-v="${v}" class="${d.fairway === v ? (d.fairwayAuto ? 'auto' : 'on') : ''}">${t}</button>`).join('')}
        </div>
      </div>` : ''}
      <div class="steppers">
        ${stepper('chips', 'Chips', h.chips)}
        ${stepper('bunker', 'Bunker', h.bunker)}
        ${stepper('penalties', 'Penalties', h.penalties)}
      </div>
      <button class="score-line" data-a="score">
        <span>Score</span>
        <b class="${d.toPar > 0 ? 'over' : d.toPar < 0 ? 'under' : ''}">${d.score ?? '–'}</b>
        <span class="score-name">${d.complete ? name : d.started ? 'enter putts to finish' : ''}${h.score != null ? ' · edited' : ''}</span>
      </button>`;
  }

  async function drawRoundScore() {
    const r = deriveRound(course, round, shots);
    $('#roundScore', root).textContent = r.holesPlayed ? `${signed(r.toPar)} thru ${r.holesPlayed}` : '';
  }

  function render() { drawMap(); drawShots(); drawStats(); drawYardage(); drawMeasure(); drawRoundScore(); }

  async function save() { await db.put('rounds', round); render(); }

  // ---------- actions ----------
  async function markBall() {
    const btn = $('[data-a="mark"]', root);
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('busy');
    const sub = $('#markSub', root);
    sub.textContent = 'Getting a fix…';
    try {
      const pos = await gps.sample({ onProgress: (k, acc) => { sub.textContent = `Fix ${k} · ±${Math.round(acc)} m`; } });
      const prev = holeShots().sort((a, b) => b.seq - a.seq)[0];
      if (prev && distance(prev, pos) < 3 && Date.now() - prev.time < 20000) {
        toast('Already marked here');
        return;
      }
      // Read stored shots too, so a second open copy of the app can't reuse a number.
      const stored = await db.shotsForRound(roundId);
      const seq = [...shots, ...stored].reduce((a, s) => Math.max(a, s.seq ?? 0), 0) + 1;
      const shot = {
        id: db.uid(), roundId, hole: n, seq, lat: pos.lat, lon: pos.lon, accuracy: pos.accuracy,
        time: pos.time, club: null, source: 'manual', confidence: null, penalty: false,
        lie: holeShots().length ? null : 'tee', mishit: false, target: null,
      };
      shots.push(shot);
      await db.put('shots', shot);
      vibrate();
      render();
      if (map && !orient(pos, true) && !map.getBounds().contains(ll(pos))) fit(map, [...derived().shots.map((s) => s.start), ch().green]);
      toast(pos.accuracy > 12 ? `Shot ${holeShots().length} marked, weak GPS ±${Math.round(pos.accuracy)} m. Drag it on the map if it's off.` : `Shot ${holeShots().length} marked`, pos.accuracy > 12 ? 'warn' : '');
    } catch (e) {
      toast(e.message, 'warn');
    } finally {
      btn.disabled = false;
      btn.classList.remove('busy');
      sub.textContent = 'Stand at your ball before you hit';
    }
  }

  async function onGreen() {
    const btn = $('[data-a="ongreen"]', root);
    btn.disabled = true;
    btn.textContent = 'Locating…';
    try {
      const pos = await gps.sample({ maxMs: 5000 });
      hs().greenPos = { lat: pos.lat, lon: pos.lon, accuracy: pos.accuracy };
      const h = ch();
      if (!h.green) {
        h.green = { lat: pos.lat, lon: pos.lon, estimated: true };
        await db.put('courses', course);
        toast('Ball on green. Green saved for this course; drag the flag to its centre.');
      } else toast('Ball on green');
      vibrate();
      await save();
    } catch (e) {
      toast(e.message, 'warn');
    } finally {
      btn.disabled = false;
      btn.textContent = 'On green';
    }
  }

  function openShot(id) {
    const d = derived();
    const s = d.shots.find((x) => x.id === id);
    if (!s) return;
    const raw = shots.find((x) => x.id === id);
    sheet(`
      <h3 class="sheet-title">Shot ${s.index + 1}${s.dist ? ` · ${Math.round(s.dist)} m` : ''}</h3>
      ${s.result ? `<p class="sheet-sub">${esc(s.result)}</p>` : ''}
      <p class="sheet-label">Club</p>
      <div class="chips clubs">${bag.map((c) => `<button data-club="${esc(c)}" class="${raw.club === c ? 'on' : ''}">${esc(c)}</button>`).join('')}</div>
      <p class="sheet-label">Lie</p>
      <div class="chips">${LIES.map(([v, t]) => `<button data-lie="${v}" class="${raw.lie === v ? 'on' : ''}">${t}</button>`).join('')}</div>
      <div class="toggles">
        <label><input type="checkbox" data-t="penalty" ${raw.penalty ? 'checked' : ''}> Penalty on this shot <small>adds 1 stroke</small></label>
        <label><input type="checkbox" data-t="mishit" ${raw.mishit ? 'checked' : ''}> Mishit <small>left out of club distances</small></label>
      </div>
      <div class="sheet-row wrap">
        <button class="btn ghost" data-x="target">${raw.target ? 'Move target' : 'Set target on map'}</button>
        ${raw.target ? '<button class="btn ghost" data-x="cleartarget">Clear target</button>' : ''}
        <button class="btn ghost danger-text" data-x="delete">Delete shot</button>
        <button class="btn primary" data-x="done">Done</button>
      </div>
      <p class="sheet-note">GPS ±${Math.round(raw.accuracy ?? 0)} m${raw.edited ? ' · moved by hand' : ''}. Drag the shot's dot on the map to correct it.</p>`,
    (el, close) => {
      el.addEventListener('click', async (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.club) {
          raw.club = raw.club === b.dataset.club ? null : b.dataset.club;
          await db.put('shots', raw);
          render();
          close();
        } else if (b.dataset.lie) {
          raw.lie = raw.lie === b.dataset.lie ? null : b.dataset.lie;
          el.querySelectorAll('[data-lie]').forEach((x) => x.classList.toggle('on', x.dataset.lie === raw.lie));
          await db.put('shots', raw);
        } else if (b.dataset.x === 'done') close();
        else if (b.dataset.x === 'target') {
          close();
          targetFor = id;
          const hint = $('#mapHint', root);
          hint.textContent = 'Tap the map where you were aiming';
          hint.hidden = false;
          $('#map', root).scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else if (b.dataset.x === 'cleartarget') {
          raw.target = null; await db.put('shots', raw); render(); close();
        } else if (b.dataset.x === 'delete') {
          close();
          if (await confirmSheet(`Delete shot ${s.index + 1}?`, 'Delete shot')) {
            shots = shots.filter((x) => x.id !== id);
            await db.del('shots', id);
            render();
            toast('Shot deleted');
          }
        }
      });
      el.addEventListener('change', async (e) => {
        const t = e.target.dataset.t;
        if (!t) return;
        raw[t] = e.target.checked;
        if (t === 'penalty') hs().penalties = Math.max(0, (hs().penalties ?? 0) + (raw.penalty ? 1 : -1));
        await db.put('shots', raw);
        await save();
      });
    });
  }

  function editScore() {
    const d = derived();
    let v = d.score ?? ch().par;
    sheet(`
      <h3 class="sheet-title">Score for hole ${n}</h3>
      <p class="sheet-sub">Worked out from ${holeShots().length} shots + putts + penalties. Change it only if the count is wrong.</p>
      <div class="big-stepper"><button data-s="-1" aria-label="One less">−</button><b id="sv">${v}</b><button data-s="1" aria-label="One more">+</button></div>
      <div class="sheet-row">
        <button class="btn ghost" data-s="auto">Use calculated</button>
        <button class="btn primary" data-s="save">Save score</button>
      </div>`,
    (el, close) => {
      el.addEventListener('click', async (e) => {
        const a = e.target.closest('[data-s]')?.dataset.s;
        if (!a) return;
        if (a === 'auto') { hs().score = null; await save(); close(); }
        else if (a === 'save') { hs().score = v; await save(); close(); }
        else { v = Math.max(1, v + Number(a)); el.querySelector('#sv').textContent = v; }
      });
    });
  }

  async function go(delta) {
    const next = n + delta;
    if (next > course.holes.length) { location.hash = `#/round/${roundId}/card`; return; }
    if (next >= 1) location.hash = `#/round/${roundId}/hole/${next}`;
  }

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b || !root.contains(b)) return;
    const a = b.dataset.a;
    const h = hs();
    if (a === 'mark') markBall();
    else if (a === 'ongreen') onGreen();
    else if (a === 'prev') go(-1);
    else if (a === 'next') go(1);
    else if (a === 'shot') openShot(b.dataset.id);
    else if (a === 'score') editScore();
    else if (a === 'fullscreen') {
      const on = !document.body.classList.contains('map-full');
      setFull(on);
      db.setSetting('mapFull', on); // stays full-screen on the next hole
    }
    else if (a === 'greenview') {
      const last = derived().shots.at(-1);
      const vp = viewPoint({ fix: gps.latest(), lastShot: last?.start, shape: ch().shape, tee: ch().tee, green: ch().green });
      openGreenSheet({ course, hole: n, from: vp?.p, fromLabel: vp?.label, ball: hs().greenPos, onUpdated: () => render() });
    }
    else if (a === 'rotate') {
      autoRotate = !autoRotate;
      db.setSetting('mapRotate', autoRotate);
      if (!orient(undefined, true)) northUp(map);
      if (!autoRotate) northUp(map);
      drawCompass();
      toast(autoRotate ? 'Map faces the hole' : 'North up');
    }
    else if (a === 'clearmeasure') { measure = null; drawMeasure(); }
    else if (a === 'locate') { const f = gps.latest(); if (f && map) map.setView(ll(f), Math.max(map.getZoom(), 18)); else toast('No GPS fix yet'); }
    else if (a === 'putts') {
      const v = Number(b.dataset.v);
      if (v === 4 && (h.putts ?? 0) >= 4) h.putts += 1;
      else h.putts = h.putts === v ? null : v;
      vibrate(); await save();
    } else if (a === 'fp') {
      const v = Number(b.dataset.v);
      h.firstPutt = h.firstPutt === v ? null : v;
      vibrate(); await save();
    } else if (a === 'fw') { h.fairway = h.fairway === b.dataset.v ? null : b.dataset.v; vibrate(); await save(); }
    else if (a === 'inc' || a === 'dec') {
      const k = b.dataset.k;
      h[k] = Math.max(0, (h[k] ?? 0) + (a === 'inc' ? 1 : -1));
      vibrate(); await save();
    }
  });

  // Full-screen map: the map fills the screen above Mark ball / On green.
  // CSS only, because iPhone Safari has no Fullscreen API for page elements.
  function setFull(on) {
    root.querySelector('.hole').classList.toggle('map-full', on);
    document.body.classList.toggle('map-full', on);
    const b = $('[data-a="fullscreen"]', root);
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', on ? 'Exit full-screen map' : 'Full-screen map');
    b.innerHTML = on ? `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>` : `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    if (map) setTimeout(() => { map.invalidateSize(); if (lastFrom) orient(lastFrom, true); }, 0);
  }
  db.getSetting('mapFull', false).then((on) => on && setFull(true));

  render();
  initialFit();
  drawCompass();

  return {
    destroy() {
      unsub();
      document.body.classList.remove('map-full');
      map?.remove();
    },
  };
}
