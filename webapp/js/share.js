// Course sharing: send this phone's green, tee and card edits to the course
// server (on Trent's Raspberry Pi) and bring in everyone else's.
// Merge rules: coursemerge.js. Server: pi/course-server/.
import * as db from './db.js';
import { COURSE_SERVER } from './config.js';
import { localEdits, applyShared, describeChanges } from './coursemerge.js';
import { nameScore } from './greens.js';
import { distance } from './geo.js';

export async function serverUrl() {
  const s = (await db.getSetting('shareServer', '')) || COURSE_SERVER;
  return s.replace(/\/+$/, '');
}

export async function sharingOn() { return !!(await serverUrl()); }

async function api(path, { method = 'GET', body, timeout = 12000, fetchFn = fetch } = {}) {
  const base = await serverUrl();
  if (!base) throw new Error("Course sharing isn't set up yet (Backup & settings → Shared courses).");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    res = await fetchFn(`${base}/api${path}`, {
      method, signal: ctl.signal,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Couldn't reach the course server. Check your signal, or the Pi may be off.");
  } finally { clearTimeout(timer); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ? `Course server: ${data.error}` : `Course server said ${res.status}.`);
  return data;
}

const centreOf = (course) => course.centre ?? course.holes.find((h) => h.green)?.green ?? course.holes.find((h) => h.tee)?.tee ?? null;
const sameCourse = (a, b) => nameScore(a, b) > 0 || nameScore(b, a) > 0;

// The shared copy of this course, creating it if nobody has shared it yet.
async function link(course) {
  if (course.sharedKey) return course.sharedKey;
  const centre = centreOf(course);
  if (!centre) throw new Error(`Place at least one green on ${course.name} first, so the server knows where it is.`);
  const { course: remote } = await api('/courses', { method: 'POST', body: { name: course.name, centre, holeCount: course.holes.length, key: course.seedKey } });
  course.sharedKey = remote.key;
  return remote.key;
}

const latestEdit = (course) => Math.max(0, ...course.holes.flatMap((h) => Object.values(h.edits ?? {})));

// Push this course's new edits, then pull everyone's. Saves the course.
// Returns { pushed, summary, text }.
export async function syncCourse(course) {
  const key = await link(course);
  const holes = localEdits(course, course.sharePushedTs ?? 0);
  const { course: remote } = holes.length
    ? await api(`/courses/${key}/edits`, { method: 'POST', body: { name: course.name, centre: centreOf(course), holeCount: course.holes.length, holes } })
    : await api(`/courses/${key}`);
  const summary = applyShared(course, remote);
  course.sharePushedTs = latestEdit(course);
  course.sharedVersion = remote.version;
  course.sharedAt = new Date().toISOString();
  await db.put('courses', course);
  const pushed = holes.reduce((a, h) => a + Object.keys(h.fields).length, 0);
  return { pushed, summary, text: describeChanges(summary) };
}

// Before a course added from the map is saved: bring in what others shared.
// Quietly does nothing if sharing isn't set up or the server can't be reached.
export async function pullForNewCourse(course) {
  if (!(await sharingOn())) return null;
  const centre = centreOf(course);
  if (!centre) return null;
  try {
    const { courses } = await api(`/courses?lat=${centre.lat}&lon=${centre.lon}&km=3`, { timeout: 8000 });
    const match = courses.find((c) => sameCourse(course.name, c.name) && distance(centre, c.centre) < 2500);
    if (!match) return null;
    const { course: remote } = await api(`/courses/${match.key}`, { timeout: 8000 });
    course.sharedKey = remote.key;
    const summary = applyShared(course, remote);
    course.sharePushedTs = latestEdit(course);
    course.sharedVersion = remote.version;
    course.sharedAt = new Date().toISOString();
    return { summary, text: describeChanges(summary) };
  } catch (e) {
    console.warn('share', e);
    return null;
  }
}

// After editing greens on the map: send the edits without bothering anyone.
export async function pushQuietly(course) {
  try {
    if (!(await sharingOn()) || !(latestEdit(course) > (course.sharePushedTs ?? 0))) return;
    const fresh = await db.get('courses', course.id);
    if (fresh) await syncCourse(fresh);
  } catch (e) { console.warn('share', e); }
}

// The Backup tab's Update courses: every course on this phone.
export async function syncAll(say = () => {}) {
  const courses = await db.all('courses');
  const { courses: shared } = await api('/courses');
  const results = [];
  for (const c of courses) {
    if (!c.sharedKey) {
      const centre = centreOf(c);
      const m = centre && shared.find((s) => sameCourse(c.name, s.name) && distance(centre, s.centre) < 2500);
      if (m) c.sharedKey = m.key;
      else if (c.seedKey && shared.some((s) => s.key === c.seedKey)) c.sharedKey = c.seedKey;
    }
    const hasEdits = latestEdit(c) > (c.sharePushedTs ?? 0);
    if (!c.sharedKey && !hasEdits) continue;
    say(`Updating ${c.name}…`);
    try { results.push({ course: c, ...(await syncCourse(c)) }); }
    catch (e) { results.push({ course: c, error: e.message }); }
  }
  return results;
}
