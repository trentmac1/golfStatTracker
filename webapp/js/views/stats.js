// Stats across rounds: trends, averages, club distances and miss pattern.
import * as db from '../db.js';
import { deriveRound, clubDistances } from '../stats.js';
import { DEFAULT_BAG } from '../config.js';
import { esc, m, one, signed, fmtDate } from '../ui.js';

const DIRS = ['long', 'long-right', 'right', 'short-right', 'short', 'short-left', 'left', 'long-left'];

export async function statsView(root) {
  const [rounds, courses, bag] = await Promise.all([db.all('rounds'), db.all('courses'), db.getSetting('bag', DEFAULT_BAG)]);
  const courseById = new Map(courses.map((c) => [c.id, c]));
  const all = [];
  for (const round of rounds.sort((a, b) => a.date.localeCompare(b.date))) {
    const course = courseById.get(round.courseId);
    if (!course) continue;
    const shots = await db.shotsForRound(round.id);
    const r = deriveRound(course, round, shots);
    if (r.holesPlayed) all.push({ round, course, r });
  }
  let range = Number(await db.getSetting('statsRange', 10));

  function draw() {
    const items = range ? all.slice(-range) : all;
    if (!items.length) {
      root.innerHTML = `<section class="page"><header class="page-head"><h1>Stats</h1></header>
        <p class="empty">Stats appear once you've finished a hole. Start a round from the home screen.</p></section>`;
      return;
    }
    const sum = (f) => items.reduce((a, x) => a + (f(x.r) ?? 0), 0);
    const holes = sum((r) => r.holesPlayed);
    const per18 = (v) => (holes ? (v / holes) * 18 : null);
    const ratio = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '–');
    const avgOf = (f) => { const v = items.map((x) => f(x.r)).filter((n) => n != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const parAvg = (p) => {
      const hs = items.flatMap((x) => x.r.holes.filter((h) => h.complete && h.par === p));
      return hs.length ? hs.reduce((a, h) => a + h.score, 0) / hs.length : null;
    };
    const missCounts = {};
    for (const x of items) for (const [k, v] of Object.entries(x.r.missCounts)) missCounts[k] = (missCounts[k] ?? 0) + v;
    const fw = { left: sum((r) => r.fairwayMisses.left), right: sum((r) => r.fairwayMisses.right), short: sum((r) => r.fairwayMisses.short) };
    const clubs = clubDistances(items.flatMap((x) => x.r.holes))
      .sort((a, b) => (bag.indexOf(a.club) + 1 || 99) - (bag.indexOf(b.club) + 1 || 99));

    // Trend: to-par per 18 holes, so 9-hole rounds compare fairly.
    const trend = items.map((x) => ({ v: (x.r.toPar / x.r.holesPlayed) * 18, x }));
    const maxAbs = Math.max(5, ...trend.map((t) => Math.abs(t.v)));
    const W = 320, H = 120, bw = Math.min(W / Math.max(trend.length, 1), 32);
    const bars = trend.map((t, i) => {
      const h = (Math.abs(t.v) / maxAbs) * (H / 2 - 8);
      const y = t.v >= 0 ? H / 2 - h : H / 2;
      return `<rect x="${i * bw + bw * 0.18}" y="${y}" width="${bw * 0.64}" height="${Math.max(h, 1)}" class="${t.v > 0 ? 'over' : 'under'}"><title>${fmtDate(t.x.round.date)}: ${signed(Math.round(t.v))} per 18</title></rect>`;
    }).join('');

    const maxMiss = Math.max(1, ...Object.values(missCounts));
    const compass = DIRS.map((d, i) => {
      const a = (i * 45 - 90) * (Math.PI / 180);
      const c = missCounts[d] ?? 0;
      const r = 14 + (c / maxMiss) * 46;
      return `<g><line x1="80" y1="80" x2="${80 + Math.cos(a) * r}" y2="${80 + Math.sin(a) * r}" class="ray ${c ? '' : 'zero'}"/>
        <text x="${80 + Math.cos(a) * 72}" y="${80 + Math.sin(a) * 72 + 4}" class="ray-n">${c || ''}</text></g>`;
    }).join('');
    const maxClub = Math.max(50, ...clubs.map((c) => c.max)) * 1.08;

    root.innerHTML = `
    <section class="page">
      <header class="page-head"><h1>Stats</h1>
        <div class="seg small" role="group" aria-label="Rounds included">
          ${[[5, 'Last 5'], [10, 'Last 10'], [0, 'All']].map(([v, t]) => `<button data-range="${v}" class="${range === v ? 'on' : ''}">${t}</button>`).join('')}
        </div>
        <p class="sub">${items.length} ${items.length === 1 ? 'round' : 'rounds'}, ${holes} holes</p>
      </header>

      <h2>Score to par, per 18</h2>
      <svg class="trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="Score to par by round">
        <line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" class="axis"/>${bars}
        <text x="2" y="12" class="axis-t">+${Math.round(maxAbs)}</text><text x="2" y="${H - 3}" class="axis-t">−${Math.round(maxAbs)}</text>
      </svg>

      <div class="tiles">
        <div class="tile"><b>${signed(Math.round(per18(sum((r) => r.toPar))))}</b><span>Avg to par</span><small>per 18 holes</small></div>
        <div class="tile"><b>${ratio(sum((r) => r.fairwaysHit), sum((r) => r.fairwayChances))}</b><span>Fairways</span><small>L ${fw.left} · R ${fw.right} · Short ${fw.short}</small></div>
        <div class="tile"><b>${ratio(sum((r) => r.gir), holes)}</b><span>Greens in reg.</span></div>
        <div class="tile"><b>${one(per18(sum((r) => r.putts)))}</b><span>Putts</span><small>per 18</small></div>
        <div class="tile"><b>${one(per18(sum((r) => r.threePutts)))}</b><span>3-putts</span><small>per 18</small></div>
        <div class="tile"><b>${ratio(sum((r) => r.scrambles), sum((r) => r.scrambleChances))}</b><span>Scrambling</span></div>
        <div class="tile"><b>${ratio(sum((r) => r.sandSaves), sum((r) => r.sandChances))}</b><span>Sand saves</span></div>
        <div class="tile"><b>${one(per18(sum((r) => r.penalties)))}</b><span>Penalties</span><small>per 18</small></div>
        <div class="tile"><b>${one(parAvg(3))} · ${one(parAvg(4))} · ${one(parAvg(5))}</b><span>Avg on par 3 · 4 · 5</span></div>
        <div class="tile"><b>${avgOf((r) => r.drivingDistance) ? `${m(avgOf((r) => r.drivingDistance))} m` : '–'}</b><span>Driving distance</span></div>
        <div class="tile"><b>${avgOf((r) => r.proximity) != null ? `${m(avgOf((r) => r.proximity))} m` : '–'}</b><span>Approach to centre</span></div>
      </div>

      <h2>Approach misses</h2>
      <div class="miss-wrap">
        <svg class="compass" viewBox="0 0 160 160" role="img" aria-label="Where approach shots missed the green">
          <circle cx="80" cy="80" r="11" class="green-dot"/>${compass}
          <text x="80" y="10" class="dir-t">Long</text><text x="80" y="158" class="dir-t">Short</text>
          <text x="2" y="84" class="dir-t start">Left</text><text x="158" y="84" class="dir-t end">Right</text>
        </svg>
        <p class="miss-note">${Object.keys(missCounts).length ? `Most common miss: <b>${esc(Object.entries(missCounts).sort((a, b) => b[1] - a[1])[0][0])}</b>. Shots aimed at the green that finished off it, seen from the shot's start.` : 'No missed approaches recorded yet.'}</p>
      </div>

      <h2>Club distances</h2>
      ${clubs.length ? `<table class="clubs-table">
        <thead><tr><th>Club</th><th>Median</th><th class="bar-col">Middle half of shots</th><th>n</th></tr></thead>
        <tbody>${clubs.map((c) => `<tr><th>${esc(c.club)}</th><td>${m(c.median)} m</td>
          <td class="bar-col"><span class="iqr" style="left:${(c.q1 / maxClub) * 100}%;width:${Math.max(1.5, ((c.q3 - c.q1) / maxClub) * 100)}%"></span><span class="med" style="left:${(c.median / maxClub) * 100}%"></span></td>
          <td>${c.count}</td></tr>`).join('')}</tbody></table>
        <p class="note">Mishits and penalty shots are left out. Set a shot's club by tapping it on the hole screen.</p>`
        : '<p class="empty">Tap a shot on the hole screen and pick its club to build these.</p>'}

      <h2>Rounds</h2>
      <ul class="round-list">${[...items].reverse().map((x) => `
        <li><a href="#/round/${x.round.id}/card"><span>${fmtDate(x.round.date)}<small>${esc(x.course.name)}</small></span><b>${x.r.score}</b><em>${signed(x.r.toPar)}${x.r.holesPlayed < 18 ? ` · ${x.r.holesPlayed} holes` : ''}</em></a></li>`).join('')}
      </ul>
    </section>`;
  }

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-range]');
    if (!b) return;
    range = Number(b.dataset.range);
    await db.setSetting('statsRange', range);
    draw();
  });
  draw();
  return {};
}
