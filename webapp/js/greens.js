// Green shapes and slopes.
//
// Outlines come from OpenStreetMap (golf=green, matched to golf=hole by its
// ref number). Heights come from the Queensland Government's bare-ground
// LiDAR terrain model (QldDem, 0.5–1 m), fetched as one small float32 TIFF per
// green. Both are fetched once from the phone and saved with the course, so
// the preview works offline.
import { toLocal, fromLocal, distance } from './geo.js';

export const DEM_URL = 'https://spatial-img.information.qld.gov.au/arcgis/rest/services/Elevation/QldDem/ImageServer';
// Mirrors in order of how reliably they answered (Oct 2026); the main server
// often times out. Queries go as GET, which needs no CORS preflight.
const OVERPASS = [
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];

async function overpass(q, { fetchFn = fetch, signal, timeoutMs = 25000 } = {}) {
  let last;
  for (const url of [...OVERPASS, ...OVERPASS]) { // a second pass: these servers are busy, not down
    if (last) await new Promise((r) => setTimeout(r, 1500));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      const res = await fetchFn(`${url}?${new URLSearchParams({ data: q })}`, { signal: ctl.signal });
      if (!res.ok) throw new Error(`server said ${res.status}`);
      return await res.json();
    } catch (err) {
      last = err;
      if (signal?.aborted) throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw new Error(`Couldn't reach OpenStreetMap's map servers (${last?.name === 'AbortError' ? 'timed out' : last?.message ?? 'no response'}). Try again in a minute.`);
}
export const CREDITS = 'Green outlines © OpenStreetMap contributors (ODbL). Heights © State of Queensland (QldDem LiDAR).';

// ---------- geometry helpers ----------
const centroidOf = (poly) => ({
  lat: poly.reduce((a, p) => a + p.lat, 0) / poly.length,
  lon: poly.reduce((a, p) => a + p.lon, 0) / poly.length,
});

export function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.lat > pt.lat) !== (b.lat > pt.lat) &&
        pt.lon < ((b.lon - a.lon) * (pt.lat - a.lat)) / (b.lat - a.lat) + a.lon) inside = !inside;
  }
  return inside;
}

function polyDistance(pt, poly) {
  if (pointInPolygon(pt, poly)) return 0;
  return Math.min(...poly.map((p) => distance(pt, p)));
}

// Where the line from `from` through the green centre enters and leaves the
// polygon: the green's front and back along the line of play.
export function frontBack(poly, from, centre) {
  const c = centre ?? centroidOf(poly);
  const v = toLocal(c, from);
  const len = Math.hypot(v.x, v.y) || 1;
  const u = { x: -v.x / len, y: -v.y / len }; // direction of play
  let tmin = Infinity, tmax = -Infinity;
  const pts = poly.map((p) => toLocal(c, p));
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    // intersect ray c + t*u with segment a-b
    const ex = b.x - a.x, ey = b.y - a.y;
    const den = u.x * ey - u.y * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = (a.x * ey - a.y * ex) / den;
    const s = (a.x * u.y - a.y * u.x) / den;
    if (s < 0 || s > 1) continue;
    tmin = Math.min(tmin, t); tmax = Math.max(tmax, t);
  }
  if (!Number.isFinite(tmin) || tmin > 0 || tmax < 0) return null;
  return { front: fromLocal(c, { x: u.x * tmin, y: u.y * tmin }), back: fromLocal(c, { x: u.x * tmax, y: u.y * tmax }) };
}

// ---------- OpenStreetMap ----------
const wayPts = (e) => (e.geometry ?? []).map((g) => ({ lat: g.lat, lon: g.lon }));

export async function fetchOsm(bbox, { fetchFn = fetch, signal } = {}) {
  const [south, west, north, east] = bbox;
  const q = `[out:json][timeout:60];(way["golf"~"^(green|hole|bunker)$"](${south},${west},${north},${east}););out tags geom;`;
  return overpass(q, { fetchFn, signal, timeoutMs: 45000 });
}

