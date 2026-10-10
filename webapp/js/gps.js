// Phone GPS: a live watch for distances to the green, and a short sampling
// burst for "Mark ball" that takes the median of the best fixes.
import { median } from './geo.js';

const listeners = new Set();
let watchId = null;
let last = null;
let recent = []; // fixes from the last few seconds

export const supported = () => 'geolocation' in navigator;
export const latest = () => last;

function onFix(pos) {
  const c = pos.coords;
  last = { lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, time: pos.timestamp };
  recent.push(last);
  const cutoff = Date.now() - 15000;
  recent = recent.filter((f) => f.time >= cutoff);
  for (const fn of listeners) fn(last, null);
}
function onError(err) {
  for (const fn of listeners) fn(null, err);
}

export function start() {
  if (!supported() || watchId != null) return;
  watchId = navigator.geolocation.watchPosition(onFix, onError, {
    enableHighAccuracy: true, maximumAge: 0, timeout: 20000,
  });
}
export function stop() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}
export function subscribe(fn) {
  listeners.add(fn);
  start();
  return () => {
    listeners.delete(fn);
    if (!listeners.size) stop(); // GPS off when no screen needs it
  };
}

// Collect fixes for up to `maxMs`. Finish early once `want` fixes at or better
// than `goodAcc` metres are in. Returns the median position of the best half.
export function sample({ maxMs = 6000, want = 4, goodAcc = 6, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (!supported()) return reject(new Error('This browser has no location access.'));
    const t0 = Date.now();
    // Recent fixes from the live watch count if we have been standing here.
    const fixes = recent.filter((f) => Date.now() - f.time < 3000);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      unsub();
      clearTimeout(timer);
      if (!fixes.length) return reject(new Error('No GPS fix yet. Step into the open and try again.'));
      const sorted = [...fixes].sort((a, b) => a.accuracy - b.accuracy);
      const best = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 2)));
      resolve({
        lat: median(best.map((f) => f.lat)),
        lon: median(best.map((f) => f.lon)),
        accuracy: median(best.map((f) => f.accuracy)),
        fixes: fixes.length,
        time: Date.now(),
      });
    };
    const unsub = subscribe((fix, err) => {
      if (err && err.code === 1) { done = true; unsub(); clearTimeout(timer); reject(new Error('Location is blocked. Allow location for this site in Settings › Safari › Location.')); return; }
      if (!fix) return;
      fixes.push(fix);
      onProgress?.(fixes.length, fix.accuracy, Date.now() - t0);
      if (fixes.filter((f) => f.accuracy <= goodAcc).length >= want) finish();
    });
    const timer = setTimeout(finish, maxMs);
  });
}
