// Courses: list, edit pars, and place greens/tees on the satellite map.
import * as db from '../db.js';
import { newCourse, DEFAULT_CENTRE } from '../config.js';
import { distance } from '../geo.js';
import { createMap, pin, circle, fit, ll, hasMap } from '../map.js';
import { greenRadius } from '../stats.js';
import * as gps from '../gps.js';
import { $, esc, toast, confirmSheet } from '../ui.js';

export async function coursesView(root) {
  const courses = (await db.all('courses')).sort((a, b) => a.name.localeCompare(b.name));
  root.innerHTML = `
    <section class="page">
      <header class="page-head"><a class="back" href="#/">‹ Home</a><h1>Courses</h1></header>
      <ul class="course-list">${courses.map((c) => {
        const set = c.holes.filter((h) => h.green).length;
        return `<li><a href="#/course/${c.id}"><span>${esc(c.name)}<small>Par ${c.holes.reduce((a, h) => a + h.par, 0)} · ${set}/${c.holes.length} greens set</small></span><i>›</i></a></li>`;
      }).join('')}</ul>
      <button class="btn primary wide" data-a="new">Add a course</button>
    </section>`;
  root.addEventListener('click', async (e) => {
    if (e.target.closest('[data-a="new"]')) {
      const c = newCourse(db.uid(), 'New course');
      const fix = gps.latest();
      if (fix) c.centre = { lat: fix.lat, lon: fix.lon };
      await db.put('courses', c);
      location.hash = `#/course/${c.id}`;
    }
  });
  return {};
}

export async function courseEditView(root, { courseId }) {
  const course = await db.get('courses', courseId);
  if (!course) { root.innerHTML = '<p class="empty">Course not found.</p>'; return {}; }
  const rounds = await db.byIndex('rounds', 'courseId', courseId);

  function draw() {
    const total = course.holes.reduce((a, h) => a + h.par, 0);
    root.innerHTML = `
      <section class="page">
        <header class="page-head"><a class="back" href="#/courses">‹ Courses</a>
          <input class="title-input" id="cname" value="${esc(course.name)}" aria-label="Course name" autocomplete="off"></header>
        <p class="sub">Par ${total}. Tap a par to change it. Greens and tees can be placed on the map from anywhere.</p>
        <a class="btn primary wide" href="#/course/${courseId}/map/1">Place greens on the map</a>
        <table class="par-table">
          <thead><tr><th>Hole</th><th>Par</th><th>Green</th></tr></thead>
          <tbody>${course.holes.map((h) => `
            <tr><th>${h.n}</th>
              <td><div class="seg tiny">${[3, 4, 5].map((p) => `<button data-hole="${h.n}" data-par="${p}" class="${h.par === p ? 'on' : ''}">${p}</button>`).join('')}</div></td>
              <td><a href="#/course/${courseId}/map/${h.n}" class="green-state ${h.green ? (h.green.estimated ? 'approx' : 'set') : ''}">${h.green ? (h.green.estimated ? 'Approx.' : 'Set') : 'Not set'}</a></td></tr>`).join('')}
          </tbody></table>
        <button class="btn ghost danger-text wide" data-a="delete">Delete course</button>
      </section>`;
  }
  draw();

  root.addEventListener('change', async (e) => {
    if (e.target.id === 'cname') {
      course.name = e.target.value.trim() || 'Untitled course';
      await db.put('courses', course);
      toast('Name saved');
    }
  });
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.par) {
      course.holes[Number(b.dataset.hole) - 1].par = Number(b.dataset.par);
      await db.put('courses', course);
      draw();
    } else if (b.dataset.a === 'delete') {
      if (rounds.length) { toast(`This course has ${rounds.length} rounds. Delete them first.`, 'warn'); return; }
      if (await confirmSheet(`Delete ${course.name}?`, 'Delete course')) {
        await db.del('courses', courseId);
        location.hash = '#/courses';
      }
    }
  });
  return {};
}

