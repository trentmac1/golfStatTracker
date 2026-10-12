// Stats across rounds: trends, averages, club distances and miss pattern.
import * as db from '../db.js';
import { deriveRound, clubDistances } from '../stats.js';
import { DEFAULT_BAG } from '../config.js';
import { sgSummary, clubReport, CATEGORIES } from '../sg.js';
import { estimate } from '../handicap.js';
import { esc, m, one, signed, fmtDate } from '../ui.js';

// Approach result grid, laid out as if looking down the shot at the green.
const GRID = [
  ['long-left', 'long', 'long-right'],
  ['left', 'green', 'right'],
  ['short-left', 'short', 'short-right'],
];
const cap = (t) => t[0].toUpperCase() + t.slice(1);

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
    const hits = sum((r) => r.approachHits);
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

    const misses = Object.values(missCounts).reduce((a, b) => a + b, 0);
    const approaches = misses + hits;
    const maxMiss = Math.max(1, ...Object.values(missCounts));
    const topMiss = Object.entries(missCounts).sort((a, b) => b[1] - a[1])[0];
    const missGrid = GRID.map((row) => row.map((k) => {
      const isGreen = k === 'green';
      const c = isGreen ? hits : missCounts[k] ?? 0;
      const p = approaches ? Math.round((100 * c) / approaches) : 0;
      // Misses shade by count (one hue, light to dark); the green cell is always green.
      const lvl = 0.12 + 0.6 * (c / maxMiss);
      const level = isGreen || !c ? '' : ` style="--lvl:${lvl.toFixed(2)}"`;
      const cls = isGreen ? 'mg-green' : !c ? 'mg-zero' : lvl > 0.45 ? 'mg-miss dark' : 'mg-miss';
      return `<div class="mg-cell ${cls}"${level} title="${isGreen ? 'On the green' : cap(k)}: ${c} of ${approaches}">
        <b>${c}</b><span>${isGreen ? 'Green' : cap(k)}</span>${approaches && c ? `<small>${p}%</small>` : ''}</div>`;
    }).join('')).join('');
    // ---------- handicap estimate ----------
    const hcRounds = items.map((x) => ({
      rating: x.course.rating, slope: x.course.slope,
      holes: x.r.holes.map((h) => ({ par: h.par, si: x.course.holes[h.hole - 1]?.si ?? null, score: h.complete ? h.score : null })),
    }));
    const hc = estimate(hcRounds);
    const noRating = [...new Set(items.filter((x) => !x.course.rating || !x.course.slope).map((x) => x.course))];
    const hcNote = hc.index != null
      ? `Average of your best ${hc.used} of ${hc.of} score differentials${hc.of < items.length ? ' (most recent 20)' : ''}, World Handicap System method. An estimate, not an official Golf Australia handicap.`
      : hc.usable ? `A handicap estimate needs 3 rated rounds: ${3 - hc.usable} more to go. A differential is what that round would count as towards a handicap.`
      : 'Needs rounds of 14 or more holes on a course with its rating and slope entered.';
    const nineHole = items.filter((x) => x.r.holes.length <= 13).length;
    const hcNine = nineHole ? `<p class="note">${nineHole} 9-hole round${nineHole === 1 ? ' isn\'t' : 's aren\'t'} counted in the handicap estimate yet.</p>` : '';
    const hcMissing = noRating.length
      ? `<p class="note warn-note">Add the rating and slope for ${noRating.map((c) => `<a href="#/course/${c.id}">${esc(c.name)}</a>`).join(', ')} (on the scorecard) so ${noRating.length === 1 ? 'its rounds count' : 'their rounds count'}.</p>` : '';

    // ---------- strokes gained ----------
    const sg = sgSummary(items.flatMap((x) => x.r.holes.map((dh) => [dh, x.round.holes?.[dh.hole]])));
    const sgPer18 = (v) => (sg.holes ? (v / sg.holes) * 18 : 0);
    const sgRows = CATEGORIES.map(([k, label]) => ({ k, label, v: sgPer18(sg.by[k]) }));
    const sgMax = Math.max(1, ...sgRows.map((r) => Math.abs(r.v)));
    const worst = [...sgRows].sort((a, b) => a.v - b.v)[0];
    const best = [...sgRows].sort((a, b) => b.v - a.v)[0];
    // Zero sits in the middle only when there are both gains and losses.
    const anyGain = sgRows.some((r) => r.v > 0.05);
    const anyLoss = sgRows.some((r) => r.v < -0.05);
    const zero = anyGain && anyLoss ? 50 : anyGain ? 0 : 100;
    const sgBars = sgRows.map((r) => {
      const room = r.v < 0 ? zero : 100 - zero;
      const w = (Math.abs(r.v) / sgMax) * room;
      return `<div class="sg-row" title="${r.label}: ${r.v.toFixed(1)} strokes per round">
        <span class="sg-label">${r.label}</span>
        <span class="sg-track" style="--zero:${zero}%"><i class="sg-bar ${r.v < 0 ? 'loss' : 'gain'}" style="${r.v < 0 ? `right:${100 - zero}%;width:${w}%` : `left:${zero}%;width:${w}%`}"></i></span>
        <b class="sg-val">${r.v > 0 ? '+' : r.v < 0 ? '−' : ''}${Math.abs(r.v).toFixed(1)}</b></div>`;
    }).join('');

    // ---------- clubs to work on ----------
    const clubsSg = clubReport(sg.shots).filter((c) => c.enough);
    const avgPerShot = sg.shots.length ? sg.shots.reduce((a, x) => a + x.sg, 0) / sg.shots.length : 0;
    const workOn = clubsSg.filter((c) => c.perShot < avgPerShot).slice(0, 3);
    const strongest = [...clubsSg].reverse().find((c) => c.perShot >= avgPerShot);
    const why = (c) => [
      `${Math.abs(c.perShot).toFixed(2)} strokes lost per shot`,
      c.mishitPct >= 25 ? `${c.mishitPct}% mishit` : '',
      c.penalties ? `${c.penalties} penalt${c.penalties === 1 ? 'y' : 'ies'}` : '',
      c.topMiss ? `misses ${c.topMiss}` : '',
    ].filter(Boolean).join(' · ');

    const maxClub = Math.max(50, ...clubs.map((c) => c.max)) * 1.08;

    root.innerHTML = `
    <section class="page">
      <header class="page-head"><h1>Stats</h1>
        <div class="seg small" role="group" aria-label="Rounds included">
          ${[[5, 'Last 5'], [10, 'Last 10'], [0, 'All']].map(([v, t]) => `<button data-range="${v}" class="${range === v ? 'on' : ''}">${t}</button>`).join('')}
        </div>
        <p class="sub">${items.length} ${items.length === 1 ? 'round' : 'rounds'}, ${holes} holes</p>
      </header>

      <div class="hc-card">
        <div class="hc-num">${hc.index != null ? `<b>${hc.index.toFixed(1)}</b><span>Handicap estimate</span>`
          : hc.usable ? `<b>${hc.diffs.at(-1).toFixed(1)}</b><span>Latest differential</span>` : '<b class="none">–</b><span>Handicap estimate</span>'}</div>
        <p>${hcNote}</p>
      </div>
      ${hcMissing}${hcNine}

      <h2>Score to par, per 18</h2>
      <svg class="trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="Score to par by round">
        <line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" class="axis"/>${bars}
        <text x="${W - 3}" y="12" class="axis-t end">+${Math.round(maxAbs)}</text><text x="${W - 3}" y="${H - 3}" class="axis-t end">−${Math.round(maxAbs)}</text>
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

      <h2>Strokes gained</h2>
      ${sg.holes ? `
      <div class="sg-chart" role="table" aria-label="Strokes gained per round by area against a tour pro">${sgBars}
        <div class="sg-axis"><span></span><span class="sg-axis-mid">${zero === 100 ? '<i>← Strokes lost</i><i>0</i>' : zero === 0 ? '<i>0</i><i>Strokes gained →</i>' : '<i>Lost</i><i>0</i><i>Gained</i>'}</span><span></span></div>
      </div>
      <p class="note">Per round, against a PGA Tour player from the same spots (Broadie baseline), so every area will show a loss. Compare the areas with each other: the biggest bar is where you give away the most. ${worst ? `Biggest gap: <b>${worst.label}</b> (${Math.abs(worst.v).toFixed(1)} per round). Closest to tour: <b>${best.label}</b>.` : ''}
        Putting uses your first-putt length when you enter it, otherwise an estimate from where your ball sat on the green.</p>`
        : '<p class="empty">Strokes gained needs finished holes with a green set and every shot marked.</p>'}

      <h2>Clubs to work on</h2>
      ${workOn.length ? `
      <ol class="work-list">${workOn.map((c) => `<li><b>${esc(c.club)}</b><span>${why(c)}</span><small>${c.count} shots</small></li>`).join('')}</ol>
      ${strongest ? `<p class="note">Strongest club: <b>${esc(strongest.club)}</b>, ${strongest.perShot >= 0 ? 'gaining' : 'losing only'} ${Math.abs(strongest.perShot).toFixed(2)} per shot.</p>` : ''}
      <p class="note">Ranked by strokes lost per shot against the same tour baseline, for clubs with 3 or more shots. Your average across all clubs is ${Math.abs(avgPerShot).toFixed(2)} lost per shot.</p>`
        : `<p class="empty">${sg.shots.some((x) => x.club) ? 'Not enough shots per club yet. Clubs need 3 or more tagged shots.' : 'Tag the club on your shots (tap a shot on the hole screen) to see which clubs cost you the most.'}</p>`}

      <h2>Approach misses</h2>
      ${approaches ? `
      <div class="miss-grid" role="table" aria-label="Where approach shots finished: ${hits} on the green, ${misses} missed">${missGrid}</div>
      <p class="miss-note">${topMiss ? `Most common miss: <b>${cap(topMiss[0])}</b>, ${topMiss[1]} of ${approaches} approaches.` : 'Every approach found the green.'}
        Shots aimed at the green, seen from where each was hit, so long is past the flag and left is left of your line.</p>`
        : '<p class="empty">No approaches recorded yet. Tap <b>On green</b> on each green so the app knows where approaches finished.</p>'}

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
