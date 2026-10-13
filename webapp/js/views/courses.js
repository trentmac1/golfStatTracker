// Courses: list, edit pars, and place greens/tees on the satellite map.
import * as db from '../db.js';
import { newCourse, DEFAULT_CENTRE } from '../config.js';
import { distance } from '../geo.js';
import { createMap, pin, circle, fit, ll, hasMap } from '../map.js';
import { greenRadius } from '../stats.js';
import * as gps from '../gps.js';
import { $, esc, toast, confirmSheet } from '../ui.js';
import { downloadGreens } from './green.js';
import { holePreview } from './holeart.js';
import { searchCourses, nearbyCourses, loadCourseOsm, holesFromOsm } from '../greens.js';
import { searchScorecards, getScorecard, applyScorecard } from '../scorecards.js';
import { sheet } from '../ui.js';
import { markEdited } from '../coursemerge.js';
import * as share from '../share.js';

// Every hole drawn from its map, tee at the bottom. Tapping one opens it on
// the map editor.
function previewGrid(course, courseId) {
  const tiles = course.holes.map((h) => ({ h, p: holePreview(h) }));
  if (!tiles.some((t) => t.p.svg)) return '';
  const est = tiles.filter((t) => t.p.estimated).map((t) => t.h.n);
  const fairways = course.holes.filter((h) => h.features?.fairways?.length).length;
  return `
        <h2>Hole previews</h2>
        <div class="hole-grid course-holes">${tiles.map(({ h, p }) => `
          <a class="ht" href="#/course/${courseId}/map/${h.n}" aria-label="Hole ${h.n}, par ${h.par}${p.length ? `, ${p.length} metres` : ''}">
            ${p.svg || '<div class="ht-empty">No tee or green yet</div>'}
            <span class="ht-n">${h.n}</span>
            <span class="ht-par">Par ${h.par}${p.length ? ` · ${h.metres ?? p.length} m` : ''}</span>
          </a>`).join('')}</div>
        <p class="note">${est.length
          ? `Lighter, outlined fairways are estimates (hole${est.length === 1 ? '' : 's'} ${est.join(', ')}). Trace them in OpenStreetMap, then tap Refresh hole maps above to replace them.`
          : fairways ? 'Fairways, tees, bunkers and water from OpenStreetMap.' : ''}
          ${course.holes.some((h) => h.shape || h.features) ? '' : ' Tap Get hole maps above for fairways and green outlines.'}</p>`;
}