// Match OSM greens (and nearby bunkers) to the course's holes.
// Returns { [holeNumber]: { polygon, bunkers, playFrom, fromOsmHole } }.
export function matchGreens(course, osm) {
  const els = osm?.elements ?? [];
  const greens = els.filter((e) => e.tags?.golf === 'green').map(wayPts).filter((p) => p.length >= 3);
  const bunkers = els.filter((e) => e.tags?.golf === 'bunker').map(wayPts).filter((p) => p.length >= 3);
  const holeWays = new Map(els.filter((e) => e.tags?.golf === 'hole' && e.tags.ref).map((e) => [Number(e.tags.ref), wayPts(e)]));
  const used = new Set();
  const out = {};
  // Holes with a green the player placed claim their green first.
  const isPlaced = (h) => !!(h.green && !h.green.estimated && !h.green.fromMap);
  const order = [...course.holes].sort((a, b) => isPlaced(b) - isPlaced(a));
  for (const h of order) {
    const way = holeWays.get(h.n);
    // A green the player placed (or stood on) beats the map's hole line, which
    // is sometimes numbered differently from the card.
    const placed = h.green && !h.green.estimated && !h.green.fromMap ? h.green : null;
    const end = placed ?? way?.at(-1) ?? h.green;
    if (!end) continue;
    let best = null, bestD = Infinity;
    greens.forEach((poly, i) => {
      if (used.has(i)) return;
      const d = polyDistance(end, poly);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best == null || bestD > 40) continue; // nothing close enough
    used.add(best);
    const polygon = greens[best];
    const c = centroidOf(polygon);
    out[h.n] = {
      polygon,
      bunkers: bunkers.filter((b) => polyDistance(c, b) < 45 && b.some((p) => polyDistance(p, polygon) < 12)),
      // Line of play: the map's hole line, if it actually ends at this green.
      playFrom: way && way.length >= 2 && polyDistance(way.at(-1), polygon) < 25 ? way.at(-2) : h.tee ?? null,
      fromOsmHole: !!way && polyDistance(way.at(-1), polygon) < 25,
    };
  }
  return out;
}

// ---------- heights ----------
// Minimal reader for the uncompressed float32 TIFF ArcGIS returns (strips or tiles).
export function readTiff(buf) {
  const dv = new DataView(buf);
  const le = dv.getUint16(0) === 0x4949;
  const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
  const ifd = u32(4);
  const n = u16(ifd);
  const tags = {};
  const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8, 16: 8 };
  for (let k = 0; k < n; k++) {
    const o = ifd + 2 + 12 * k;
    const tag = u16(o), type = u16(o + 2), count = u32(o + 4);
    const bytes = (SIZE[type] ?? 1) * count;
    const at = bytes <= 4 ? o + 8 : u32(o + 8);
    const vals = [];
    for (let i = 0; i < Math.min(count, 4096); i++) {
      if (type === 3) vals.push(u16(at + 2 * i));
      else if (type === 4) vals.push(u32(at + 4 * i));
      else if (type === 16) vals.push(Number(dv.getBigUint64(at + 8 * i, le)));
    }
    tags[tag] = vals;
  }
  const W = tags[256][0], H = tags[257][0];
  if ((tags[259]?.[0] ?? 1) !== 1) throw new Error('Compressed height data is not supported');
  if ((tags[258]?.[0] ?? 32) !== 32) throw new Error('Unexpected height data format');
  const z = new Float32Array(W * H);
  const f32 = (o) => dv.getFloat32(o, le);
  if (tags[322]) { // tiled
    const tw = tags[322][0], th = tags[323][0];
    const across = Math.ceil(W / tw);
    tags[324].forEach((off, t) => {
      const tx = (t % across) * tw, ty = Math.floor(t / across) * th;
      for (let r = 0; r < th && ty + r < H; r++)
        for (let c = 0; c < tw && tx + c < W; c++) z[(ty + r) * W + tx + c] = f32(off + 4 * (r * tw + c));
    });
  } else { // strips
    const rps = tags[278]?.[0] ?? H;
    tags[273].forEach((off, s) => {
      for (let r = 0; r < rps && s * rps + r < H; r++)
        for (let c = 0; c < W; c++) z[(s * rps + r) * W + c] = f32(off + 4 * (r * W + c));
    });
  }
  return { W, H, z };
}

