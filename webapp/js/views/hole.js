// Hole view: map, Mark ball, On green, shot list and the hole's stats.
import * as db from '../db.js';
import * as gps from '../gps.js';
import { distance } from '../geo.js';
import { deriveHole, deriveRound, emptyHoleStat } from '../stats.js';
import { createMap, pin, line, circle, fit, ll, hasMap } from '../map.js';
import { DEFAULT_BAG, LIES, DEFAULT_CENTRE } from '../config.js';
import { $, esc, m, signed, toast, vibrate, sheet, confirmSheet } from '../ui.js';

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
      <div class="map-hint" id="mapHint" hidden></div>
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

  if (hasMap()) {
    map = createMap($('#map', root), course.centre ?? DEFAULT_CENTRE, 17);
    layer = window.L.layerGroup().addTo(map);
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
      circle(h.green, d.radius, 'green-ring').addTo(layer);
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

  function initialFit() {
    if (!map) return;
    const h = ch();
    const d = derived();
    const pts = [...d.shots.map((s) => s.start), d.greenPos, h.green, h.tee];
    if (!fit(map, pts)) {
      const prev = course.holes[n - 2]?.green;
      if (prev) map.setView(ll(prev), 17);
    } else fittedToFix = true;
  }

  function onMapTap(e) {
    if (!targetFor) return;
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
        const h = ch();
        if (!fit(map, [fix, h.green, h.tee])) map.setView(ll(fix), 18);
      }
    }
    drawYardage();
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

  function render() { drawMap(); drawShots(); drawStats(); drawYardage(); drawRoundScore(); }

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
      const seq = shots.reduce((a, s) => Math.max(a, s.seq ?? 0), 0) + 1;
      const shot = {
        id: db.uid(), roundId, hole: n, seq, lat: pos.lat, lon: pos.lon, accuracy: pos.accuracy,
        time: pos.time, club: null, source: 'manual', confidence: null, penalty: false,
        lie: holeShots().length ? null : 'tee', mishit: false, target: null,
      };
      shots.push(shot);
      await db.put('shots', shot);
      vibrate();
      render();
      if (map && !map.getBounds().contains(ll(pos))) fit(map, [...derived().shots.map((s) => s.start), ch().green]);
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
    else if (a === 'locate') { const f = gps.latest(); if (f && map) map.setView(ll(f), Math.max(map.getZoom(), 18)); else toast('No GPS fix yet'); }
    else if (a === 'putts') {
      const v = Number(b.dataset.v);
      if (v === 4 && (h.putts ?? 0) >= 4) h.putts += 1;
      else h.putts = h.putts === v ? null : v;
      vibrate(); await save();
    } else if (a === 'fw') { h.fairway = h.fairway === b.dataset.v ? null : b.dataset.v; vibrate(); await save(); }
    else if (a === 'inc' || a === 'dec') {
      const k = b.dataset.k;
      h[k] = Math.max(0, (h[k] ?? 0) + (a === 'inc' ? 1 : -1));
      vibrate(); await save();
    }
  });

  render();
  initialFit();

  return {
    destroy() {
      unsub();
      map?.remove();
    },
  };
}
