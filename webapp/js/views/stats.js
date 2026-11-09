// Stats across rounds: trends, averages, club distances and miss pattern.
import * as db from '../db.js';
import { deriveRound, clubDistances, countsForDistance } from '../stats.js';
import { DEFAULT_BAG } from '../config.js';
import { roundRating } from './pastround.js';
import { sgSummary, clubReport, CATEGORIES } from '../sg.js';
import { estimate, differential } from '../handicap.js';
import { esc, m, one, signed, fmtDate, sheet } from '../ui.js';
import { median } from '../geo.js';
import { METRICS, APPROACH, seriesFor, trendNote, approachSplit, clubMetric, clubShots } from '../trends.js';

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
    if (r.holesPlayed) all.push({ round, course, shots, r });
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
    // Putting stats only over holes with putts entered (typed-in scorecards may have none).
    const puttHoles = sum((r) => r.puttHoles);
    const perPuttHole = (v) => (puttHoles ? (v / puttHoles) * 18 : null);
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
      ...roundRating(x.round, x.course),
      holes: x.r.holes.map((h) => ({ par: h.par, si: x.course.holes[h.hole - 1]?.si ?? null, score: h.complete ? h.score : null })),
    }));
    const hc = estimate(hcRounds);
    const noRating = [...new Set(items.filter((x) => { const t = roundRating(x.round, x.course); return !t.rating || !t.slope; }).map((x) => x.course))];
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
      return `<button class="sg-row" data-metric="sg-${r.k}" title="${r.label}: ${r.v.toFixed(1)} strokes per round">
        <span class="sg-label">${r.label}</span>
        <span class="sg-track" style="--zero:${zero}%"><i class="sg-bar ${r.v < 0 ? 'loss' : 'gain'}" style="${r.v < 0 ? `right:${100 - zero}%;width:${w}%` : `left:${zero}%;width:${w}%`}"></i></span>
        <b class="sg-val">${r.v > 0 ? '+' : r.v < 0 ? '−' : ''}${Math.abs(r.v).toFixed(1)}</b></button>`;
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

      <button class="hc-card" data-metric="hcDiff">
        <div class="hc-num">${hc.index != null ? `<b>${hc.index.toFixed(1)}</b><span>Handicap estimate</span>`
          : hc.usable ? `<b>${hc.diffs.at(-1).toFixed(1)}</b><span>Latest differential</span>` : '<b class="none">–</b><span>Handicap estimate</span>'}</div>
        <p>${hcNote}</p>
      </button>
      ${hcMissing}${hcNine}

      <h2>Score to par, per 18</h2>
      <svg class="trend tappable" data-metric="toPar" viewBox="0 0 ${W} ${H}" role="img" aria-label="Score to par by round">
        <line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" class="axis"/>${bars}
        <text x="${W - 3}" y="12" class="axis-t end">+${Math.round(maxAbs)}</text><text x="${W - 3}" y="${H - 3}" class="axis-t end">−${Math.round(maxAbs)}</text>
      </svg>

      <p class="note tap-hint">Tap a stat to see how it has changed over these rounds.</p>
      <div class="tiles">
        <button class="tile" data-metric="toPar"><b>${signed(Math.round(per18(sum((r) => r.toPar))))}</b><span>Avg to par</span><small>per 18 holes</small></button>
        <button class="tile" data-metric="fairways"><b>${ratio(sum((r) => r.fairwaysHit), sum((r) => r.fairwayChances))}</b><span>Fairways</span><small>L ${fw.left} · R ${fw.right} · Short ${fw.short}</small></button>
        <button class="tile" data-metric="gir"><b>${ratio(sum((r) => r.gir), sum((r) => r.girChances))}</b><span>Greens in reg.</span></button>
        <button class="tile" data-metric="putts"><b>${one(perPuttHole(sum((r) => r.putts)))}</b><span>Putts</span><small>per 18</small></button>
        <button class="tile" data-metric="threePutts"><b>${one(perPuttHole(sum((r) => r.threePutts)))}</b><span>3-putts</span><small>per 18</small></button>
        <button class="tile" data-metric="scrambling"><b>${ratio(sum((r) => r.scrambles), sum((r) => r.scrambleChances))}</b><span>Scrambling</span></button>
        <button class="tile" data-metric="sand"><b>${ratio(sum((r) => r.sandSaves), sum((r) => r.sandChances))}</b><span>Sand saves</span></button>
        <button class="tile" data-metric="penalties"><b>${one(per18(sum((r) => r.penalties)))}</b><span>Penalties</span><small>per 18</small></button>
        <button class="tile" data-metric="parAvg"><b>${one(parAvg(3))} · ${one(parAvg(4))} · ${one(parAvg(5))}</b><span>Avg on par 3 · 4 · 5</span></button>
        <button class="tile" data-metric="driving"><b>${avgOf((r) => r.drivingDistance) ? `${m(avgOf((r) => r.drivingDistance))} m` : '–'}</b><span>Driving distance</span></button>
        <button class="tile" data-metric="proximity"><b>${avgOf((r) => r.proximity) != null ? `${m(avgOf((r) => r.proximity))} m` : '–'}</b><span>Approach proximity</span></button>
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
      <div class="miss-grid tappable" data-metric="approach" role="table" aria-label="Where approach shots finished: ${hits} on the green, ${misses} missed">${missGrid}</div>
      <p class="miss-note">${topMiss ? `Most common miss: <b>${cap(topMiss[0])}</b>, ${topMiss[1]} of ${approaches} approaches.` : 'Every approach found the green.'}
        Shots aimed at the green, seen from where each was hit, so long is past the flag and left is left of your line. Tap the grid to see the trend.</p>`
        : '<p class="empty">No approaches recorded yet. Tap <b>On green</b> on each green so the app knows where approaches finished.</p>'}

      <h2>Club distances</h2>
      ${clubs.length ? `<table class="clubs-table">
        <thead><tr><th>Club</th><th>Median</th><th class="bar-col">Middle half of shots</th><th>n</th></tr></thead>
        <tbody>${clubs.map((c) => `<tr data-club="${esc(c.club)}"><th>${esc(c.club)}</th><td>${m(c.median)} m</td>
          <td class="bar-col"><span class="iqr" style="left:${(c.q1 / maxClub) * 100}%;width:${Math.max(1.5, ((c.q3 - c.q1) / maxClub) * 100)}%"></span><span class="med" style="left:${(c.median / maxClub) * 100}%"></span></td>
          <td>${c.count}<i class="chev" aria-hidden="true">›</i></td></tr>`).join('')}</tbody></table>
        <p class="note">Tap a club for its distances over time and to leave shots out (a layup or punch-out, say). Mishits and penalty shots are always left out. Set a shot's club by tapping it on the hole screen.</p>`
        : '<p class="empty">Tap a shot on the hole screen and pick its club to build these.</p>'}

    </section>`;
  }

  // Score differential per rated round, using the index the current rounds give.
  function hcMetric(items) {
    const rated = (x) => ({ ...roundRating(x.round, x.course), holes: x.r.holes.map((h) => ({ par: h.par, si: x.course.holes[h.hole - 1]?.si ?? null, score: h.complete ? h.score : null })) });
    const idx = estimate(items.map(rated)).index;
    return { label: 'Score differential', sub: 'what each round counts as towards a handicap', better: 'down', fmt: (v) => (v == null ? '–' : v.toFixed(1)),
      value: (x) => differential(rated(x), idx)?.diff ?? null,
      empty: 'Differentials need rounds of 14 or more holes on a course with its rating and slope entered.' };
  }

  // key: a METRICS key, 'hcDiff', 'approach', or 'club:<club>'.
  function openTrend(key) {
    const body = (d) => {
      const items = range ? all.slice(-range) : all;
      const list = d.querySelector('.trend-rounds');
      const scroll = list?.scrollTop ?? 0;
      d.querySelector('.trend-body').innerHTML = key === 'approach' ? approachBody(items, range)
        : key.startsWith('club:') ? clubBody(key.slice(5), items, range)
        : trendBody(key === 'hcDiff' ? hcMetric(items) : METRICS[key], items, range);
      const after = d.querySelector('.trend-rounds');
      if (after) after.scrollTop = scroll;
    };
    sheet('<div class="trend-body"></div>', (d) => {
      body(d);
      d.addEventListener('click', async (e) => {
        const t = e.target.closest('[data-nodist]');
        if (t) { await toggleNoDist(t.dataset.nodist); draw(); body(d); return; }
        const b = e.target.closest('[data-range]');
        if (!b) return;
        range = Number(b.dataset.range);
        await db.setSetting('statsRange', range);
        draw();
        body(d);
      });
    });
  }

  // Leave a shot out of club distances, or put it back, then re-work that round.
  async function toggleNoDist(id) {
    const x = all.find((it) => it.shots.some((sh) => sh.id === id));
    if (!x) return;
    const raw = x.shots.find((sh) => sh.id === id);
    raw.noDist = !raw.noDist;
    await db.put('shots', raw);
    x.r = deriveRound(x.course, x.round, x.shots);
  }

  root.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-metric]');
    if (t) { openTrend(t.dataset.metric); return; }
    const c = e.target.closest('[data-club]');
    if (c) { openTrend(`club:${c.dataset.club}`); return; }
    const b = e.target.closest('[data-range]');
    if (!b) return;
    range = Number(b.dataset.range);
    await db.setSetting('statsRange', range);
    draw();
  });
  draw();
  return {};
}

const rangeSeg = (range) => `<div class="seg small" role="group" aria-label="Rounds included">
  ${[[5, 'Last 5'], [10, 'Last 10'], [0, 'All']].map(([v, t]) => `<button data-range="${v}" class="${range === v ? 'on' : ''}">${t}</button>`).join('')}</div>`;

const sheetHead = (label, sub, range) => `<h2 class="sheet-title">${esc(label)}</h2>
  ${sub ? `<p class="sheet-sub">${esc(sub)}</p>` : ''}${rangeSeg(range)}`;
const roundName = (x) => `${fmtDate(x.round.date)}<small>${esc(x.course.name)}${x.r.holesPlayed < 18 ? ` · ${x.r.holesPlayed} holes` : ''}</small>`;

// Chart, average key and trend notes for a metric, or null when no round has it.
function chartBlock(metric, items, series = seriesFor(metric, items)) {
  if (!series.some((s) => s.points.length)) return null;
  const isMulti = series.length > 1;
  const notes = series.filter((s) => s.points.length).map((s) => {
    const n = trendNote(metric, s.points);
    return n ? `<p class="sheet-note">${isMulti ? `<b>${esc(s.name)}.</b> ` : ''}${esc(n)}</p>` : '';
  }).join('');
  return `${lineChart(metric, series, items)}${notes}`;
}

// Sheet contents for one stat: title, range selector, line chart, note, and the values by round.
export function trendBody(metric, items, range) {
  const series = seriesFor(metric, items);
  const isMulti = series.length > 1;
  const head = sheetHead(metric.label, metric.sub, range);
  const chart = chartBlock(metric, items, series);
  if (!chart) return `${head}<p class="empty">${esc(metric.empty ?? 'None of these rounds have this stat yet.')}</p>`;
  const rows = [...items.keys()].reverse().map((i) => {
    const vals = series.map((s) => s.points.find((p) => p.i === i)?.v ?? null);
    if (vals.every((v) => v == null)) return '';
    return `<li><span>${roundName(items[i])}</span><b>${vals.map((v) => metric.fmt(v)).join(' · ')}</b></li>`;
  }).join('');
  return `${head}${chart}
    <ul class="trend-rounds">${isMulti ? `<li class="trend-rounds-head"><span>Round</span><b>${series.map((s) => esc(s.name)).join(' · ')}</b></li>` : ''}${rows}</ul>`;
}

// Approach misses: how often the green was hit, and the short/long and left/right
// misses, as shares of each round's approaches.
export function approachBody(items, range) {
  const head = sheetHead('Approach misses', 'Share of each round\'s approaches: shots aimed at the green.', range);
  const charts = Object.values(APPROACH).map((metric) => {
    const c = chartBlock(metric, items);
    return c ? `<h3 class="trend-h">${esc(metric.label)}</h3>${c}` : '';
  }).join('');
  if (!charts) return `${head}<p class="empty">None of these rounds have approaches recorded. Tap <b>On green</b> on each green so the app knows where approaches finished.</p>`;
  const pc = (v) => `${Math.round(v)}%`;
  const rows = [...items.keys()].reverse().map((i) => {
    const a = approachSplit(items[i].r);
    if (!a) return '';
    return `<li><span>${roundName(items[i])}<small>Short ${pc(a.short)} · Long ${pc(a.long)} · Left ${pc(a.left)} · Right ${pc(a.right)}</small></span>
      <b>${pc(a.green)}<small>of ${a.n}</small></b></li>`;
  }).join('');
  return `${head}${charts}
    <h3 class="trend-h">By round</h3>
    <ul class="trend-rounds"><li class="trend-rounds-head"><span>Round</span><b>On the green</b></li>${rows}</ul>
    <p class="sheet-note">Short and long include the corners (short-left and so on), as do left and right, so a short-left miss counts in both.</p>`;
}

// One club: median distance per round, every shot as a dot, and each shot listed
// with a switch to leave it out of club distances.
export function clubBody(club, items, range) {
  const metric = clubMetric(club);
  const head = sheetHead(club, metric.sub, range);
  const shots = clubShots(items, club);
  if (!shots.length) return `${head}<p class="empty">${esc(metric.empty)}</p>`;
  const counted = shots.filter((c) => countsForDistance(c.shot)).map((c) => c.shot.dist).sort((a, b) => a - b);
  const q = (p) => counted[Math.min(counted.length - 1, Math.floor(p * counted.length))];
  const summary = counted.length
    ? `<p class="club-sum"><b>${m(median(counted))} m</b> median · middle half ${m(q(0.25))}–${m(q(0.75))} m · ${counted.length} of ${shots.length} shots counted</p>`
    : `<p class="club-sum">All ${shots.length} shots are left out.</p>`;
  const chart = chartBlock(metric, items) ?? '';
  const rows = [...shots].reverse().map(({ x, shot }) => {
    const fixed = shot.mishit ? 'Mishit' : shot.penalty ? 'Penalty' : null;
    const out = !countsForDistance(shot);
    return `<li class="${out ? 'left-out' : ''}"><span><i class="d">${m(shot.dist)} m</i><small>${shortDate(x.round.date)} · hole ${shot.hole} · shot ${shot.index + 1}${shot.result ? ` · ${esc(shot.result)}` : ''}</small></span>
      ${fixed ? `<em class="pill fixed" title="${fixed} shots are always left out">${fixed}</em>`
        : `<button class="pill ${out ? 'off' : 'on'}" data-nodist="${esc(shot.id)}" aria-pressed="${out ? 'false' : 'true'}">${out ? 'Left out' : 'Counted'}</button>`}</li>`;
  }).join('');
  return `${head}${summary}${chart}
    <h3 class="trend-h">Shots</h3>
    <p class="sheet-note">Tap <b>Counted</b> to leave a shot out of club distances and driving distance (a layup, punch-out or knock-down), and tap again to put it back.</p>
    <ul class="trend-rounds club-shots">${rows}</ul>`;
}

// Line chart: one point per round (oldest left), a dashed line at the average of
// the rounds shown, and the first and last dates on the x axis.
function lineChart(metric, series, items) {
  const W = 340, H = 190, L = 38, R = multiOr(series, 42, 10), T = 12, B = 24;
  const scatter = metric.scatter?.(items) ?? [];
  const vals = [...series.flatMap((s) => s.points.map((p) => p.v)), ...scatter.map((p) => p.v)];
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (metric.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  // Keep a sensible minimum height so flat lines don't get labels like 20% · 20% · 20%.
  const minSpan = metric.max === 100 || metric.unit === ' m' ? 10 : 1;
  if (hi - lo < minSpan) { const mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; }
  const span = hi - lo;
  lo -= span * 0.12; hi += span * 0.12;
  if (metric.min != null && lo < metric.min) { hi += metric.min - lo; lo = metric.min; }
  if (metric.max != null && hi > metric.max) { lo = Math.max(metric.min ?? -Infinity, lo - (hi - metric.max)); hi = metric.max; }
  const n = items.length;
  const xAt = (i) => (n === 1 ? L + (W - L - R) / 2 : L + (i / (n - 1)) * (W - L - R));
  const yAt = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const ticks = [lo, (lo + hi) / 2, hi];
  const grid = ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${yAt(v)}" y2="${yAt(v)}" class="grid"/>
    <text x="${L - 5}" y="${yAt(v) + 4}" class="axis-t end">${esc(metric.fmt(v))}</text>`).join('');
  const zeroLine = metric.zero && lo < 0 && hi > 0 ? `<line x1="${L}" x2="${W - R}" y1="${yAt(0)}" y2="${yAt(0)}" class="zero"/>` : '';
  const lines = series.map((s, si) => {
    if (!s.points.length) return '';
    const cls = `s${si}`;
    const path = s.points.map((p, j) => `${j ? 'L' : 'M'}${xAt(p.i).toFixed(1)},${yAt(p.v).toFixed(1)}`).join('');
    const avg = s.points.reduce((a, p) => a + p.v, 0) / s.points.length;
    const avgLine = multi(series) ? '' : `<line x1="${L}" x2="${W - R}" y1="${yAt(avg)}" y2="${yAt(avg)}" class="avg"/>`;
    const dots = s.points.map((p) => `<circle cx="${xAt(p.i)}" cy="${yAt(p.v)}" r="${n > 30 ? 2.5 : 4}" class="${cls}"><title>${fmtDate(items[p.i].round.date)}: ${esc(metric.fmt(p.v))}</title></circle>`).join('');
    return `${avgLine}<path d="${path}" class="line ${cls}"/>${dots}`;
  }).join('');
  // Series names beside each line's last point, nudged apart so they don't overlap.
  const tags = multi(series) ? series.map((s, si) => ({ s, si, last: s.points.at(-1) })).filter((t) => t.last)
    .map((t) => ({ ...t, y: yAt(t.last.v) + 4 })).sort((a, b) => a.y - b.y)
    .map((t, k, arr) => { if (k && t.y - arr[k - 1].y < 13) t.y = arr[k - 1].y + 13; return t; })
    .map((t) => `<text x="${xAt(t.last.i) + 7}" y="${t.y}" class="axis-t s-tag s${t.si}">${esc(t.s.name)}</text>`).join('') : '';
  const dates = n > 1
    ? `<text x="${L}" y="${H - 6}" class="axis-t">${shortDate(items[0].round.date)}</text><text x="${W - R}" y="${H - 6}" class="axis-t end">${shortDate(items[n - 1].round.date)}</text>`
    : `<text x="${xAt(0)}" y="${H - 6}" class="axis-t mid">${shortDate(items[0].round.date)}</text>`;
  return `<svg class="tchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(metric.label)} by round">${grid}${zeroLine}${scatter.map((p) => `<circle cx="${xAt(p.i)}" cy="${yAt(p.v)}" r="3" class="scat"/>`).join('')}${lines}${tags}${dates}</svg>${multi(series) ? '' : (() => {
    const pts = series[0].points;
    if (!pts.length) return '';
    return `<p class="tchart-key"><i></i>Average of these rounds: <b>${esc(metric.fmt(pts.reduce((a, p) => a + p.v, 0) / pts.length))}</b></p>`;
  })()}`;
}
const multi = (series) => series.length > 1;
const multiOr = (series, a, b) => (multi(series) ? a : b);
const shortDate = (iso) => new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: '2-digit' });