// Height grid covering the polygon plus a margin, at about 1 m per cell.
export async function fetchHeights(polygon, { fetchFn = fetch, margin = 5, signal } = {}) {
  const c = centroidOf(polygon);
  const loc = polygon.map((p) => toLocal(c, p));
  const xs = loc.map((p) => p.x), ys = loc.map((p) => p.y);
  const x0 = Math.min(...xs) - margin, x1 = Math.max(...xs) + margin;
  const y0 = Math.min(...ys) - margin, y1 = Math.max(...ys) + margin;
  const W = Math.min(150, Math.max(8, Math.round(x1 - x0)));
  const H = Math.min(150, Math.max(8, Math.round(y1 - y0)));
  const sw = fromLocal(c, { x: x0, y: y0 }), ne = fromLocal(c, { x: x1, y: y1 });
  const p = new URLSearchParams({
    bbox: `${sw.lon},${sw.lat},${ne.lon},${ne.lat}`, bboxSR: '4326', imageSR: '4326', size: `${W},${H}`,
    format: 'tiff', compression: 'None', pixelType: 'F32', noData: '-9999',
    interpolation: 'RSP_BilinearInterpolation', f: 'image',
  });
  const res = await fetchFn(`${DEM_URL}/exportImage?${p}`, { signal });
  if (!res.ok) throw new Error(`Height service said ${res.status}`);
  const t = readTiff(await res.arrayBuffer());
  const z = Array.from(t.z, (v) => (v < -1000 || !Number.isFinite(v) ? null : Math.round(v * 100) / 100));
  if (z.every((v) => v == null)) throw new Error('No LiDAR heights here (outside Queensland coverage?)');
  // Row 0 is the north edge. Cell centres span the box.
  return { origin: c, x0, y0, dx: (x1 - x0) / t.W, dy: (y1 - y0) / t.H, W: t.W, H: t.H, z };
}

// Which LiDAR survey covers a point (name like "Moreton_Bay_2018_LGA").
export async function fetchSurvey(pt, { fetchFn = fetch } = {}) {
  try {
    const p = new URLSearchParams({
      geometry: JSON.stringify({ points: [[pt.lon, pt.lat]], spatialReference: { wkid: 4326 } }),
      geometryType: 'esriGeometryMultipoint', returnFirstValueOnly: 'true', outFields: 'name', f: 'json',
    });
    const res = await fetchFn(`${DEM_URL}/getSamples`, { method: 'POST', body: p });
    const d = await res.json();
    const name = d.samples?.[0]?.attributes?.name ?? null;
    return { name, year: name?.match(/(19|20)\d\d/)?.[0] ?? null };
  } catch { return { name: null, year: null }; }
}

// ---------- analysis ----------
// Height at local metres (x east, y north) by bilinear interpolation.
export function heightAt(grid, x, y) {
  const fx = (x - grid.x0) / grid.dx - 0.5;
  const fy = (grid.y0 + grid.H * grid.dy - y) / grid.dy - 0.5; // row 0 = north
  const c0 = Math.floor(fx), r0 = Math.floor(fy);
  const v = (r, c) => (r < 0 || c < 0 || r >= grid.H || c >= grid.W ? null : grid.z[r * grid.W + c]);
  const a = v(r0, c0), b = v(r0, c0 + 1), cc = v(r0 + 1, c0), d = v(r0 + 1, c0 + 1);
  if ([a, b, cc, d].some((q) => q == null)) return v(Math.round(fy), Math.round(fx));
  const tx = fx - c0, ty = fy - r0;
  return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + cc * (1 - tx) * ty + d * tx * ty;
}

