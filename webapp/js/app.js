// App shell: router, home, rounds list and settings.
import * as db from './db.js';
import { deriveRound, ninesOf, nineLabel, layoutLabel } from './stats.js';
import { allCsv } from './export.js';
import { APP_VERSION, BUILT_IN_COURSES, DEFAULT_BAG, newCourse } from './config.js';
import { holeView } from './views/hole.js';
import { cardView } from './views/card.js';
import { reviewView } from './views/review.js';
import { trackerView } from './views/tracker.js';
import { statsView } from './views/stats.js';
import { coursesView, courseEditView, courseMapView } from './views/courses.js';
import { $, esc, signed, fmtDate, toast, saveFile, pickFile, confirmSheet, sheet } from './ui.js';

const ALL_CLUBS = ['Dr', '2W', '3W', '4W', '5W', '7W', '2H', '3H', '4H', '5H', '6H', '2i', '3i', '4i', '5i', '6i', '7i', '8i', '9i', 'PW', 'AW', 'GW', 'SW', 'LW', '50°', '52°', '54°', '56°', '58°', '60°'];

async function seed() {
  let courses = await db.all('courses');
  const seeded = new Set(await db.getSetting('seededCourses', []));
  const rounds = await db.all('rounds');
  const used = new Set(rounds.map((r) => r.courseId));
  for (const c of BUILT_IN_COURSES) {
    const matches = () => courses.filter((x) => x.seedKey === c.key || x.name === c.name);
    if (!seeded.has(c.key)) {
      const existing = matches()[0];
      if (existing) {
        if (!existing.seedKey) { existing.seedKey = c.key; await db.put('courses', existing); }
      } else {
        await db.put('courses', { ...newCourse(db.uid(), c.name, c.pars, c.centre, c.si), seedKey: c.key });
      }
      seeded.add(c.key);
      courses = await db.all('courses');
    }
    // Restoring a backup onto a fresh install leaves an untouched copy of a
    // built-in course next to the restored one: drop copies with no rounds
    // and no greens placed.
    const copies = matches();
    if (copies.length > 1) {
      let keep = copies.filter((x) => used.has(x.id) || x.holes.some((h) => h.green));
      if (!keep.length) keep = [copies[0]]; // all empty: one is enough
      for (const x of copies) if (!keep.includes(x)) await db.del('courses', x.id);
      courses = await db.all('courses');
    }
    // Fill in stroke indexes added in later versions, never overwriting edits.
    for (const x of matches()) {
      if (!c.si || !x.holes.some((h) => h.si == null)) continue;
      x.holes.forEach((h, i) => { if (h.si == null) h.si = c.si[i] ?? null; });
      await db.put('courses', x);
    }
    courses = await db.all('courses');
  }
  await db.setSetting('seededCourses', [...seeded]);
}

async function startRound(courseId, holeList) {
  const round = {
    id: db.uid(), courseId, date: new Date().toISOString(), status: 'active', holes: {}, holeList, currentHole: holeList[0],
  };
  await db.put('rounds', round);
  location.hash = `#/round/${round.id}/hole/${holeList[0]}`;
}