export async function coursesView(root) {
  const courses = (await db.all('courses')).sort((a, b) => a.name.localeCompare(b.name));
  root.innerHTML = `
    <section class="page">
      <header class="page-head"><a class="back" href="#/">‹ Home</a><h1>Courses</h1></header>
      <ul class="course-list">${courses.map((c) => {
        const set = c.holes.filter((h) => h.green).length;
        return `<li><a href="#/course/${c.id}"><span>${esc(c.name)}<small>Par ${c.holes.reduce((a, h) => a + h.par, 0)} · ${set}/${c.holes.length} greens set</small></span><i>›</i></a></li>`;
      }).join('')}</ul>
      <h2>Add a course</h2>
      <form class="find-form" id="findForm">
        <input id="findQ" type="search" placeholder="Course name" autocomplete="off" enterkeyhint="search" aria-label="Course name">
        <button class="btn primary" type="submit">Search</button>
      </form>
      <button class="btn ghost wide" data-a="near">Courses near me</button>
      <ul class="course-list find-results" id="found"></ul>
      <p class="note" id="findMsg">Courses come from OpenStreetMap with their holes, pars, tees and green outlines filled in where the map has them.</p>
      <button class="btn ghost wide" data-a="new">Add a blank course instead</button>
    </section>`;

  let results = [];
  const showResults = (list, empty) => {
    results = list;
    $('#found', root).innerHTML = list.map((r, i) => `
      <li><button data-pick="${i}"><span>${esc(r.name)}<small>${esc([r.where, r.km != null ? `${r.km.toFixed(1)} km away` : ''].filter(Boolean).join(' · '))}</small></span><i>Add</i></button></li>`).join('');
    $('#findMsg', root).textContent = list.length ? 'Tap a course to add it.' : empty;
  };
  const busy = (msg) => { $('#findMsg', root).textContent = msg; };

  $('#findForm', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('#findQ', root).value.trim();
    if (q.length < 3) { busy('Type at least 3 letters of the course name.'); return; }
    busy('Searching…');
    // Search around where you are, or around your other courses.
    const fix = gps.latest();
    const centres = courses.map((c) => c.centre).filter(Boolean);
    const near = fix ? { lat: fix.lat, lon: fix.lon }
      : centres.length ? { lat: centres.reduce((a, c) => a + c.lat, 0) / centres.length, lon: centres.reduce((a, c) => a + c.lon, 0) / centres.length } : null;
    try { showResults(await searchCourses(q, { near }), `No golf course matching "${q}" on the map. Try part of the club's name, Courses near me, or a blank course.`); }
    catch (err) { busy(err.message); }
  });

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.a === 'new') {
      const c = newCourse(db.uid(), 'New course');
      c.holes.forEach((h) => { h.parEstimated = true; });   // guesses until set
      const fix = gps.latest();
      if (fix) c.centre = { lat: fix.lat, lon: fix.lon };
      await db.put('courses', c);
      location.hash = `#/course/${c.id}`;
    } else if (b.dataset.a === 'near') {
      busy('Finding where you are…');
      try {
        const pos = await gps.sample({ maxMs: 6000, want: 1, goodAcc: 100 });
        busy('Looking for courses nearby…');
        showResults(await nearbyCourses(pos), 'No golf courses mapped within 25 km.');
      } catch (err) { busy(err.message); }
    } else if (b.dataset.pick) {
      const place = results[Number(b.dataset.pick)];
      const existing = courses.find((c) => c.name.toLowerCase() === place.name.toLowerCase());
      if (existing && !(await confirmSheet(`You already have ${existing.name}. Add another copy?`, 'Add copy', false))) {
        location.hash = `#/course/${existing.id}`; return;
      }
      root.querySelectorAll('[data-pick]').forEach((x) => { x.disabled = true; });
      const course = await addCourseFromMap(place, busy);
      if (course) location.hash = `#/course/${course.id}`;
      else root.querySelectorAll('[data-pick]').forEach((x) => { x.disabled = false; });
    }
  });
  return {};
}