// Slope analysis inside the green. Local gradients span 5 m, which keeps the
// LiDAR's few-centimetre noise from showing as false breaks but keeps tiers.
export function analyse(grid, polygon, { step = 3.2, window = 2.5 } = {}) {
  const c = grid.origin;
  const loc = polygon.map((p) => toLocal(c, p));
  const inside = (x, y) => {
    let ins = false;
    for (let i = 0, j = loc.length - 1; i < loc.length; j = i++) {
      const a = loc[i], b = loc[j];
      if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) ins = !ins;
    }
    return ins;
  };
  // Plane fit z = a x + b y + k over the green.
  let n = 0, sx = 0, sy = 0, sz = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0;
  let zmin = Infinity, zmax = -Infinity;
  const xs = loc.map((p) => p.x), ys = loc.map((p) => p.y);
  const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
  for (let y = by0; y <= by1; y += 0.75) for (let x = bx0; x <= bx1; x += 0.75) {
    if (!inside(x, y)) continue;
    const z = heightAt(grid, x, y);
    if (z == null) continue;
    n++; sx += x; sy += y; sz += z; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z;
    zmin = Math.min(zmin, z); zmax = Math.max(zmax, z);
  }
  if (n < 10) return null;
  const mx = sx / n, my = sy / n, mz = sz / n;
  const cxx = sxx / n - mx * mx, cyy = syy / n - my * my, cxy = sxy / n - mx * my;
  const cxz = sxz / n - mx * mz, cyz = syz / n - my * mz;
  const det = cxx * cyy - cxy * cxy;
  const ga = (cxz * cyy - cyz * cxy) / det; // dz/dx (east)
  const gb = (cyz * cxx - cxz * cxy) / det; // dz/dy (north)
  const plane = { pct: 100 * Math.hypot(ga, gb), downhill: { x: -ga, y: -gb } };

  // Local gradients on a lattice for arrows.
  const arrows = [];
  for (let y = by0 + step / 2; y <= by1; y += step) for (let x = bx0 + step / 2; x <= bx1; x += step) {
    if (!inside(x, y)) continue;
    const zx1 = heightAt(grid, x + window, y), zx0 = heightAt(grid, x - window, y);
    const zy1 = heightAt(grid, x, y + window), zy0 = heightAt(grid, x, y - window);
    if ([zx1, zx0, zy1, zy0].some((q) => q == null)) continue;
    const gx = (zx1 - zx0) / (2 * window), gy = (zy1 - zy0) / (2 * window);
    arrows.push({ x, y, dx: -gx, dy: -gy, pct: 100 * Math.hypot(gx, gy) });
  }
  const steep = arrows.filter((a) => a.pct > 4).length / Math.max(1, arrows.length);
  return { plane, relief: zmax - zmin, zmin, zmax, arrows, steepShare: steep };
}

// Describe the fall relative to the player: `play` is the direction of play
// (local x/y), `downhill` the fall direction.
export function describeFall(plane, play) {
  if (!plane || plane.pct < 0.6) return 'Nearly flat';
  const pl = Math.hypot(play.x, play.y) || 1, dl = Math.hypot(plane.downhill.x, plane.downhill.y) || 1;
  const ux = play.x / pl, uy = play.y / pl;
  const fx = plane.downhill.x / dl, fy = plane.downhill.y / dl;
  const along = fx * ux + fy * uy;   // + = away from you
  const across = fx * uy - fy * ux;  // + = to your right
  const parts = [];
  if (Math.abs(along) > 0.38) parts.push(along > 0 ? 'away from you' : 'towards you');
  if (Math.abs(across) > 0.38) parts.push(across > 0 ? 'to the right' : 'to the left');
  const strength = plane.pct >= 3 ? 'Steep' : plane.pct >= 1.5 ? 'Moderate' : 'Gentle';
  return `${strength} fall ${parts.join(' and ')}`;
}

