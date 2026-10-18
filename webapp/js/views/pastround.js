// Add a round played earlier from its scorecard: course, date, holes, tees,
// then a score (and putts, if you have them) for each hole. Saved as a
// finished round with no shots, so it counts in scoring stats and the
// handicap estimate.
import * as db from '../db.js';
import { emptyHoleStat, ninesOf, nineLabel } from '../stats.js';
import { $, esc, toast } from '../ui.js';

// Tees known for a course: the ones saved with past rounds, plus the
// course's own tees (from its scorecard), newest first, one per name.
export function teeOptions(course) {
  const list = [...(course.teeSets ?? [])];
  if (course.tee || course.rating || course.slope) list.push({ name: course.tee || 'Course tees', rating: course.rating ?? null, slope: course.slope ?? null });
  const seen = new Set();
  return list.filter((t) => { const k = (t.name ?? '').toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

// Rating and slope for a round: its own tees if set, else the course's.
export const roundRating = (round, course) => ({
  rating: round.tee?.rating ?? course.rating ?? null,
  slope: round.tee?.slope ?? course.slope ?? null,
});

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const num = (v) => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };

export async function pastRoundView(root) {
  const courses = (await db.all('courses')).sort((a, b) => a.name.localeCompare(b.name));
  const st = {
    courseId: null, date: today(), len: 18, first: 0, second: 1,
    tee: null,            // index into teeOptions, or 'new'
    newTee: { name: '', rating: '', slope: '' },
    scores: {}, putts: {},
  };
  const course = () => courses.find((c) => c.id === st.courseId);

  function order() {
    const c = course();
    const nines = ninesOf(c);
    if (nines.length === 1 || st.len === 9) return nines[Math.min(st.first, nines.length - 1)];
    const second = nines.length > 2 ? st.second : (st.first + 1) % 2;
    return [...nines[st.first], ...nines[second]];
  }

  function pickCourse(id) {
    st.courseId = id;
    const c = course();
    const nines = ninesOf(c);
    const full = nines.filter((nn) => nn.length === 9);
    st.len = full.length >= 2 ? 18 : 9;
    st.first = 0; st.second = nines.length > 1 ? 1 : 0;
    st.tee = teeOptions(c).length ? 0 : 'new';
    st.scores = {}; st.putts = {};
  }

  function draw() {
    const c = course();
    if (!c) {
      root.innerHTML = `
      <section class="page">
        <header class="page-head"><a class="back" href="#/rounds">‹ Rounds</a><h1>Add a past round</h1></header>
        <p class="sub">Type in a scorecard from a round you've already played. Which course?</p>
        ${courses.length ? `<ul class="course-list">${courses.map((x) => `
          <li><button data-course="${x.id}"><span>${esc(x.name)}<small>${x.holes.length} holes · par ${x.holes.reduce((a, h) => a + h.par, 0)}</small></span><i>Choose</i></button></li>`).join('')}</ul>`
          : '<p class="empty">Add the course under Courses first.</p>'}
      </section>`;
      return;
    }
    const nines = ninesOf(c);
    const full = nines.filter((nn) => nn.length === 9);
    const tees = teeOptions(c);
    const holes = order().map((n) => c.holes[n - 1]);
    const par = holes.reduce((a, h) => a + h.par, 0);
    const seg = (key, chosen, skip) => nines.map((nn, i) => (i === skip ? '' : `<button data-${key}="${i}" class="${i === chosen ? 'on' : ''}">${nineLabel(nn)}</button>`)).join('');
    const t = st.tee === 'new' ? null : tees[st.tee];

    root.innerHTML = `
    <section class="page past-round">
      <header class="page-head"><a class="back" href="#/rounds">‹ Rounds</a><h1>Add a past round</h1></header>
      <div class="past-course">
        <span><b>${esc(c.name)}</b><small>Par ${par} for these holes</small></span>
        <button class="btn ghost" data-a="change">Change</button>
      </div>

      <label class="field">Date played<input type="date" id="pdate" value="${st.date}" max="${today()}"></label>

      ${full.length >= 2 ? `<p class="sheet-label">Holes</p>
      <div class="seg small">${[18, 9].map((v) => `<button data-len="${v}" class="${st.len === v ? 'on' : ''}">${v} holes</button>`).join('')}</div>` : ''}
      ${nines.length > 1 ? `
        <p class="sheet-label">${st.len === 18 ? 'First nine' : 'Which nine'}</p>
        <div class="seg small">${seg('first', st.first, -1)}</div>
        ${st.len === 18 && nines.length > 2 ? `<p class="sheet-label">Second nine</p><div class="seg small">${seg('second', st.second, st.first)}</div>` : ''}` : ''}

      <p class="sheet-label">Tees</p>
      <div class="chips tees">
        ${tees.map((x, i) => `<button data-tee="${i}" class="${st.tee === i ? 'on' : ''}">${esc(x.name)}</button>`).join('')}
        <button data-tee="new" class="${st.tee === 'new' ? 'on' : ''}">${tees.length ? 'Other tees' : 'Enter tees'}</button>
      </div>
      ${st.tee === 'new' ? `
        <div class="rating-row">
          <label>Tees<input id="tname" value="${esc(st.newTee.name)}" placeholder="e.g. Blue" autocomplete="off"></label>
          <label>Rating<input id="trating" inputmode="decimal" value="${esc(st.newTee.rating)}" placeholder="e.g. 68.8"></label>
          <label>Slope<input id="tslope" inputmode="numeric" value="${esc(st.newTee.slope)}" placeholder="e.g. 125"></label>
        </div>
        <p class="note">Rating and slope are on the scorecard (scratch or course rating). They let the round count towards your handicap estimate. These tees are saved with the course for next time.</p>`
      : t ? `<p class="note">${t.rating && t.slope ? `Rating ${t.rating}, slope ${t.slope}.` : 'No rating or slope for these tees, so the round won\'t count towards the handicap estimate. Choose Other tees to enter them.'}</p>` : ''}

      <h2>Scorecard</h2>
      <table class="par-table past-card">
        <thead><tr><th>Hole</th><th>Par</th><th>Score</th><th>Putts <small>optional</small></th></tr></thead>
        <tbody>${holes.map((h) => `
          <tr><th>${h.n}</th><td class="pc-par">${h.par}${h.si ? `<small>SI ${h.si}</small>` : ''}</td>
            <td><input class="si-input pc-score" data-score="${h.n}" inputmode="numeric" value="${st.scores[h.n] ?? ''}" aria-label="Score, hole ${h.n}"></td>
            <td><input class="si-input" data-putts="${h.n}" inputmode="numeric" value="${st.putts[h.n] ?? ''}" aria-label="Putts, hole ${h.n}"></td></tr>`).join('')}
        </tbody>
        <tfoot><tr><th>Total</th><td>${par}</td><td id="ptotal"></td><td id="pputts"></td></tr></tfoot>
      </table>
      <p class="note" id="pmsg"></p>
      <button class="btn primary wide" data-a="save">Save round</button>
    </section>`;
    totals();
  }

  function totals() {
    const c = course();
    if (!c) return;
    const holes = order();
    const done = holes.filter((n) => st.scores[n] != null);
    const sc = done.reduce((a, n) => a + st.scores[n], 0);
    const pr = done.reduce((a, n) => a + c.holes[n - 1].par, 0);
    const pt = holes.filter((n) => st.putts[n] != null);
    $('#ptotal', root).textContent = done.length ? `${sc} (${sc - pr === 0 ? 'E' : sc - pr > 0 ? `+${sc - pr}` : sc - pr})` : '';
    $('#pputts', root).textContent = pt.length ? String(pt.reduce((a, n) => a + st.putts[n], 0)) : '';
    $('#pmsg', root).textContent = done.length && done.length < holes.length ? `${holes.length - done.length} hole${holes.length - done.length === 1 ? '' : 's'} without a score. Leave a hole blank if you didn't finish it.` : '';
  }

  async function save() {
    const c = course();
    const holes = order();
    const done = holes.filter((n) => st.scores[n] != null);
    if (!done.length) { toast('Enter a score for at least one hole', 'warn'); return; }
    const badPutts = done.find((n) => st.putts[n] != null && st.putts[n] >= st.scores[n]);
    if (badPutts) { toast(`Hole ${badPutts}: putts must be fewer than the score`, 'warn'); return; }
    let tee = null;
    if (st.tee === 'new') {
      const name = st.newTee.name.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 30);
      const rating = num(st.newTee.rating), slope = num(st.newTee.slope);
      if (st.newTee.rating !== '' && (rating == null || rating < 50 || rating > 85)) { toast('Rating should be between 50 and 85', 'warn'); return; }
      if (st.newTee.slope !== '' && (slope == null || slope < 55 || slope > 155)) { toast('Slope should be between 55 and 155', 'warn'); return; }
      if (name || rating || slope) {
        tee = { name: name || 'Tees', rating: rating != null ? Math.round(rating * 10) / 10 : null, slope: slope != null ? Math.round(slope) : null };
        // Remember these tees on the course (replacing an older entry with the same name).
        c.teeSets = [tee, ...(c.teeSets ?? []).filter((x) => (x.name ?? '').toLowerCase() !== tee.name.toLowerCase())].slice(0, 8);
        await db.put('courses', c);
      }
    } else if (st.tee != null) {
      tee = teeOptions(c)[st.tee] ?? null;
    }
    const [y, mo, d] = st.date.split('-').map(Number);
    const date = new Date(y, mo - 1, d, 12).toISOString(); // midday local, so it lands on the right day
    const round = {
      id: db.uid(), courseId: c.id, date, status: 'done', finishedAt: new Date().toISOString(),
      holeList: holes, currentHole: holes[0], entered: true, tee,
      holes: Object.fromEntries(done.map((n) => [n, { ...emptyHoleStat(), score: st.scores[n], putts: st.putts[n] ?? null }])),
    };
    await db.put('rounds', round);
    toast('Round added');
    location.hash = `#/round/${round.id}/card`;
  }

  draw();

  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.course) { pickCourse(b.dataset.course); draw(); window.scrollTo(0, 0); return; }
    if (b.dataset.a === 'change') { st.courseId = null; draw(); return; }
    if (b.dataset.a === 'save') { save(); return; }
    if (b.dataset.len) st.len = Number(b.dataset.len);
    else if (b.dataset.first) { st.first = Number(b.dataset.first); if (st.second === st.first) st.second = (st.first + 1) % ninesOf(course()).length; }
    else if (b.dataset.second) st.second = Number(b.dataset.second);
    else if (b.dataset.tee) st.tee = b.dataset.tee === 'new' ? 'new' : Number(b.dataset.tee);
    else return;
    draw();
  });

  root.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'pdate') { st.date = t.value || today(); return; }
    if (t.id === 'tname') { st.newTee.name = t.value; return; }
    if (t.id === 'trating') { st.newTee.rating = t.value; return; }
    if (t.id === 'tslope') { st.newTee.slope = t.value; return; }
    const n = Number(t.dataset.score ?? t.dataset.putts);
    if (!n) return;
    const v = parseInt(t.value, 10);
    const ok = Number.isFinite(v) && v >= (t.dataset.score ? 1 : 0) && v <= 20;
    const into = t.dataset.score ? st.scores : st.putts;
    if (ok) into[n] = v; else delete into[n];
    totals();
  });
  return {};
}
