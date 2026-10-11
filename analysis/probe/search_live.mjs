// Run the app's own search code against the live services.
const G = await import('../../webapp/js/greens.js');
const UA = { 'User-Agent': 'golfStatTracker/0.1 (github.com/trentmac1/golfStatTracker)', Referer: 'https://trentmac1.github.io/golfStatTracker/' };
const fetchFn = (url, opts = {}) => fetch(url, { ...opts, headers: { ...(opts.headers || {}), ...UA } });
const brisbane = { lat: -27.45, lon: 152.98 };
const t0 = Date.now();
const near = await G.nearbyCourses({ lat: -27.4431, lon: 152.9612 }, { fetchFn });
console.log(`nearby (${((Date.now() - t0) / 1000).toFixed(1)}s): ${near.length} courses:`, near.slice(0, 12).map((c) => `${c.name} ${c.km.toFixed(1)}km`).join(' | '));
for (const q of ['kaperra', 'keperra', 'wantima', 'wantima golf', 'pine rivers', 'nudgee', 'north lakes', 'indooroopilly']) {
  const t = Date.now();
  try {
    const r = await G.searchCourses(q, { near: brisbane, fetchFn });
    console.log(`search ${JSON.stringify(q)} (${((Date.now() - t) / 1000).toFixed(1)}s):`, r.slice(0, 4).map((c) => c.name).join(' | ') || 'NOTHING');
  } catch (err) { console.log(`search ${q} ERROR`, err.message); }
  await new Promise((r) => setTimeout(r, 1200));
}
for (const q of ['keperra', 'wantima']) {
  const [place] = await G.searchCourses(q, { near: brisbane, fetchFn });
  try {
    const osm = await G.loadCourseOsm(place, { fetchFn });
    const holes = G.holesFromOsm(osm);
    const greens = osm.elements.filter((e) => e.tags?.golf === 'green').length;
    console.log(`${place.name}: osm elements ${osm.elements.length}, greens ${greens}, holes ${holes ? holes.length : 'not numbered'}, pars ${holes ? holes.map((h) => h.par).join('') : '-'}`);
  } catch (err) { console.log(place?.name, 'load ERROR', err.message); }
}