// ---------- whole course ----------
// Fetch outlines (OSM, or `osmData` if bundled) and heights for every hole.
// Mutates and returns `course`. `onProgress(done, total, label)`.
export async function buildCourseGreens(course, { osmData, fetchFn = fetch, onProgress, signal } = {}) {
  const pts = course.holes.flatMap((h) => [h.green, h.tee]).filter(Boolean);
  const ctr = course.centre ?? pts[0];
  if (!ctr) throw new Error('Set the course location first (place one green on the map).');
  let osm = osmData;
  if (!osm) {
    const all = pts.length ? pts : [ctr];
    const lats = all.map((p) => p.lat), lons = all.map((p) => p.lon);
    const pad = pts.length > 1 ? 0.004 : 0.012; // ~400 m around known points, ~1.2 km around a bare centre
    onProgress?.(0, course.holes.length, 'Getting green outlines');
    osm = await fetchOsm([Math.min(...lats) - pad, Math.min(...lons) - pad, Math.max(...lats) + pad, Math.max(...lons) + pad], { fetchFn, signal });
  }
  const matched = matchGreens(course, osm);
  const survey = await fetchSurvey(ctr, { fetchFn });
  let done = 0, ok = 0, slopes = 0, noHeights = 0;
  const problems = [];
  const r7 = (p) => [Math.round(p.lat * 1e7) / 1e7, Math.round(p.lon * 1e7) / 1e7];
  for (const h of course.holes) {
    const m = matched[h.n];
    let polygon = m?.polygon ?? null;
    let source = 'osm';
    if (!polygon && h.green && !h.green.estimated) { polygon = ellipseFromPoints(h); source = 'estimate'; }
    if (!polygon) { problems.push(h.n); onProgress?.(++done, course.holes.length, `Hole ${h.n}`); continue; }
    const playFrom = m?.playFrom ?? h.tee ?? null;
    // Outline and positions first: these work anywhere OpenStreetMap does.
    const cen = centroidOf(polygon);
    if (!h.green || h.green.estimated) h.green = { ...cen, estimated: false, fromMap: true };
    if (!h.front || !h.back) {
      const fb = playFrom ? frontBack(polygon, playFrom, h.green) : null;
      if (fb) { h.front ??= fb.front; h.back ??= fb.back; }
    }
    h.shape = {
      polygon: polygon.map(r7), bunkers: (m?.bunkers ?? []).map((b) => b.map(r7)),
      source, playFrom, grid: h.shape?.grid ?? null, survey, fetchedAt: new Date().toISOString(),
    };
    ok++;
    // Heights: Queensland only. After two holes with no coverage, stop asking.
    if (noHeights < 2) {
      try {
        h.shape.grid = await fetchHeights(polygon, { fetchFn, signal });
        slopes++;
      } catch (err) {
        if (signal?.aborted) throw err;
        noHeights++;
      }
    }
    onProgress?.(++done, course.holes.length, `Hole ${h.n}`);
  }
  if (!course.centre && ctr) course.centre = ctr;
  return { course, ok, slopes, problems };
}

// ---------- finding a course ----------
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

const placeFromNominatim = (r) => ({
  name: r.name || r.display_name.split(',')[0],
  where: r.display_name.split(',').slice(1, 4).join(',').trim(),
  centre: { lat: Number(r.lat), lon: Number(r.lon) },
  // Nominatim: [south, north, west, east] -> [south, west, north, east]
  bbox: [Number(r.boundingbox[0]), Number(r.boundingbox[2]), Number(r.boundingbox[1]), Number(r.boundingbox[3])],
});
const isCourse = (r) => r.category === 'leisure' && r.type === 'golf_course';

async function nominatim(params, fetchFn) {
  const res = await fetchFn(`${NOMINATIM}?${new URLSearchParams({ format: 'jsonv2', ...params })}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Course search failed (${res.status}). Try again in a moment.`);
  return res.json();
}

const overpassCourse = (pt) => (e) => ({
  name: e.tags.name,
  where: [e.tags['addr:suburb'], e.tags['addr:city']].filter(Boolean).join(', '),
  centre: { lat: e.center.lat, lon: e.center.lon },
  bbox: [e.bounds.minlat, e.bounds.minlon, e.bounds.maxlat, e.bounds.maxlon],
  km: distance(pt, { lat: e.center.lat, lon: e.center.lon }) / 1000,
});

