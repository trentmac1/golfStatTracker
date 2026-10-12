// Structure only: hole fields and how often stroke index is present.
const KEY = process.env.GCA_KEY; const BASE = 'https://api.golfcourseapi.com/v1';
for (const q of ['Pine Rivers', 'Keperra', 'Wantima']) {
  const s = await (await fetch(`${BASE}/search?${new URLSearchParams({ search_query: q })}`, { headers: { Authorization: `Key ${KEY}` } })).json();
  const id = s.courses?.[0]?.id; if (!id) continue;
  const d = await (await fetch(`${BASE}/courses/${id}`, { headers: { Authorization: `Key ${KEY}` } })).json();
  const c = d.course ?? d;
  const tees = [...(c.tees?.male ?? []), ...(c.tees?.female ?? [])];
  const keys = new Set(tees.flatMap((t) => t.holes.flatMap((h) => Object.keys(h))));
  const withSi = tees.filter((t) => t.holes.some((h) => h.handicap != null)).length;
  const names = tees.map((t) => `${t.tee_name}(${t.number_of_holes})`);
  console.log(`${q}: hole fields [${[...keys]}]; tees with stroke index ${withSi}/${tees.length}; tee names ${names.length} ${q === 'Keperra' ? names.join(', ') : ''}; course_name differs from club: ${c.course_name !== c.club_name}`);
}
