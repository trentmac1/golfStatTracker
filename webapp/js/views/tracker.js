// Tracker screen: connect to the tracker and watch its battery, GPS and
// sensors live. Phase 2 bring-up; shot sync builds on the same connection.
import { tracker, OP } from '../transport.js';
import { distance } from '../geo.js';
import { esc, toast } from '../ui.js';

const BUTTON_PIN = 3;   // matches firmware/src/config.h

function gpsText(s) {
  if (!s.gpsData) return { big: 'No data', sub: 'Nothing from the GPS board. Check it is seated the right way round.', cls: 'bad' };
  if (!s.gpsFix) return { big: 'Searching', sub: `${s.sats} satellite${s.sats === 1 ? '' : 's'} · go outside with a clear sky`, cls: 'warn' };
  return { big: 'Fix', sub: `${s.sats} satellites${s.hdop != null ? ` · HDOP ${s.hdop.toFixed(1)}` : ''}`, cls: 'good' };
}

function bar(v, max = 255) {
  const pct = Math.max(0, Math.min(100, Math.round((v / max) * 100)));
  return `<span class="meter"><i style="width:${pct}%"></i></span>`;
}

export async function trackerView(root) {
  let phone = null, watchId = null;

  const draw = () => {
    const t = tracker;
    const s = t.status, l = t.live;
    const stale = t.lastSeen && Date.now() - t.lastSeen > 5000;
    const hasBt = tracker.bluetoothAvailable();
    const stateLine = {
      idle: 'Not connected.',
      connecting: 'Connecting…',
      connected: `Connected to ${esc(t.name ?? 'tracker')}${t.kind === 'fake' ? ' (pretend)' : ''}${stale ? ' · no update for a few seconds' : ''}.`,
      lost: 'Connection lost. Bring the phone closer and reconnect.',
    }[t.state];

    let body = '';
    if (s) {
      const gps = gpsText(s);
      const tile = (big, label, sub = '', cls = '') => `<div class="tile ${cls}"><b>${big}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ''}</div>`;
      const gap = phone && l?.pos ? distance(phone, l.pos) : null;
      const busyNames = s.busyPins.map((p) => `D${p}`);
      body = `
        <div class="tiles tracker-tiles">
          ${tile(`${s.battery}%`, 'Battery', `${(s.batteryMv / 1000).toFixed(2)} V${s.charging ? ' · charging' : ''}`, s.battery <= 20 ? 'bad' : '')}
          ${tile(gps.big, 'GPS', gps.sub, gps.cls)}
          ${tile(`${s.gyroPeak}<small> °/s</small>`, 'Motion', s.imuOk ? 'Peak rotation each second. Give it a swing.' : 'IMU not found', s.imuOk ? '' : 'bad')}
          ${tile(bar(s.micLevel), 'Sound', s.micOk ? 'Clap near the tracker.' : 'Microphone not working', s.micOk ? '' : 'bad')}
          ${tile(String(s.buttonPresses), 'Button presses', s.buttonDown ? 'Held down now' : 'Press to count · hold 2 s for a round')}
          ${tile(s.roundActive ? 'On' : 'Off', 'Round', s.timeOk ? 'Clock set' : 'Clock not set yet')}
        </div>
        <h2>Position</h2>
        ${l?.pos ? `
          <p class="note">Tracker: ${l.pos.lat.toFixed(6)}, ${l.pos.lon.toFixed(6)}${l.altitude ? ` · ${Math.round(l.altitude)} m up` : ''}</p>
          ${phone ? `<p class="note">Phone: ${phone.lat.toFixed(6)}, ${phone.lon.toFixed(6)} (±${Math.round(phone.acc)} m). <b>${gap.toFixed(1)} m apart.</b> Within about 5 m is normal; stand still in the open for a minute for the best match.</p>`
            : '<button class="btn ghost" data-a="phone">Compare with the phone\'s GPS</button>'}`
          : '<p class="note">No position until the GPS has a fix.</p>'}
        <h2>Checks</h2>
        <ul class="check-list">
          <li class="${s.busyPins.includes(BUTTON_PIN) ? 'bad' : 'good'}">Button pin D${BUTTON_PIN}: ${s.busyPins.includes(BUTTON_PIN) ? 'something on the boards drives it. Don\'t wire the button there; tell Claude which pins are busy.' : 'free to use'}</li>
          <li>${busyNames.length ? `Pins in use by the boards: ${busyNames.join(', ')}` : 'No other pins in use by the boards'}</li>
          <li>Firmware ${esc(s.firmware)} · protocol ${s.proto}</li>
        </ul>
        ${t.state === 'connected' ? `<div class="btn-col">
          <button class="btn ghost" data-a="identify">Flash the tracker's lights</button>
          <button class="btn ghost" data-a="round">${s.roundActive ? 'End round on tracker' : 'Start round on tracker'}</button>
        </div>` : ''}`;
    }

    root.innerHTML = `
    <section class="page tracker">
      <header class="page-head"><a class="back" href="#/settings">‹ Settings</a><h1>Tracker</h1></header>
      <p class="note state-${t.state}">${stateLine}${t.error ? ` <span class="err">${esc(t.error)}</span>` : ''}</p>
      <div class="btn-col">
        ${t.state === 'connected' ? '<button class="btn ghost" data-a="disconnect">Disconnect</button>'
          : t.state === 'connecting' ? '<button class="btn primary" disabled>Connecting…</button>'
          : `${hasBt ? `<button class="btn primary" data-a="connect">${t.state === 'lost' ? 'Reconnect' : 'Connect tracker'}</button>` : ''}
             <button class="btn ghost" data-a="fake">Try a pretend tracker</button>`}
      </div>
      ${!hasBt ? `<p class="note">This browser can't use Bluetooth. On iPhone, install <b>Bluefy</b> from the App Store and open this app's address in it. Bluefy keeps its own copy of your data, so use Export and Import backup to move rounds across.</p>` : ''}
      ${body}
    </section>`;
  };

  const off = tracker.on(draw);
  draw();
  // Re-draw every couple of seconds so "no update" shows if notifications stop.
  const ticker = setInterval(() => { if (tracker.state === 'connected') draw(); }, 2500);

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    try {
      if (a === 'connect') await tracker.connect('ble');
      else if (a === 'fake') {
        // Put the pretend tracker where the phone is, if it can tell quickly.
        const near = await new Promise((res) => {
          if (!navigator.geolocation) return res(undefined);
          navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lon: p.coords.longitude }), () => res(undefined), { timeout: 4000, maximumAge: 60000 });
        });
        await tracker.connect('fake', near ? { near } : {});
      }
      else if (a === 'disconnect') await tracker.disconnect();
      else if (a === 'identify') { await tracker.send(OP.identify); toast('Tracker lights flashing'); }
      else if (a === 'round') await tracker.send(tracker.status?.roundActive ? OP.endRound : OP.startRound);
      else if (a === 'phone') {
        if (!navigator.geolocation) throw new Error('No location on this browser');
        watchId = navigator.geolocation.watchPosition(
          (p) => { phone = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }; draw(); },
          (err) => toast(`Location: ${err.message}`, 'warn'),
          { enableHighAccuracy: true, maximumAge: 0 });
        toast('Getting the phone\'s position…');
      }
    } catch (err) {
      toast(err.message || String(err), 'warn');
    }
  });

  return {
    destroy() {
      off(); clearInterval(ticker);
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
    },
  };
}
