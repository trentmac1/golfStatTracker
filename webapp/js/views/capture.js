// Training data (Phase 3): the tracker's capture mode, syncing its log of
// swing snippets and button labels to the phone, and exporting it as JSON for
// the Phase 4 analysis.
import { tracker, OP } from '../transport.js';
import * as db from '../db.js';
import { decodeRecord, sessions, exportJson, swingTraces, impactOffsetMs } from '../capturelog.js';
import { APP_VERSION } from '../config.js';
import { esc, toast, saveFile, confirmSheet } from '../ui.js';

// Round mode defaults, from the 15–16 Oct sessions: trigger 250 and an impact
// of at least 1000 within -400..+250 ms of the peak kept all 14 full shots and
// cut walking from about 16 saved swings a minute to under 1.
const ROUND = { trigger: 250, gate: 1000 };
const hex = (id) => (id >>> 0).toString(16).padStart(8, '0');
const timeText = (unix) => (unix ? new Date(unix * 1000).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' }) : '–');
const dateText = (unix) => (unix ? new Date(unix * 1000).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }) : 'Unknown date');

// Smallest seq of this log not yet on the phone: where the next sync starts.
function cursor(rows) {
  const have = new Set(rows.map((r) => r.seq));
  let s = 0;
  while (have.has(s)) s++;
  return s;
}

function sparkline(bytes) {
  const t = swingTraces(bytes);
  if (!t) return '';
  const W = 300, H = 64, r = t.record;
  const gMax = Math.max(300, ...t.gyro);
  const gyro = t.gyro.map((g, i) => `${((i / (t.gyro.length - 1)) * W).toFixed(1)},${(H - 4 - (g / gMax) * (H - 10)).toFixed(1)}`).join(' ');
  // Envelope: max per pixel column, on a square-root scale like the stored values.
  const cols = new Array(W).fill(0);
  t.record.env.forEach((v, j) => {
    const ms = r.envStartMs + (j * 1000) / r.envRateHz;
    const x = Math.floor(((ms + 1500) / 2000) * W);
    if (x >= 0 && x < W) cols[x] = Math.max(cols[x], v);
  });
  const env = cols.map((v, x) => (v > 12 ? `M${x},${H}V${(H - (v / 255) * (H - 6)).toFixed(1)}` : '')).join('');
  const px = (r.imuPeakIndex / (r.imuCount - 1)) * W;
  return `<svg class="swing-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${env}" class="env"/><line x1="${px}" x2="${px}" y1="0" y2="${H}" class="peak"/>
    <polyline points="${gyro}" class="gyro"/></svg>`;
}

// Decoding a swing for its picture is the slow part; do it once per record.
const drawn = new Map();
function swingBits(w) {
  if (!drawn.has(w.id)) drawn.set(w.id, { spark: sparkline(w.bytes), off: impactOffsetMs(w.bytes) });
  return drawn.get(w.id);
}

