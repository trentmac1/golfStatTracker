// GolfCourseAPI check. Prints structure and coverage only, never the data
// itself (the terms don't allow republishing it, and this output is public).
const KEY = process.env.GCA_KEY;
if (!KEY) { console.log('No GOLFCOURSEAPI_KEY secret set.'); process.exit(0); }
const BASE = 'https://api.golfcourseapi.com/v1';
const shape = (v, depth = 0) => {
  if (Array.isArray(v)) return v.length ? `[${shape(v[0], depth + 1)}] x${v.length}` : '[]';
  if (v && typeof v === 'object') return depth > 4 ? '{…}' : `{${Object.entries(v).map(([k, x]) => `${k}: ${shape(x, depth + 1)}`).join(', ')}}`;
  return typeof v;
};
// CORS: what a phone browser would be told
for (const method of ['OPTIONS']) {
  const r = await fetch(`${BASE}/search?search_query=ashgrove`, { method, headers: { Origin: 'https://trentmac1.github.io', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
  console.log('preflight', r.status, JSON.stringify(Object.fromEntries([...r.headers].filter(([k]) => k.startsWith('access-control')))));
}
let first = true, first2 = true;
for (const q of ['Pine Rivers', 'Ashgrove', 'Keperra', 'North Pine', 'Wantima', 'Nudgee', 'Brookwater']) {
  const r = await fetch(`${BASE}/search?${new URLSearchParams({ search_query: q })}`, { headers: { Authorization: `Key ${KEY}`, Origin: 'https://trentmac1.github.io' } });
  const cors = r.headers.get('access-control-allow-origin');
  const d = await r.json().catch(() => null);
  const list = d?.courses ?? [];
  const au = list.filter((c) => /austral/i.test(c.location?.country ?? '') || /QLD|Queensland/i.test(c.location?.state ?? ''));
  console.log(`\n## ${q}: HTTP ${r.status} CORS ${cors} results ${list.length} in Australia ${au.length}`);
  if (first && list[0]) { console.log('course shape:', shape(list[0]).slice(0, 1500)); first = false; }
  for (const s0 of au.slice(0, 3)) {
    const dr = await fetch(`${BASE}/courses/${s0.id}`, { headers: { Authorization: `Key ${KEY}` } });
    const dd = await dr.json().catch(() => null);
    const c = dd?.course ?? dd;
    if (first2) { console.log('detail shape:', shape(c).slice(0, 1800)); first2 = false; }
    const tees = [...(Array.isArray(c?.tees?.male) ? c.tees.male : []), ...(Array.isArray(c?.tees?.female) ? c.tees.female : [])];
    const t = tees[0];
    console.log(`  match: name fields ok=${!!(c.club_name || c.course_name)}; city ${c.location?.city ?? '?'}; tees ${tees.length}; first tee holes ${t?.holes?.length ?? 0}; has par ${!!t?.holes?.[0]?.par}; has handicap ${t?.holes?.[0]?.handicap != null}; rating ${t?.course_rating != null}; slope ${t?.slope_rating != null}; lat/lon ${c.location?.latitude != null}`);
  }
  await new Promise((res) => setTimeout(res, 500));
}
