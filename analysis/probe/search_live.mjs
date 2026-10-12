// Is North Pine (and a few others) mapped? What's tagged on them?
const G = await import('../../webapp/js/greens.js');
const UA = { 'User-Agent': 'golfStatTracker/0.1 (github.com/trentmac1/golfStatTracker)', Referer: 'https://trentmac1.github.io/golfStatTracker/' };
const fetchFn = (url, opts = {}) => fetch(url, { ...opts, headers: { ...(opts.headers || {}), ...UA } });
const N = 'https://nominatim.openstreetmap.org/search?';
for (const q of ['North Pine golf', 'North Pine Country Golf Club', 'North Pine', 'Petrie golf course', 'North Lakes golf', 'Mango Hill golf']) {
  const d = await (await fetchFn(N + new URLSearchParams({ q, format: 'jsonv2', limit: 8, countrycodes: 'au' }))).json();
  console.log(`\n## ${q}:`, d.map((r) => `${r.category}/${r.type} | ${r.name} | ${r.display_name.slice(0, 80)}`).join('\n   ') || 'none');
  await new Promise((r) => setTimeout(r, 1200));
}
// every golf feature around North Pine / Kallangur / Petrie
const lat = -27.25, lon = 153.0;
const q = `[out:json][timeout:40];(nwr["leisure"="golf_course"](around:9000,${lat},${lon});nwr["golf"](around:9000,${lat},${lon}););out tags center;`;
for (const srv of ['https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass-api.de/api/interpreter']) {
  try {
    const d = await (await fetchFn(`${srv}?${new URLSearchParams({ data: q })}`)).json();
    const courses = d.elements.filter((e) => e.tags?.leisure === 'golf_course');
    console.log('\n## courses within 9 km of Kallangur/Petrie:', courses.map((e) => `${e.tags.name ?? '(no name)'} @${(e.center ?? e).lat?.toFixed(4)},${(e.center ?? e).lon?.toFixed(4)} ${e.type}`).join(' | '));
    const byGolf = {};
    for (const e of d.elements.filter((x) => x.tags?.golf)) byGolf[e.tags.golf] = (byGolf[e.tags.golf] ?? 0) + 1;
    console.log('golf features:', JSON.stringify(byGolf));
    break;
  } catch (err) { console.log(srv, 'ERR', err.message); }
}