// Pick 18 or 9 holes and which nines. Remembers the last choice per course.
function chooseLayout(course) {
  return new Promise((resolve) => {
    const nines = ninesOf(course);
    const full = nines.filter((nn) => nn.length === 9);
    const last = course.lastLayout ?? {};
    let len = full.length >= 2 ? (last.len ?? 18) : 9;
    let first = Math.min(last.first ?? 0, nines.length - 1);
    let second = last.second ?? (first + 1) % nines.length;
    if (second === first) second = (first + 1) % nines.length;
    let picked = false;
    const par = (nine) => nine.reduce((a, n) => a + course.holes[n - 1].par, 0);
    const seg = (key, chosen, skip) => nines.map((nn, i) => i === skip ? '' : `<button data-${key}="${i}" class="${i === chosen ? 'on' : ''}">${nineLabel(nn)}<small>Par ${par(nn)}</small></button>`).join('');
    const draw = (el) => {
      el.querySelector('#lay').innerHTML = `
        ${full.length >= 2 ? `<p class="sheet-label">Length</p>
        <div class="seg lay-len">${[18, 9].map((v) => `<button data-len="${v}" class="${len === v ? 'on' : ''}">${v} holes</button>`).join('')}</div>` : ''}
        ${nines.length > 1 ? `
        <p class="sheet-label">${len === 18 ? 'First nine' : 'Which nine'}</p>
        <div class="seg lay-nine">${seg('first', first, -1)}</div>
        ${len === 18 && nines.length > 2 ? `<p class="sheet-label">Second nine</p><div class="seg lay-nine">${seg('second', second, first)}</div>` : ''}` : ''}
        <p class="sheet-note">${esc(summary())}</p>`;
    };
    const order = () => len === 18 ? [...nines[first], ...nines[nines.length > 2 ? second : (first + 1) % 2]] : nines[first];
    const summary = () => { const o = order(); return `Holes ${o.length === 18 ? `${nineLabel(nines[first])}, then ${nineLabel(nines[nines.length > 2 ? second : (first + 1) % 2])}` : nineLabel(nines[first])} · par ${o.reduce((a, n) => a + course.holes[n - 1].par, 0)}`; };
    sheet(`
      <h3 class="sheet-title">${esc(course.name)}</h3>
      <div id="lay"></div>
      <div class="sheet-row"><button class="btn ghost" data-l="cancel">Cancel</button><button class="btn primary" data-l="go">Tee off</button></div>`,
    (el, close) => {
      draw(el);
      el.addEventListener('click', async (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.len) len = Number(b.dataset.len);
        else if (b.dataset.first) { first = Number(b.dataset.first); if (second === first) second = (first + 1) % nines.length; }
        else if (b.dataset.second) second = Number(b.dataset.second);
        else if (b.dataset.l === 'cancel') { close(); return; }
        else if (b.dataset.l === 'go') {
          picked = true;
          course.lastLayout = { len, first, second };
          await db.put('courses', course);
          resolve(order()); close(); return;
        }
        draw(el);
      });
      el.addEventListener('close', () => { if (!picked) resolve(null); });
    });
  });
}

async function homeView(root) {
  const [rounds, courses, lastBackup] = await Promise.all([db.all('rounds'), db.all('courses'), db.getSetting('lastBackup', null)]);
  const courseById = new Map(courses.map((c) => [c.id, c]));
  const active = rounds.filter((r) => r.status !== 'done').sort((a, b) => b.date.localeCompare(a.date))[0];
  let activeLine = '';
  if (active && courseById.get(active.courseId)) {
    const course = courseById.get(active.courseId);
    const r = deriveRound(course, active, await db.shotsForRound(active.id));
    activeLine = `${esc(course.name)} · hole ${active.currentHole ?? 1}${r.holesPlayed ? ` · ${signed(r.toPar)} thru ${r.holesPlayed}` : ''}`;
  }
  const unsaved = rounds.filter((r) => !lastBackup || (r.finishedAt ?? r.date) > lastBackup).length;

  root.innerHTML = `
    <section class="page home">
      <header class="brand"><h1>Golf Tracker</h1><p>Shots, distances and stats, kept on this phone.</p></header>
      ${active && activeLine ? `
        <a class="resume" href="#/round/${active.id}/hole/${active.currentHole ?? 1}">
          <span>Continue round</span><small>${activeLine}</small></a>` : ''}
      <h2>${active ? 'Or start a new round' : 'Start a round'}</h2>
      <ul class="course-list">${courses.map((c) => `
        <li><button data-start="${c.id}"><span>${esc(c.name)}<small>${c.holes.length} holes · ${c.holes.filter((h) => h.green).length}/${c.holes.length} greens set</small></span><i>Tee off</i></button></li>`).join('')}
      </ul>
      ${unsaved ? `<a class="backup-nag" href="#/settings">${unsaved} ${unsaved === 1 ? 'round isn\'t' : 'rounds aren\'t'} in a backup yet. Export one.</a>` : ''}
    </section>`;

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-start]');
    if (!b) return;
    if (active && !(await confirmSheet('A round is already in progress. Start another one? The current round stays saved.', 'Start new round', false))) return;
    const course = courses.find((c) => c.id === b.dataset.start);
    const holeList = await chooseLayout(course);
    if (holeList) startRound(course.id, holeList);
  });
  return {};
}

