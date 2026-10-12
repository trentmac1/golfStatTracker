const UA = { 'User-Agent': 'golfStatTracker/0.1 (github.com/trentmac1/golfStatTracker)' };
for (const [label, lat, lon] of [['Joyner (North Pine GC)', -27.2745, 152.9446], ['North Lakes', -27.2305, 153.0225]]) {
  const q = `[out:json][timeout:25];(nwr["leisure"="golf_course"](around:2500,${lat},${lon});way["golf"](around:2500,${lat},${lon}););out tags center;`;
  for (const srv of ['https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass-api.de/api/interpreter']) {
    try {
      const res = await fetch(`${srv}?${new URLSearchParams({ data: q })}`, { headers: UA });
      const text = await res.text();
      const d = JSON.parse(text);
      const c = d.elements.filter((e) => e.tags?.leisure === 'golf_course').map((e) => `${e.tags.name ?? '(no name)'} ${e.type}/${e.id}`);
      const g = {}; for (const e of d.elements.filter((x) => x.tags?.golf)) g[e.tags.golf] = (g[e.tags.golf] ?? 0) + 1;
      console.log(`## ${label}: courses [${c.join(' | ')}] golf features ${JSON.stringify(g)}`);
      break;
    } catch (err) { console.log(label, srv, 'ERR', String(err.message).slice(0, 80)); await new Promise((r) => setTimeout(r, 3000)); }
  }
}
