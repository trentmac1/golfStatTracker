// Leaflet map with satellite imagery. Leaflet is loaded from a CDN in
// index.html and cached by the service worker, so it works offline after the
// first visit. Imagery tiles you've viewed are cached too.
// Rotation comes from the leaflet-rotate plugin; without it the map stays
// north-up and everything else still works.
import { bearing, distance, fromLocal, toLocal } from './geo.js';

const L = () => window.L;

export const hasMap = () => !!window.L;
export const canRotate = () => !!window.L?.Map?.prototype?.setBearing;

export function createMap(el, centre, zoom = 17, { rotate = false } = {}) {
  const map = L().map(el, {
    zoomControl: false,
    attributionControl: true,
    tap: true,
    zoomSnap: 0.25,
    rotate: rotate && canRotate(),
    rotateControl: false,
    touchRotate: false,
    shiftKeyRotate: false,
    bearing: 0,
  }).setView([centre.lat, centre.lon], zoom);
  L().tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxNativeZoom: 19, maxZoom: 21, attribution: '© Esri, Maxar' },
  ).addTo(map);
  map.attributionControl.setPrefix(false);
  return map;
}

export const ll = (p) => [p.lat, p.lon];

export function pin(p, cls, html = '', opts = {}) {
  return L().marker(ll(p), {
    icon: L().divIcon({ className: `pin ${cls}`, html, iconSize: null }),
    keyboard: false,
    ...opts,
  });
}

export function line(points, cls) {
  return L().polyline(points.map(ll), { className: cls, interactive: false });
}

export function circle(p, radius, cls) {
  return L().circle(ll(p), { radius, className: cls, interactive: false });
}

export function fit(map, points, maxZoom = 18) {
  const pts = points.filter(Boolean);
  if (!pts.length) return false;
  if (pts.length === 1) { map.setView(ll(pts[0]), Math.min(maxZoom, 18)); return true; }
  map.fitBounds(L().latLngBounds(pts.map(ll)), { padding: [36, 36], maxZoom });
  return true;
}

// Point the map so the line from `from` to `to` runs straight up the screen,
// and zoom so both fit between the overlays (yardage box on top).
export function frame(map, from, to, { rotate = true, padTop = 120, padBottom = 44, pad = 24 } = {}) {
  const el = map.getContainer();
  const h = el.clientHeight || 300;
  const w = el.clientWidth || 300;
  const d = Math.max(distance(from, to), 20);
  const lat = (from.lat + to.lat) / 2;
  const avail = Math.max(120, h - padTop - padBottom);
  // metres per pixel at zoom z: 40075016.686 * cos(lat) / (256 * 2^z)
  const k = (40075016.686 * Math.cos((lat * Math.PI) / 180)) / 256;
  const zH = Math.log2((k * avail) / (d * 1.1));
  const zW = rotate ? Infinity : Math.log2((k * (w - 2 * pad)) / (d * 1.1));
  const z = Math.max(15, Math.min(19, Math.floor(Math.min(zH, zW) * 4) / 4));
  // Centre the pair in the space between the overlays, not the whole map.
  const mpp = k / 2 ** z;
  const shift = ((padTop - padBottom) / 2) * mpp;
  const v = toLocal(from, to);
  const len = Math.hypot(v.x, v.y) || 1;
  const mid = fromLocal(from, { x: v.x / 2 + (v.x / len) * shift, y: v.y / 2 + (v.y / len) * shift });
  if (rotate && canRotate() && map.options.rotate) map.setBearing(-bearing(from, to));
  map.setView([mid.lat, mid.lon], z, { animate: false });
}

export function northUp(map) {
  if (canRotate() && map.options.rotate) map.setBearing(0);
}