// Build a course from OpenStreetMap: holes, pars, tees, greens, slopes.
export async function addCourseFromMap(place, say = () => {}) {
  try {
    say(`Getting ${place.name} from OpenStreetMap…`);
    const osm = await loadCourseOsm(place);
    const holes = holesFromOsm(osm);
    const course = newCourse(db.uid(), place.name, holes ? holes.map((h) => h.par) : Array(18).fill(4), place.centre, holes ? holes.map((h) => h.si) : []);
    if (holes) holes.forEach((h, i) => {
      course.holes[i].tee = h.tee;
      if (h.parEstimated) course.holes[i].parEstimated = true;
      if (h.green) course.holes[i].green = { ...h.green, estimated: true, fromHoleLine: true };
    });
    course.source = 'osm';
    // Greens and tees other players have placed on this course.
    const fromOthers = await share.pullForNewCourse(course);
    await db.put('courses', course);
    if (!holes && !fromOthers?.text) {
      toast(`${place.name} added. Its holes aren't numbered on the map, so set pars and greens yourself.`, 'warn');
      return course;
    }
    await downloadGreens(course, say, { osm });
    if (fromOthers?.text) {
      toast(`${course.name} added, with ${fromOthers.text} from other players.`);
      course.importNotes = [];
      await db.put('courses', course);
      return course;
    }
    if (!holes) return course;
    // Tell the player what the map didn't have.
    const notes = [];
    const missing = holes.filter((h) => !h.mapped).length;
    if (missing) notes.push(`${missing} hole${missing === 1 ? ' is' : 's are'} missing from the map`);
    const est = holes.filter((h) => h.parEstimated).length;
    if (est) notes.push(`${est === holes.length ? 'pars are' : `${est} pars are`} estimated from hole lengths (marked est.): check them against the card`);
    else if (holes.some((h) => h.mapped && !h.parMapped)) notes.push('some pars aren\'t on the map, so set them from the card');
    const approx = course.holes.filter((h) => h.green?.estimated).length;
    if (approx) notes.push(`${approx} green${approx === 1 ? ' is' : 's are'} approximate (from the hole lines): tap On green to fix`);
    course.importNotes = notes;
    await db.put('courses', course);
    if (notes.length) toast(`${course.name} added. ${notes[0][0].toUpperCase()}${notes[0].slice(1)}.`, 'warn');
    return course;
  } catch (err) {
    say(err.message); toast(err.message, 'warn');
    return null;
  }
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
        ${course.importNotes?.length ? `<div class="note warn-note">From OpenStreetMap, with gaps: ${course.importNotes.map(esc).join('; ')}.</div>` : ''}
        <a class="btn primary wide" href="#/course/${courseId}/map/1">Place greens on the map</a>
        <button class="btn ghost wide" data-a="share">Update greens, tees and card</button>
        <p class="note" id="sprog">${course.sharedAt ? `Last updated from other players ${new Date(course.sharedAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}.` : 'Brings in the greens, tees, pars, stroke indexes, rating and slope other players have uploaded.'}</p>
        <button class="btn ghost wide" data-a="greens">${course.holes.some((h) => h.shape || h.features) ? 'Refresh' : 'Get'} hole maps and green slopes</button>
        <p class="note" id="gprog">${course.holes.filter((h) => h.shape).length ? `${course.holes.filter((h) => h.shape).length} of ${course.holes.length} greens have shape and slope data, ${course.holes.filter((h) => h.features?.fairways?.length).length} holes have fairways.` : 'Greens, fairways, tees, bunkers and water from OpenStreetMap, and LiDAR heights for Queensland courses. Needs signal once.'}</p>
        ${previewGrid(course, courseId)}
        <h2>Holes</h2>
        <div class="seg small holes-count" role="group" aria-label="Number of holes">
          ${[9, 18, 27, 36].map((v) => `<button data-count="${v}" class="${course.holes.length === v ? 'on' : ''}">${v}</button>`).join('')}
        </div>
        <p class="note">Courses with more than 18 holes are split into nines (1–9, 10–18, 19–27…). You pick which ones when you tee off.</p>
        <h2>Scorecard</h2>
        <button class="btn ghost wide" data-a="lookup">Look up scorecard</button>
        <p class="note">${course.scorecard ? `From GolfCourseAPI: ${esc(course.scorecard.name)}, ${esc(course.scorecard.tee)} tees${course.scorecard.from > 1 ? `, on holes ${course.scorecard.from} onward` : ''}.` : 'Fills in pars, hole lengths, rating and slope from GolfCourseAPI (needs your key in Backup & settings). Stroke indexes aren\'t in its data, so type those in the table below. Values from a lookup stay on this phone and aren\'t shared.'}</p>
        <h2>Rating for handicap</h2>
        <p class="note">From the scorecard, for the tees you play. Golf Australia cards list them as scratch (or course) rating and slope.</p>
        <div class="rating-row">
          <label>Tees<input id="ctee" value="${esc(course.tee ?? '')}" placeholder="e.g. White" autocomplete="off"></label>
          <label>Rating<input id="crating" inputmode="decimal" value="${course.rating ?? ''}" placeholder="e.g. 68.8"></label>
          <label>Slope<input id="cslope" inputmode="numeric" value="${course.slope ?? ''}" placeholder="e.g. 125"></label>
        </div>
        <table class="par-table">
          <thead><tr><th>Hole</th><th>Par</th><th>Index</th><th>Green</th></tr></thead>
          <tbody>${course.holes.map((h) => `
            <tr><th>${h.n}</th>
              <td><div class="seg tiny ${h.parEstimated ? 'est' : ''}">${[3, 4, 5].map((p) => `<button data-hole="${h.n}" data-par="${p}" class="${h.par === p ? 'on' : ''}">${p}</button>`).join('')}</div>${h.parEstimated ? '<small class="est-tag">est.</small>' : ''}</td>
              <td><input class="si-input" data-si="${h.n}" inputmode="numeric" value="${h.si ?? ''}" aria-label="Stroke index, hole ${h.n}"></td>
              <td><a href="#/course/${courseId}/map/${h.n}" class="green-state ${h.green ? (h.green.estimated ? 'approx' : 'set') : ''}">${h.green ? (h.green.estimated ? 'Approx.' : 'Set') : 'Not set'}</a></td></tr>`).join('')}
          </tbody></table>
        <button class="btn ghost danger-text wide" data-a="delete">Delete course</button>
      </section>`;
  }
  draw();

  root.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.id === 'cname') {
      course.name = t.value.trim() || 'Untitled course';
      await db.put('courses', course);
      toast('Name saved');
    } else if (t.id === 'ctee') {
      course.tee = t.value.trim();
      markEdited(course, 'tee');
      await db.put('courses', course);
      toast('Tees saved');
    } else if (t.id === 'crating' || t.id === 'cslope') {
      const v = parseFloat(t.value.replace(',', '.'));
      const [key, lo, hi] = t.id === 'crating' ? ['rating', 50, 85] : ['slope', 55, 155];
      if (t.value.trim() === '') course[key] = null;
      else if (!Number.isFinite(v) || v < lo || v > hi) { toast(`${key === 'rating' ? 'Rating' : 'Slope'} should be between ${lo} and ${hi}`, 'warn'); t.value = course[key] ?? ''; return; }
      else course[key] = key === 'slope' ? Math.round(v) : Math.round(v * 10) / 10;
      markEdited(course, key);
      await db.put('courses', course);
      toast(`${key === 'rating' ? 'Rating' : 'Slope'} saved`);
    } else if (t.dataset.si) {
      const v = parseInt(t.value, 10);
      const h = course.holes[Number(t.dataset.si) - 1];
      h.si = Number.isFinite(v) && v >= 1 && v <= course.holes.length ? v : null;
      t.value = h.si ?? '';
      markEdited(h, 'si');
      await db.put('courses', course);
    }
  });
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.par) {
      const hh = course.holes[Number(b.dataset.hole) - 1];
      hh.par = Number(b.dataset.par);
      delete hh.parEstimated;
      markEdited(hh, 'par');
      await db.put('courses', course);
      draw();
    } else if (b.dataset.a === 'lookup') {
      const key = await db.getSetting('gcaKey', '');
      if (!key) { toast('Add your GolfCourseAPI key in Backup & settings first.', 'warn'); return; }
      lookupSheet(course, key, () => draw());
    } else if (b.dataset.count) {
      const want = Number(b.dataset.count);
      const have = course.holes.length;
      if (want === have) return;
      if (want < have) {
        const usedHoles = new Set(rounds.flatMap((r) => [...(r.holeList ?? []), ...Object.keys(r.holes ?? {}).map(Number)]));
        const lost = course.holes.slice(want).filter((h) => usedHoles.has(h.n)).map((h) => h.n);
        if (lost.length) { toast(`Rounds use holes ${lost[0]}–${lost.at(-1)}, so they can't be removed.`, 'warn'); return; }
        if (!(await confirmSheet(`Remove holes ${want + 1}–${have} and anything set on them?`, 'Remove holes'))) return;
        course.holes = course.holes.slice(0, want);
      } else {
        for (let n = have + 1; n <= want; n++) course.holes.push({ n, par: 4, parEstimated: true, si: null, green: null, front: null, back: null, tee: null });
      }
      delete course.lastLayout;
      markEdited(course, 'holes');
      await db.put('courses', course);
      toast(`${course.name} now has ${want} holes`);
      draw();
    } else if (b.dataset.a === 'share') {
      const el = $('#sprog', root);
      b.disabled = true;
      if (el) el.textContent = 'Updating…';
      try {
        const r = await share.pullCourse(course);
        if (!r.found) {
          toast("Nobody has uploaded this course yet. Use Update courses in Backup to share yours.", 'warn');
          if (el) el.textContent = 'Not on the course server yet.';
          return;
        }
        toast(`${r.text ? `Updated ${r.text}` : 'Already up to date'}. ${r.counts}.`);
        if (r.summary.holesAdded) delete course.lastLayout;
        if (r.summary.moved.length) {
          if (el) el.textContent = 'Getting the outlines for moved greens…';
          await downloadGreens(course, (m) => { const e2 = $('#sprog', root); if (e2) e2.textContent = m; });
        }
        draw();
      } catch (err) {
        toast(err.message, 'warn');
        if (el) el.textContent = err.message;
      } finally { b.disabled = false; }
    } else if (b.dataset.a === 'greens') {
      b.disabled = true;
      await downloadGreens(course, (msg) => { const el = $('#gprog', root); if (el) el.textContent = msg; });
      b.disabled = false;
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
      markEdited(h, b.dataset.p);
      await db.put('courses', course);
      draw();
      toast(`${b.textContent} saved`);
    } else if (b.dataset.a === 'here') {
      let f;
      try { b.disabled = true; f = await gps.sample({ maxMs: 5000 }); }
      catch (err) { toast(err.message, 'warn'); return; }
      finally { b.disabled = false; }
      h.green = { lat: f.lat, lon: f.lon, estimated: false };
      markEdited(h, 'green');
      map.setView(ll(f), 19);
      await db.put('courses', course);
      draw();
      toast('Green centre saved');
    } else if (b.dataset.a === 'clear') {
      if (await confirmSheet(`Clear the green and tee for hole ${n}?`, 'Clear hole')) {
        h.green = h.front = h.back = h.tee = null;
        delete h.shape;
        markEdited(h, 'green', 'front', 'back', 'tee');
        await db.put('courses', course);
        draw();
      }
    }
  });
  return { destroy() { map.remove(); } };
}

