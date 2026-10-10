// Round summary: scorecard and totals.
import * as db from '../db.js';
import { deriveRound } from '../stats.js';
import { roundCsv } from '../export.js';
import { esc, m, one, signed, pctText, fmtDate, toast, confirmSheet, saveFile } from '../ui.js';

export function scoreClass(toPar) {
  if (toPar == null) return '';
  if (toPar <= -2) return 'eagle';
  if (toPar === -1) return 'birdie';
  if (toPar === 0) return 'par';
  if (toPar === 1) return 'bogey';
  return 'double';
}

export function statTiles(r) {
  const tile = (v, label, sub = '') => `<div class="tile"><b>${v}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ''}</div>`;
  return `
    ${tile(r.fairwayChances ? `${r.fairwaysHit}/${r.fairwayChances}` : '–', 'Fairways', r.fairwayChances ? `L ${r.fairwayMisses.left} · R ${r.fairwayMisses.right} · Short ${r.fairwayMisses.short}` : '')}
    ${tile(r.holesPlayed ? `${r.gir}/${r.holesPlayed}` : '–', 'Greens in reg.', pctText(r.girPct))}
    ${tile(r.putts || '–', 'Putts', r.puttsPerGir != null ? `${one(r.puttsPerGir)} per GIR` : '')}
    ${tile(r.threePutts, '3-putts')}
    ${tile(r.scrambleChances ? `${r.scrambles}/${r.scrambleChances}` : '–', 'Scrambling')}
    ${tile(r.sandChances ? `${r.sandSaves}/${r.sandChances}` : '–', 'Sand saves')}
    ${tile(r.penalties, 'Penalties')}
    ${tile(r.chips, 'Chips & pitches')}
    ${tile(r.drivingDistance != null ? `${m(r.drivingDistance)} m` : '–', 'Driving', r.drivingDistance ? (r.drivingUsesDriverOnly ? 'driver only' : 'all tee shots, par 4–5') : '')}
    ${tile(r.proximity != null ? `${m(r.proximity)} m` : '–', 'Approach to centre', 'ball on green')}`;
}

export async function cardView(root, { roundId }) {
  const round = await db.get('rounds', roundId);
  if (!round) { root.innerHTML = `<p class="empty">That round isn't on this phone.</p>`; return {}; }
  const course = await db.get('courses', round.courseId);
  const shots = await db.shotsForRound(roundId);
  const r = deriveRound(course, round, shots);

  const half = (from, to, label) => {
    const hs = r.holes.slice(from, to);
    const par = hs.reduce((a, h) => a + h.par, 0);
    const sc = hs.filter((h) => h.complete).reduce((a, h) => a + h.score, 0);
    const pt = hs.filter((h) => h.complete).reduce((a, h) => a + (h.putts ?? 0), 0);
    return `
      <table class="card-table">
        <thead><tr><th>Hole</th>${hs.map((h) => `<th><a href="#/round/${roundId}/hole/${h.hole}">${h.hole}</a></th>`).join('')}<th>${label}</th></tr></thead>
        <tbody>
          <tr class="par"><th>Par</th>${hs.map((h) => `<td>${h.par}</td>`).join('')}<td>${par}</td></tr>
          <tr class="sc"><th>Score</th>${hs.map((h) => `<td><span class="sc-mark ${h.complete ? scoreClass(h.toPar) : ''}">${h.complete ? h.score : h.started ? '·' : ''}</span></td>`).join('')}<td>${sc || ''}</td></tr>
          <tr><th>Putts</th>${hs.map((h) => `<td>${h.putts ?? ''}</td>`).join('')}<td>${pt || ''}</td></tr>
          <tr><th>FW</th>${hs.map((h) => `<td>${h.par < 4 ? '' : { hit: '●', left: '←', right: '→', short: '↓' }[h.fairway] ?? ''}</td>`).join('')}<td></td></tr>
          <tr><th>GIR</th>${hs.map((h) => `<td>${h.gir ? '●' : h.gir === false ? '○' : ''}</td>`).join('')}<td></td></tr>
        </tbody>
      </table>`;
  };

  const active = round.status !== 'done';
  root.innerHTML = `
    <section class="page">
      <header class="page-head">
        <a class="back" href="${active ? `#/round/${roundId}/hole/${round.currentHole ?? 1}` : '#/rounds'}">‹ ${active ? `Hole ${round.currentHole ?? 1}` : 'Rounds'}</a>
        <h1>${esc(course.name)}</h1>
        <p class="sub">${fmtDate(round.date)}${active ? ' · in progress' : ''}</p>
      </header>
      <div class="total">
        <b>${r.holesPlayed ? r.score : '–'}</b>
        <span>${r.holesPlayed ? `${signed(r.toPar)} · ${r.holesPlayed} ${r.holesPlayed === 1 ? 'hole' : 'holes'}` : 'No holes finished yet'}</span>
      </div>
      <div class="card-scroll">${half(0, 9, 'Out')}${half(9, 18, 'In')}</div>
      <p class="legend"><span class="sc-mark birdie">3</span> birdie or better <span class="sc-mark bogey">5</span> bogey <span class="sc-mark double">6</span> double+ · tap a hole number to open it</p>
      <h2>This round</h2>
      <div class="tiles">${statTiles(r)}</div>
      <div class="btn-col">
        ${active ? `<button class="btn primary" data-a="finish">Finish round</button>` : `<button class="btn ghost" data-a="reopen">Reopen round</button>`}
        <button class="btn ghost" data-a="csv">Export round (CSV)</button>
        <button class="btn ghost danger-text" data-a="delete">Delete round</button>
      </div>
    </section>`;

  root.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    if (a === 'finish') {
      const unfinished = r.holes.filter((h) => !h.complete).length;
      if (unfinished && !(await confirmSheet(`${unfinished} ${unfinished === 1 ? 'hole has' : 'holes have'} no putts or score. Finish anyway?`, 'Finish round', false))) return;
      round.status = 'done';
      round.finishedAt = new Date().toISOString();
      await db.put('rounds', round);
      toast('Round finished');
      location.hash = '#/rounds';
    } else if (a === 'reopen') {
      round.status = 'active';
      await db.put('rounds', round);
      location.hash = `#/round/${roundId}/hole/${round.currentHole ?? 1}`;
    } else if (a === 'csv') {
      await saveFile(`round-${round.date.slice(0, 10)}.csv`, roundCsv(course, round, shots), 'text/csv');
    } else if (a === 'delete') {
      if (await confirmSheet('Delete this round and all its shots? Export a backup first if you might want it.', 'Delete round')) {
        await db.deleteRound(roundId);
        toast('Round deleted');
        location.hash = '#/rounds';
      }
    }
  });
  return {};
}