async function roundsView(root) {
  const [rounds, courses] = await Promise.all([db.all('rounds'), db.all('courses')]);
  const courseById = new Map(courses.map((c) => [c.id, c]));
  const rows = [];
  for (const round of rounds.sort((a, b) => b.date.localeCompare(a.date))) {
    const course = courseById.get(round.courseId);
    if (!course) continue;
    const r = deriveRound(course, round, await db.shotsForRound(round.id));
    rows.push(`<li><a href="#/round/${round.id}/card"><span>${fmtDate(round.date)}<small>${esc(course.name)}${round.holeList && (round.holeList.length !== 18 || round.holeList[0] !== 1) ? ` · ${esc(layoutLabel(course, round))}` : ''}${round.status !== 'done' ? ' · in progress' : ''}</small></span>
      <b>${r.holesPlayed ? r.score : '–'}</b><em>${r.holesPlayed ? signed(r.toPar) : ''}${r.holesPlayed && r.holesPlayed < 18 ? ` · ${r.holesPlayed} holes` : ''}</em></a></li>`);
  }
  root.innerHTML = `<section class="page"><header class="page-head"><h1>Rounds</h1></header>
    ${rows.length ? `<ul class="round-list">${rows.join('')}</ul>` : '<p class="empty">No rounds yet. Start one from Home.</p>'}</section>`;
  return {};
}

