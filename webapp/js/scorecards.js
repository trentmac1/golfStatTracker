// Scorecards from GolfCourseAPI (golfcourseapi.com): pars, lengths, course
// rating and slope per tee. (Checked Oct 2026: Brisbane courses have no
// stroke index in the data, so that still comes from the card.) Needs the player's own API key,
// which stays on this phone (Backup & settings). Free keys allow about 35
// requests a day; one lookup is usually one request.
//
// Terms: data is for use inside this app only, so it's saved with the course
// on this phone and never sent anywhere else.
import { distance } from './geo.js';

const BASE = 'https://api.golfcourseapi.com/v1';
const YD_TO_M = 0.9144;

async function call(path, key, fetchFn) {
  if (!key) throw new Error('Add your GolfCourseAPI key in Backup & settings first.');
  let res;
  for (const scheme of ['Key', 'Bearer']) {
    try {
      res = await fetchFn(`${BASE}${path}`, { headers: { Authorization: `${scheme} ${key}`, Accept: 'application/json' } });
    } catch {
      throw new Error("Couldn't reach GolfCourseAPI. Check your signal and try again.");
    }
    if (res.status !== 401) break;
  }
  if (res.status === 401 || res.status === 403) throw new Error('GolfCourseAPI rejected the key. Check it in Backup & settings.');
  if (res.status === 429) throw new Error("Today's GolfCourseAPI lookups are used up (free keys allow about 35 a day). Try again tomorrow.");
  if (!res.ok) throw new Error(`GolfCourseAPI said ${res.status}.`);
  return res.json();
}

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

// Normalise one course record into what the app uses.
export function normaliseCourse(c) {
  const loc = c.location ?? {};
  const tees = [];
  let teeCount = 0;
  for (const [gender, list] of Object.entries(c.tees ?? {})) {
    if (typeof list === 'number') { teeCount += list; continue; } // search results only count the tees
    if (!Array.isArray(list)) continue;
    teeCount += list.length;
    for (const t of list) {
      const holes = (t.holes ?? []).map((h) => ({
        par: num(h.par), si: num(h.handicap),
        metres: num(h.meters) != null ? Math.round(num(h.meters)) : num(h.yardage) != null ? Math.round(num(h.yardage) * YD_TO_M) : null,
      }));
      tees.push({
        gender, name: t.tee_name ?? 'Tee', rating: num(t.course_rating), slope: num(t.slope_rating),
        par: num(t.par_total) ?? holes.reduce((a, h) => a + (h.par ?? 0), 0),
        metres: num(t.total_meters) ?? (num(t.total_yards) != null ? Math.round(num(t.total_yards) * YD_TO_M) : null),
        holes,
      });
    }
  }
  const name = [c.club_name, c.course_name].filter(Boolean)
    .filter((v, i, a) => i === 0 || !a[0].toLowerCase().includes(v.toLowerCase())).join(' – ');
  return {
    id: c.id, name: name || 'Course', club: c.club_name ?? null, course: c.course_name ?? null,
    where: [loc.city, loc.state, loc.country].filter(Boolean).join(', '),
    centre: num(loc.latitude) != null && num(loc.longitude) != null ? { lat: num(loc.latitude), lon: num(loc.longitude) } : null,
    tees: tees.filter((t) => t.holes.length),
    teeCount,
  };
}

// Search by name; nearest to `near` first when locations are known.
export async function searchScorecards(q, { key, near, fetchFn = fetch } = {}) {
  const d = await call(`/search?${new URLSearchParams({ search_query: q })}`, key, fetchFn);
  const list = (d.courses ?? []).map(normaliseCourse);
  for (const c of list) c.km = near && c.centre ? distance(near, c.centre) / 1000 : null;
  return list.sort((a, b) => (a.km ?? 1e9) - (b.km ?? 1e9));
}

// Full record (in case search results come without tees).
export async function getScorecard(id, { key, fetchFn = fetch } = {}) {
  const d = await call(`/courses/${encodeURIComponent(id)}`, key, fetchFn);
  return normaliseCourse(d.course ?? d);
}

// Apply a tee's card to the course, starting at course hole `from`.
// Returns how many holes were filled.
export function applyScorecard(course, place, tee, from = 1) {
  let n = 0;
  tee.holes.forEach((h, i) => {
    const ch = course.holes[from - 1 + i];
    if (!ch) return;
    // Card values from GolfCourseAPI aren't shared (coursemerge.js).
    const mark = (f) => { ch.fromGca = [...new Set([...(ch.fromGca ?? []), f])]; if (ch.edits) delete ch.edits[f]; };
    if (h.par) { ch.par = h.par; delete ch.parEstimated; mark('par'); }
    if (h.si) { ch.si = h.si; mark('si'); }
    if (h.metres) ch.metres = h.metres;
    n++;
  });
  const markC = (f) => { course.fromGca = [...new Set([...(course.fromGca ?? []), f])]; if (course.edits) delete course.edits[f]; };
  if (tee.rating) { course.rating = tee.rating; markC('rating'); }
  if (tee.slope) { course.slope = tee.slope; markC('slope'); }
  course.tee = tee.name; markC('tee');
  course.scorecard = { source: 'GolfCourseAPI', id: place.id, name: place.name, tee: tee.name, gender: tee.gender, from, fetchedAt: new Date().toISOString() };
  course.importNotes = (course.importNotes ?? []).filter((t) => !/par/i.test(t));
  return n;
}