// Every mapped golf course within `km` of `pt`, nearest first.
// Nominatim (reliable, fast) pages past its 40-result limit with
// exclude_place_ids; the Overpass mirrors are the fallback.
const areaCache = new Map();
export async function coursesAround(pt, { km = 30, fetchFn = fetch, maxPages = 4 } = {}) {
  const key = `${pt.lat.toFixed(2)},${pt.lon.toFixed(2)},${km}`;
  if (areaCache.has(key)) return areaCache.get(key);
  let out = [];
  try {
    const deg = km / 111, dlon = deg / Math.cos((pt.lat * Math.PI) / 180);
    const ids = [];
    for (let page = 0; page < maxPages; page++) {
      if (page) await pause(1100); // Nominatim allows one request a second
      const list = await nominatim({
        q: 'golf course', limit: '40', bounded: '1',
        viewbox: `${pt.lon - dlon},${pt.lat + deg},${pt.lon + dlon},${pt.lat - deg}`,
        ...(ids.length ? { exclude_place_ids: ids.join(',') } : {}),
      }, fetchFn);
      ids.push(...list.map((r) => r.place_id));
      out.push(...list.filter(isCourse).map(placeFromNominatim));
      if (list.length < 40) break;
    }
    if (!out.length) throw new Error('empty');
  } catch {
    const r = km * 1000;
    const d = await overpass(`[out:json][timeout:25];(way["leisure"="golf_course"](around:${r},${pt.lat},${pt.lon});relation["leisure"="golf_course"](around:${r},${pt.lat},${pt.lon}););out tags center bb;`, { fetchFn, timeoutMs: 15000 });
    out = d.elements.filter((e) => e.tags?.name && e.center && e.bounds).map(overpassCourse(pt));
  }
  out = out.map((c) => ({ ...c, km: distance(pt, c.centre) / 1000 }))
    .filter((c) => c.km <= km * 1.45) // the box's corners reach a little further than km
    .sort((a, b) => a.km - b.km);
  areaCache.set(key, out);
  return out;
}

// Edit distance, for forgiving spellings ("kaperra" -> Keperra).
export function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}
const COMMON = new Set(['golf', 'club', 'course', 'country', 'links', 'the', 'and', 'resort']);
const words = (t) => t.toLowerCase().normalize('NFD').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !COMMON.has(w));

// How well a course name matches what was typed: 0 = not at all.
export function nameScore(query, name) {
  const qs = words(query), ns = words(name);
  if (!qs.length) return 0;
  let score = 0;
  for (const q of qs) {
    let best = 0;
    for (const n of ns) {
      if (n === q) best = Math.max(best, 3);
      else if (n.startsWith(q) || q.startsWith(n) && n.length >= 4) best = Math.max(best, 2);
      else if (q.length >= 4 && editDistance(q, n.slice(0, q.length + 1)) <= (q.length >= 7 ? 2 : 1)) best = Math.max(best, 1.5);
      else if (q.length >= 4 && editDistance(q, n) <= (q.length >= 7 ? 2 : 1)) best = Math.max(best, 1.5);
    }
    if (!best) return 0; // every typed word must match something
    score += best;
  }
  return score;
}