// Search GolfCourseAPI, pick the course and tee, apply the card.
function lookupSheet(course, key, onDone) {
  const near = course.centre ?? course.holes.find((h) => h.green)?.green ?? null;
  let results = [], picked = null;
  sheet(`
    <h3 class="sheet-title">Look up scorecard</h3>
    <form class="find-form" id="lkForm">
      <input id="lkQ" type="search" value="${esc(course.name.replace(/\b(golf|country|club|course|inc\.?)\b/gi, '').replace(/\s+/g, ' ').trim())}" aria-label="Course name" enterkeyhint="search">
      <button class="btn primary" type="submit">Search</button>
    </form>
    <div id="lkBody"><p class="sheet-note">Each search uses one of your daily lookups.</p></div>`,
  (el, close) => {
    const body = el.querySelector('#lkBody');
    const say = (t) => { body.innerHTML = `<p class="sheet-note">${esc(t)}</p>`; };
    const showCourses = () => {
      body.innerHTML = results.length ? `<ul class="course-list find-results">${results.map((r, i) => `
        <li><button data-lk="${i}"><span>${esc(r.name)}<small>${esc([r.where, r.km != null ? `${r.km.toFixed(1)} km away` : '', `${r.teeCount} tee${r.teeCount === 1 ? '' : 's'}`].filter(Boolean).join(' · '))}</small></span><i>Pick</i></button></li>`).join('')}</ul>`
        : '<p class="sheet-note">No match. Try the club name only, or the suburb.</p>';
    };
    const showTees = () => {
      const N = course.holes.length;
      const starts = [1, 10, 19, 28].filter((s) => s + Math.min(...picked.tees.map((t) => t.holes.length)) - 1 <= N);
      body.innerHTML = `
        <p class="sheet-label">${esc(picked.name)}: which tees?</p>
        <ul class="course-list find-results">${picked.tees.map((t, i) => `
          <li><button data-tee="${i}"><span>${esc(t.name)} <small>${t.gender === 'female' ? 'women' : 'men'} · ${t.holes.length} holes · par ${t.par}${t.metres ? ` · ${t.metres.toLocaleString()} m` : ''}${t.rating ? ` · rating ${t.rating}` : ''}${t.slope ? ` / slope ${t.slope}` : ''}</small></span><i>Use</i></button></li>`).join('')}</ul>
        ${starts.length > 1 ? `<p class="sheet-label">Fill from hole</p><div class="seg small" id="lkFrom">${starts.map((s, i) => `<button data-from="${s}" class="${i === 0 ? 'on' : ''}">${s}</button>`).join('')}</div>` : ''}`;
    };
    el.querySelector('#lkForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const q = el.querySelector('#lkQ').value.trim();
      if (q.length < 3) { say('Type at least 3 letters.'); return; }
      say('Searching…');
      try { results = (await searchScorecards(q, { key, near })); showCourses(); } catch (err) { say(err.message); }
    });
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.lk) {
        picked = results[Number(b.dataset.lk)];
        if (!picked.tees.length) {
          say('Getting the full scorecard…');
          try { picked = { ...picked, ...(await getScorecard(picked.id, { key })) }; } catch (err) { say(err.message); return; }
          if (!picked.tees.length) { say("GolfCourseAPI has no hole-by-hole card for this course."); return; }
        }
        showTees();
      } else if (b.dataset.from) {
        el.querySelectorAll('[data-from]').forEach((x) => x.classList.toggle('on', x === b));
      } else if (b.dataset.tee) {
        const tee = picked.tees[Number(b.dataset.tee)];
        const from = Number(el.querySelector('[data-from].on')?.dataset.from ?? 1);
        const n = applyScorecard(course, picked, tee, from);
        await db.put('courses', course);
        toast(`Filled ${n} holes from the ${tee.name} card${tee.rating && tee.slope ? ', with rating and slope' : ''}${tee.holes.some((h) => h.si) ? '' : '. Add stroke indexes from the card'}`);
        close(); onDone?.();
      }
    });
  });
}