export async function captureView(root) {
  let rows = [];          // everything on the phone
  let busy = null;        // 'sync' | 'erase' | 'export'
  let msg = '';
  let opened = new Set(); // session keys shown open

  const load = async () => { rows = await db.all('captures'); };

  const draw = () => {
    const t = tracker, c = t.capture;
    const stateLine = {
      idle: 'Not connected.', connecting: 'Connecting…',
      connected: `Connected to ${esc(t.name ?? 'tracker')}${t.kind === 'fake' ? ' (pretend)' : ''}.`,
      lost: 'Connection lost. Bring the phone closer and reconnect.',
    }[t.state];

    let trackerHtml = '';
    if (t.state === 'connected' && !t.hasCapture) {
      trackerHtml = `<p class="note warn-note">This tracker has firmware ${esc(t.status?.firmware ?? '')}, which has no capture mode. Update it to 0.2.0 or later (see the firmware release).</p>`;
    } else if (c) {
      const logRows = rows.filter((r) => r.logId === c.logId);
      const from = cursor(logRows);
      const newCount = Math.max(0, c.nextSeq - from);
      const pct = c.totalKb ? Math.round((c.usedKb / c.totalKb) * 100) : 0;
      const sync = t.sync;
      const tile = (big, label, sub = '', cls = '', a = '') => `<${a ? `button data-a="${a}"` : 'div'} class="tile ${cls}"><b>${big}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ''}</${a ? 'button' : 'div'}>`;
      trackerHtml = `
        <div class="tiles tracker-tiles">
          ${tile(c.session ? 'On' : 'Off', 'Round', c.session ? 'Swings are being saved. Tap to end.' : 'Tap to start, or hold the button 2 s.', c.session ? 'good' : '', 'round')}
          ${tile(c.enabled ? 'On' : 'Off', 'Capture', c.enabled ? 'Tap to turn off' : 'Tap to turn on', c.enabled ? '' : 'warn', 'capture')}
          ${tile(String(c.swings), 'Swings saved', `${c.labels} button label${c.labels === 1 ? '' : 's'}`)}
          ${tile(`${pct}%`, 'Tracker storage', `${c.usedKb} of ${c.totalKb} KB${c.full ? ' · full' : ''}`, c.full ? 'bad' : pct > 80 ? 'warn' : '')}
        </div>
        ${c.soundGate != null ? `
        <div class="mode-row" role="group" aria-label="Capture mode">
          <button class="btn ${c.soundGate ? 'ghost' : 'primary'}" data-a="mode-range">Range</button>
          <button class="btn ${c.soundGate ? 'primary' : 'ghost'}" data-a="mode-round">Round</button>
        </div>
        <p class="note">${c.soundGate
          ? `<b>Round mode:</b> a swing is saved only if you were still at address, the rotation built up through a downswing, and an impact is heard at the strike, so walking, knocks and reaching for the button don't fill the tracker. Chips and putts are usually too quiet: give the button a press after them, and the press is saved with its GPS position.${c.gatedOut ? ` ${c.gatedOut} silent swing${c.gatedOut === 1 ? '' : 's'} skipped since the tracker started.` : ''}`
          : '<b>Range mode:</b> every swing that reaches the trigger is saved, practice swings and chips included. Use it at the range; it fills the tracker quickly if you walk around.'}</p>` : ''}
        <div class="trigger-row">
          <span>Swing trigger <b>${c.trigger} °/s</b></span>
          <button class="btn ghost small" data-a="trig-down" aria-label="Lower trigger">−</button>
          <button class="btn ghost small" data-a="trig-up" aria-label="Raise trigger">+</button>
        </div>
        ${c.soundGate ? `<div class="trigger-row">
          <span>Impact needed <b>${c.soundGate}</b></span>
          <button class="btn ghost small" data-a="gate-down" aria-label="Lower impact level">−</button>
          <button class="btn ghost small" data-a="gate-up" aria-label="Raise impact level">+</button>
        </div>` : ''}
        <p class="note">${c.soundGate ? 'Round mode uses 250 °/s and impact 1000. If a full shot isn\'t saved, lower the impact level; if walking still saves swings, raise it.' : 'A swing is saved whenever the rotation reaches the trigger: 250 °/s for full swings, 150 for chips and pitches.'}${c.soundGate == null ? ' Update the tracker to firmware 0.3.0 for round mode.' : ''} Settings stay on the tracker when it restarts${c.soundGate == null ? ' (firmware 0.3.0 and later)' : ''}.</p>
        ${!c.flashOk ? '<p class="note warn-note">The tracker can\'t use its flash storage, so nothing is being saved. Send Claude the serial log.</p>' : ''}
        ${c.imuOverruns ? `<p class="note warn-note">The motion sensor overflowed ${c.imuOverruns} time${c.imuOverruns === 1 ? '' : 's'}; some swings may have gaps (they're flagged in the export).</p>` : ''}
        <h2>Sync</h2>
        ${sync ? `<p class="note">Syncing… ${sync.records} record${sync.records === 1 ? '' : 's'} (${Math.round(sync.got / 1024)} KB)${sync.errors ? `, ${sync.errors} chunk${sync.errors === 1 ? '' : 's'} lost` : ''}.</p>`
          : `<p class="note">${newCount ? `${newCount} record${newCount === 1 ? '' : 's'} on the tracker ${newCount === 1 ? 'isn\'t' : 'aren\'t'} on this phone yet.` : 'Everything on the tracker is on this phone.'} Log ${hex(c.logId)}.</p>`}
        <div class="btn-col">
          <button class="btn primary" data-a="sync" ${busy || !newCount ? 'disabled' : ''}>${busy === 'sync' ? 'Syncing…' : newCount ? `Sync ${newCount} record${newCount === 1 ? '' : 's'}` : 'Synced'}</button>
          <button class="btn ghost" data-a="erase" ${busy || newCount || c.nextSeq <= 1 ? 'disabled' : ''}>Clear the tracker's storage</button>
        </div>
        <p class="note">Clearing only works once everything is synced, and the phone keeps its copy. Clear it after exporting, before the next session.</p>`;
    }

    // Sessions, per log (seq order only means something within one log).
    const byLog = new Map();
    for (const r of rows) { if (!byLog.has(r.logId)) byLog.set(r.logId, []); byLog.get(r.logId).push(r); }
    const list = [];
    for (const [logId, rs] of byLog) for (const s of sessions(rs)) list.push({ ...s, key: `${logId}-${s.startSeq}` });
    list.sort((a, b) => (b.start ?? 0) - (a.start ?? 0));
    const totals = list.reduce((a, s) => ({ swings: a.swings + s.swings.length, real: a.real + s.real, missed: a.missed + s.missed }), { swings: 0, real: 0, missed: 0 });

    const sessionHtml = list.map((s) => {
      const open = opened.has(s.key);
      const swingRows = open ? s.swings.map((w) => {
        const { spark, off } = swingBits(w);
        const lab = s.labelledSeqs.has(w.seq);
        const press = s.pressSeqs.has(w.seq);
        return `<li class="swing-row ${lab ? 'real' : press ? 'press' : ''}">
          <div class="swing-meta"><b>${timeText(w.time)}</b><span>${w.peakGyro} °/s</span>
            <span>${off == null ? 'no impact heard' : `impact ${off > 0 ? '+' : ''}${off} ms`}</span>
            <span class="tag">${lab ? 'Shot' : press ? 'Button press' : 'Not labelled'}</span></div>
          ${spark}
        </li>`;
      }).join('') : '';
      return `<details class="capture-session" data-key="${esc(s.key)}" ${open ? 'open' : ''}>
        <summary><span><b>${dateText(s.start)}</b> ${timeText(s.start)}${s.end ? `–${timeText(s.end)}` : s.ended ? '' : ' (still on)'}</span>
          <small>${s.swings.length} swing${s.swings.length === 1 ? '' : 's'} · ${s.real} labelled shot${s.real === 1 ? '' : 's'} · ${s.pressSeqs.size ? `${s.pressSeqs.size} button · ` : ''}${s.swings.length - s.real - s.pressSeqs.size} other${s.missed ? ` · ${s.missed} missed` : ''}</small></summary>
        ${open ? `<ul class="swing-list">${swingRows || '<li class="note">No swings in this session.</li>'}</ul>
          ${s.missed ? `<p class="note">${s.missed} button press${s.missed === 1 ? '' : 'es'} had no swing 1.5–8 s before: shots the trigger missed.</p>` : ''}` : ''}
      </details>`;
    }).join('');

    root.innerHTML = `
    <section class="page tracker capture">
      <header class="page-head"><a class="back" href="#/tracker">‹ Tracker</a><h1>Training data</h1></header>
      <p class="note state-${t.state}">${stateLine}${t.error ? ` <span class="err">${esc(t.error)}</span>` : ''}</p>
      ${t.state !== 'connected' ? `<div class="btn-col">
        ${tracker.bluetoothAvailable() ? `<button class="btn primary" data-a="connect">${t.state === 'lost' ? 'Reconnect' : 'Connect tracker'}</button>` : ''}
        <button class="btn ghost" data-a="fake">Try a pretend tracker</button></div>` : ''}
      ${trackerHtml}
      ${msg ? `<p class="note" id="capMsg">${esc(msg)}</p>` : ''}
      <h2>On this phone</h2>
      <p class="note">${list.length ? `${totals.swings} swings in ${list.length} session${list.length === 1 ? '' : 's'}: ${totals.real} labelled as shots${totals.missed ? `, ${totals.missed} missed by the trigger` : ''}.` : 'Nothing synced yet.'}</p>
      <div class="btn-col"><button class="btn ghost" data-a="export" ${busy || !rows.length ? 'disabled' : ''}>Export training data (JSON)</button></div>
      ${sessionHtml}
      <h2>How to collect it</h2>
      <ol class="how-list">
        <li>Tracker in your <b>front trouser pocket</b>, the same way every time.</li>
        <li>Pick <b>Range</b> at the range or <b>Round</b> on the course, then start a round: hold the button 2 s (two flashes every 2 s while it's on), or tap the Round tile above.</li>
        <li>Swing as normal. A short magenta flash means a swing was saved. Practice swings and waggles get saved too; that's what the detector learns to ignore.</li>
        <li>After each <b>real shot</b>, once the follow-through is done, give the button one short press (white blink), 2–5 s after the shot. Don't press for practice swings.</li>
        <li>End the round (hold 2 s), sync here, export, then clear the tracker. It holds about 290 swings; on the course, sync and clear at the turn if it's over half full.</li>
      </ol>
    </section>`;
  };

  await load();
  draw();
  const off = tracker.on(draw);

  root.addEventListener('toggle', (e) => {
    const d = e.target.closest?.('details.capture-session');
    if (!d) return;
    const k = d.dataset.key;
    if (d.open && !opened.has(k)) { opened.add(k); draw(); }
    else if (!d.open && opened.has(k)) { opened.delete(k); draw(); }
  }, true);

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    const c = tracker.capture;
    try {
      if (a === 'connect') await tracker.connect('ble');
      else if (a === 'fake') await tracker.connect('fake');
      else if (a === 'round') await tracker.send(c.session ? OP.endRound : OP.startRound);
      else if (a === 'capture') await tracker.send(OP.setCapture, !c.enabled);
      else if (a === 'mode-round') { await tracker.send(OP.setTrigger, ROUND.trigger); await tracker.send(OP.setSoundGate, ROUND.gate); toast('Round mode: only swings with an impact are saved'); }
      else if (a === 'mode-range') { await tracker.send(OP.setSoundGate, 0); toast('Range mode: every swing is saved'); }
      else if (a === 'gate-down') await tracker.send(OP.setSoundGate, Math.max(250, c.soundGate - 250));
      else if (a === 'gate-up') await tracker.send(OP.setSoundGate, Math.min(20000, c.soundGate + 250));
      else if (a === 'trig-down') await tracker.send(OP.setTrigger, Math.max(30, c.trigger - 10));
      else if (a === 'trig-up') await tracker.send(OP.setTrigger, Math.min(2000, c.trigger + 10));
      else if (a === 'sync') {
        busy = 'sync'; msg = ''; draw();
        const logId = c.logId;
        const from = cursor(rows.filter((r) => r.logId === logId));
        let bad = 0;
        const res = await tracker.syncLog(from, async (bytes) => {
          const r = decodeRecord(bytes);
          if (!r.crcOk) { bad++; return; }
          const row = { ...r, id: `${logId}-${r.seq}`, logId, bytes, syncedAt: new Date().toISOString() };
          await db.put('captures', row);
        });
        await db.setSetting('captureLastSync', new Date().toISOString());
        await load();
        msg = `Synced ${res.records - bad} record${res.records - bad === 1 ? '' : 's'}.${bad ? ` ${bad} came through damaged; sync again to fetch them.` : ''}`;
      } else if (a === 'export') {
        busy = 'export'; draw();
        const data = exportJson(rows, { appVersion: APP_VERSION });
        const n = data.logs.reduce((k, l) => k + l.sessions.reduce((j, s) => j + s.swings.length, 0), 0);
        await saveFile(`golf-tracker-capture-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data), 'application/json');
        await db.setSetting('captureLastExport', new Date().toISOString());
        msg = `Exported ${n} swings.`;
      } else if (a === 'erase') {
        const [lastSync, lastExport] = await Promise.all([db.getSetting('captureLastSync', null), db.getSetting('captureLastExport', null)]);
        const unexported = !lastExport || (lastSync && lastSync > lastExport);
        const ok = await confirmSheet(`Clear the tracker's storage? This phone keeps its copy of all ${c.swings} swings.${unexported ? ' You haven\'t exported since the last sync, so export too before deleting anything from this phone.' : ''}`, 'Clear tracker');
        if (!ok) return;
        busy = 'erase'; draw();
        await tracker.send(OP.eraseLog, c.logId);
        msg = 'Tracker storage cleared.';
      }
    } catch (err) {
      msg = err.message || String(err);
      toast(msg, 'warn');
    } finally {
      if (['sync', 'export', 'erase'].includes(a)) { busy = null; draw(); }
    }
  });

  return { destroy() { off(); } };
}