async function settingsView(root) {
  const [bag, lastBackup, gcaKey] = await Promise.all([db.getSetting('bag', DEFAULT_BAG), db.getSetting('lastBackup', null), db.getSetting('gcaKey', '')]);
  const persisted = await navigator.storage?.persisted?.();
  let clubs = [...bag];
  const draw = () => {
    root.innerHTML = `
    <section class="page">
      <header class="page-head"><h1>Backup & settings</h1></header>
      <h2>Backup</h2>
      <p class="note">Rounds live only on this phone. Export a backup after each round and keep it in Files or iCloud Drive. Importing merges: nothing already here is deleted.</p>
      <div class="btn-col">
        <button class="btn primary" data-a="export">Export backup (JSON)</button>
        <button class="btn ghost" data-a="import">Import backup</button>
        <button class="btn ghost" data-a="csv">Export all rounds (CSV)</button>
      </div>
      <p class="note">${lastBackup ? `Last backup: ${fmtDate(lastBackup)}.` : 'No backup yet.'} ${persisted ? 'Storage is protected from automatic clearing.' : 'Add this app to your Home Screen so Safari keeps its data.'}</p>
      <h2>Tracker</h2>
      <p class="note">Connect the shot tracker over Bluetooth (in Bluefy on iPhone) to check its battery, GPS and sensors.</p>
      <div class="btn-col"><a class="btn ghost" href="#/tracker">Open tracker</a></div>
      <h2>Scorecard lookup</h2>
      <p class="note">Paste your GolfCourseAPI key to look up pars, hole lengths, rating and slope on a course's screen (35 free lookups a day). The key stays on this phone and isn't included in backups.</p>
      <div class="find-form">
        <input id="gcaKey" type="password" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="GolfCourseAPI key" value="${esc(gcaKey)}" aria-label="GolfCourseAPI key">
        <button class="btn primary" data-a="savekey">Save</button>
      </div>
      <h2>Clubs in your bag</h2>
      <p class="note">These show when you tag a shot. Tap to add or remove.</p>
      <div class="chips clubs">${ALL_CLUBS.map((c) => `<button data-club="${esc(c)}" class="${clubs.includes(c) ? 'on' : ''}">${esc(c)}</button>`).join('')}</div>
      <h2>About</h2>
      <p class="note">Golf Tracker ${APP_VERSION}. Distances in metres. Satellite imagery © Esri. Manual marking works everywhere; the tracker connects in Bluefy.</p>
    </section>`;
  };
  draw();
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.club) {
      const c = b.dataset.club;
      clubs = clubs.includes(c) ? clubs.filter((x) => x !== c) : ALL_CLUBS.filter((x) => clubs.includes(x) || x === c);
      await db.setSetting('bag', clubs);
      b.classList.toggle('on', clubs.includes(c));
    } else if (b.dataset.a === 'savekey') {
      const v = $('#gcaKey', root).value.trim();
      await db.setSetting('gcaKey', v);
      toast(v ? 'Key saved on this phone' : 'Key removed');
    } else if (b.dataset.a === 'export') {
      const data = await db.exportAll();
      await saveFile(`golf-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data), 'application/json');
      await db.setSetting('lastBackup', new Date().toISOString());
      draw();
    } else if (b.dataset.a === 'import') {
      const f = await pickFile('application/json,.json');
      if (!f) return;
      try {
        const counts = await db.importAll(JSON.parse(await f.text()));
        toast(`Imported ${counts.rounds} rounds, ${counts.shots} shots, ${counts.courses} courses`);
      } catch (err) {
        toast(err instanceof SyntaxError ? 'That file isn\'t valid JSON.' : err.message, 'warn');
      }
    } else if (b.dataset.a === 'csv') {
      const [rounds, courses] = await Promise.all([db.all('rounds'), db.all('courses')]);
      const byId = new Map(courses.map((c) => [c.id, c]));
      const items = [];
      for (const round of rounds) if (byId.get(round.courseId)) items.push({ round, course: byId.get(round.courseId), shots: await db.shotsForRound(round.id) });
      const { holes, shots } = allCsv(items);
      await saveFile(`golf-tracker-${new Date().toISOString().slice(0, 10)}.csv`, `${holes}\n\n${shots}`, 'text/csv');
    }
  });
  return {};
}

// ---------- router ----------
const routes = [
  [/^#?\/?$/, homeView, () => ({}), 'home'],
  [/^#\/round\/([^/]+)\/hole\/(\d+)$/, holeView, (m) => ({ roundId: m[1], hole: Number(m[2]) }), null],
  [/^#\/round\/([^/]+)\/card$/, cardView, (m) => ({ roundId: m[1] }), 'rounds'],
  [/^#\/round\/([^/]+)\/review\/(\d+)$/, reviewView, (m) => ({ roundId: m[1], hole: Number(m[2]) }), null],
  [/^#\/rounds$/, roundsView, () => ({}), 'rounds'],
  [/^#\/stats$/, statsView, () => ({}), 'stats'],
  [/^#\/courses$/, coursesView, () => ({}), 'courses'],
  [/^#\/course\/([^/]+)$/, courseEditView, (m) => ({ courseId: m[1] }), 'courses'],
  [/^#\/course\/([^/]+)\/map\/(\d+)$/, courseMapView, (m) => ({ courseId: m[1], hole: Number(m[2]) }), null],
  [/^#\/settings$/, settingsView, () => ({}), 'settings'],
  [/^#\/tracker$/, trackerView, () => ({}), 'settings'],
];

let current = null;
async function route() {
  const hash = location.hash || '#/';
  const match = routes.find(([re]) => re.test(hash));
  const [re, view, params, tab] = match ?? routes[0];
  try { current?.destroy?.(); } catch { /* ignore */ }
  const el = document.createElement('div');
  el.className = 'view';
  $('#main').replaceChildren(el);
  document.body.dataset.view = tab ?? 'full';
  for (const a of document.querySelectorAll('.tabbar a')) a.classList.toggle('on', a.dataset.tab === tab);
  try {
    current = await view(el, params(hash.match(re) ?? []));
  } catch (err) {
    console.error(err);
    el.innerHTML = `<p class="empty">Something went wrong: ${esc(err.message)}. Your data is safe. Go back <a href="#/">home</a>.</p>`;
  }
  let target = null;
  try { target = sessionStorage.getItem('scrollTo'); sessionStorage.removeItem('scrollTo'); } catch { /* fine */ }
  const el2 = target && document.getElementById(target);
  if (el2) el2.scrollIntoView({ block: 'start' });
  else window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);

(async function boot() {
  await seed();
  db.requestPersistence();
  route();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    // Reload once when an update takes over, so new courses and fixes show
    // without having to close the app twice.
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloaded) { reloaded = true; location.reload(); }
    });
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW', e));
  }
})();
