// Leaflet map with satellite imagery. Leaflet is loaded from a CDN in
// index.html and cached by the service worker, so it works offline after the
// first visit. Imagery tiles you've viewed are cached too.
const L = () => window.L;

export const hasMap = () => !!window.L;

export function createMap(el, centre, zoom = 17) {
  const map = L().map(el, {
    zoomControl: false,
    attributionControl: true,
    tap: true,
    zoomSnap: 0.25,
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