// Map editor: pan the crosshair onto a spot and tap a button to drop a point.
export async function courseMapView(root, { courseId, hole }) {
  const course = await db.get('courses', courseId);
  if (!course) { root.innerHTML = '<p class="empty">Course not found.</p>'; return {}; }
  const n = Math.min(Math.max(1, hole), course.holes.length);
  const h = course.holes[n - 1];

  root.innerHTML = `
    <section class="map-editor">
      <header class="hole-head">
        <a class="nav-btn" href="#/course/${courseId}/map/${n - 1}" ${n === 1 ? 'aria-disabled="true" tabindex="-1"' : ''} aria-label="Previous hole">‹</a>
        <div class="hole-title"><span class="hole-no">${n}</span><span class="hole-meta"><b>Par ${h.par}</b><span>${esc(course.name)}</span></span></div>
        <a class="nav-btn" href="${n === course.holes.length ? `#/course/${courseId}` : `#/course/${courseId}/map/${n + 1}`}" aria-label="Next hole">›</a>
      </header>
      <div class="map-wrap tall">
        <div id="map" class="map"></div>
        <div class="crosshair" aria-hidden="true"></div>
        <div class="yardage" id="len"></div>
      </div>
      <p class="hint">Move the map until the cross sits on the spot, then tap what it is.</p>
      <div class="drop-grid">
        <button class="btn primary" data-p="green">Green centre</button>
        <button class="btn ghost" data-p="tee">Tee</button>
        <button class="btn ghost" data-p="front">Green front</button>
        <button class="btn ghost" data-p="back">Green back</button>
      </div>
      <div class="drop-grid">
        <button class="btn ghost" data-a="here">Use my position for green centre</button>
        <button class="btn ghost danger-text" data-a="clear">Clear this hole</button>
      </div>
      <a class="btn ghost wide" href="#/course/${courseId}">Done</a>
    </section>`;

  if (!hasMap()) { $('#map', root).innerHTML = '<p class="map-off">The map needs signal the first time.</p>'; return {}; }
  const prev = course.holes[n - 2];
  const map = createMap($('#map', root), h.green ?? h.tee ?? prev?.green ?? course.centre ?? DEFAULT_CENTRE, 17);
  const layer = window.L.layerGroup().addTo(map);
  if (!fit(map, [h.tee, h.green, h.front, h.back], 19) && prev?.green) map.setView(ll(prev.green), 17);

  function draw() {
    layer.clearLayers();
    if (h.green) {
      circle(h.green, greenRadius(h), 'green-ring').addTo(layer);
      pin(h.green, 'flag', '<span></span>').addTo(layer);
    }
    if (h.front) pin(h.front, 'edge', '').addTo(layer);
    if (h.back) pin(h.back, 'edge', '').addTo(layer);
    if (h.tee) pin(h.tee, 'tee', 'T').addTo(layer);
    $('#len', root).innerHTML = h.tee && h.green
      ? `<div class="yd"><span>${Math.round(distance(h.tee, h.green))}</span><i>Tee to centre</i></div>`
      : `<div class="yd-note">${h.green ? 'Add the tee to see the hole length.' : 'No green yet.'}</div>`;
  }
  draw();

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.p) {
      const c = map.getCenter();
      h[b.dataset.p] = { lat: c.lat, lon: c.lng, ...(b.dataset.p === 'green' ? { estimated: false } : {}) };
      await db.put('courses', course);
      draw();
      toast(`${b.textContent} saved`);
    } else if (b.dataset.a === 'here') {
      let f;
      try { b.disabled = true; f = await gps.sample({ maxMs: 5000 }); }
      catch (err) { toast(err.message, 'warn'); return; }
      finally { b.disabled = false; }
      h.green = { lat: f.lat, lon: f.lon, estimated: false };
      map.setView(ll(f), 19);
      await db.put('courses', course);
      draw();
      toast('Green centre saved');
    } else if (b.dataset.a === 'clear') {
      if (await confirmSheet(`Clear the green and tee for hole ${n}?`, 'Clear hole')) {
        h.green = h.front = h.back = h.tee = null;
        await db.put('courses', course);
        draw();
      }
    }
  });
  return { destroy() { map.remove(); } };
}