// Search by name: OpenStreetMap's place search with the name as typed (and
// again without words like "golf club"), then forgiving matching against
// every course around `near` (you, or your other courses).
export async function searchCourses(q, { near, fetchFn = fetch } = {}) {
  const found = [];
  const seen = (c) => found.some((f) => distance(f.centre, c.centre) < 400);
  const add = (c) => { if (!seen(c)) found.push({ ...c, km: c.km ?? (near ? distance(near, c.centre) / 1000 : null) }); };
  const core = words(q).join(' ');
  const queries = [...new Set([q.trim(), core, `${core || q.trim()} golf`].filter(Boolean))];
  let failed = null;
  // Prefer results around `near`, but still find courses further away.
  const bias = near ? { viewbox: `${near.lon - 1},${near.lat + 1},${near.lon + 1},${near.lat - 1}` } : {};
  for (const [i, text] of queries.entries()) {
    if (i) await pause(1100); // Nominatim allows one request a second
    try {
      (await nominatim({ q: text, limit: '10', ...bias }, fetchFn)).filter(isCourse).map(placeFromNominatim)
        .filter((c) => nameScore(q, c.name) > 0) // drop loose matches like "Rowville Lakes" for "north lakes"
        .forEach(add);
    } catch (err) { failed = err; }
    if (found.length) break;
  }
  if (near && !found.length) {
    const around = await coursesAround(near, { km: 60, fetchFn }).catch(() => []);
    around.map((c) => ({ ...c, score: nameScore(q, c.name) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score || a.km - b.km)
      .forEach(add);
  }
  if (!found.length && failed) throw failed;
  return found;
}

// Golf courses near a point.
export async function nearbyCourses(pt, { fetchFn = fetch } = {}) {
  return coursesAround(pt, { km: 25, fetchFn });
}

// A par from the hole's length along its map line (tee to green centre).
// Cut-offs fitted to Pine Rivers and Ashgrove, where they get all 36 holes
// right (longest par 3 164 m, par 4s 236-389 m, shortest par 5 415 m).
export function parFromLength(m) {
  if (m < 225) return 3;
  if (m < 400) return 4;
  return 5;
}

// Holes from the map's numbered hole lines: pars, stroke index (if tagged),
// tee (start of the line). Returns null when the holes aren't numbered.
export function holesFromOsm(osm) {
  const ways = (osm?.elements ?? []).filter((e) => e.tags?.golf === 'hole' && /^\d+$/.test(e.tags.ref ?? ''));
  if (!ways.length) return null;
  const byRef = new Map(ways.map((w) => [Number(w.tags.ref), w]));
  const count = Math.max(...byRef.keys());
  if (count > 27 || count < 1) return null;
  return Array.from({ length: count }, (_, i) => {
    const w = byRef.get(i + 1);
    const pts = w ? wayPts(w) : [];
    const par = Number(w?.tags.par);
    const si = Number(w?.tags.handicap);
    const mappedPar = par >= 3 && par <= 6;
    const length = pts.slice(1).reduce((a, p, k) => a + distance(pts[k], p), 0);
    return {
      n: i + 1, par: mappedPar ? par : length ? parFromLength(length) : 4, parMapped: mappedPar,
      parEstimated: !mappedPar && length > 0, length: Math.round(length),
      si: si >= 1 && si <= 18 ? si : null, tee: pts[0] ?? null, mapped: !!w,
      // OSM hole lines run from the tee to the middle of the green
      green: pts.length >= 2 ? pts.at(-1) : null,
    };
  });
}

// Download a found course's map data (bounding box plus a margin).
export async function loadCourseOsm(place, { fetchFn = fetch } = {}) {
  const pad = 0.0015; // ~150 m
  const [s, w, n, e] = place.bbox;
  return fetchOsm([s - pad, w - pad, n + pad, e + pad], { fetchFn });
}

// When OSM has no outline: an oval from the front/back points (or a 14 m circle).
export function ellipseFromPoints(h) {
  const c = h.green;
  let len = 28, ang = 0;
  if (h.front && h.back) {
    const f = toLocal(c, h.front), b = toLocal(c, h.back);
    len = Math.max(12, Math.hypot(b.x - f.x, b.y - f.y));
    ang = Math.atan2(b.y - f.y, b.x - f.x);
  }
  const a = len / 2, w = Math.max(8, a * 0.8);
  const out = [];
  for (let i = 0; i < 24; i++) {
    const t = (i / 24) * 2 * Math.PI;
    const x = a * Math.cos(t), y = w * Math.sin(t);
    out.push(fromLocal(c, { x: x * Math.cos(ang) - y * Math.sin(ang), y: x * Math.sin(ang) + y * Math.cos(ang) }));
  }
  return out;
}

export const shapePolygon = (shape) => shape.polygon.map(([lat, lon]) => ({ lat, lon }));
