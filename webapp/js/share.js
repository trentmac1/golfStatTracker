// Course sharing: send this phone's green, tee and card edits to the course
// server (on Trent's Raspberry Pi) and bring in everyone else's.
// Merge rules: coursemerge.js. Server: pi/course-server/.
import * as db from './db.js';
import { COURSE_SERVER } from './config.js';
import { snapshotEdits, snapshotCard, sharedCounts, applyShared, describeChanges } from './coursemerge.js';
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

// The shared copy of a course, if anyone has uploaded it.
async function findShared(course) {
  if (course.sharedKey) {
    try { return (await api(`/courses/${course.sharedKey}`)).course; }
    catch (e) { if (!/No such course/.test(e.message)) throw e; }
  }
  const centre = centreOf(course);
  const list = (await api(centre ? `/courses?lat=${centre.lat}&lon=${centre.lon}&km=3` : '/courses')).courses;
  const match = list.find((c) => sameCourse(course.name, c.name) && (!centre || distance(centre, c.centre) < 2500))
    ?? (course.seedKey && list.find((c) => c.key === course.seedKey));
  return match ? (await api(`/courses/${match.key}`)).course : null;
}

const countsText = (course) => {
  const n = course.holes.length;
  return `${course.holes.filter((h) => h.green).length}/${n} greens, ${course.holes.filter((h) => h.tee).length}/${n} tees set, par ${course.holes.reduce((a, h) => a + h.par, 0)}${course.rating ? `, rating ${course.rating}` : ''}${course.slope ? ` / slope ${course.slope}` : ''}`;
};

// Course screen: bring in the server's greens, tees, pars, stroke indexes,
// hole count and tees/rating/slope. Nothing is sent. Saves the course. Returns { found, summary, text, counts }.
export async function pullCourse(course) {
  const remote = await findShared(course);
  if (!remote) return { found: false };
  course.sharedKey = remote.key;
  const summary = applyShared(course, remote);
  course.sharedVersion = remote.version;
  course.sharedAt = new Date().toISOString();
  await db.put('courses', course);
  return { found: true, summary, text: describeChanges(summary), counts: countsText(course) };
}

// Backup tab: upload every course on this phone, with all its greens and
// tees. Returns one result per course: { course, counts, error }.
export async function uploadAll(say = () => {}) {
  const results = [];
  for (const c of await db.all('courses')) {
    const holes = snapshotEdits(c);
    if (!centreOf(c) || !holes.length) { results.push({ course: c, skipped: true }); continue; }
    say(`Uploading ${c.name}…`);
    try {
      const key = await link(c);
      const { course: remote } = await api(`/courses/${key}/edits`, { method: 'POST', body: { name: c.name, centre: centreOf(c), holeCount: c.holes.length, holes, card: snapshotCard(c) } });
      c.sharePushedTs = latestEdit(c);
      c.sharedVersion = remote.version;
      c.sharedAt = new Date().toISOString();
      await db.put('courses', c);
      results.push({ course: c, counts: sharedCounts(remote) });
    } catch (e) { results.push({ course: c, error: e.message }); }
  }
  return results;
}

// Adding a course from the map: start from what others have shared.
// Quietly does nothing if the server can't be reached.
export async function pullForNewCourse(course) {
  if (!(await sharingOn()) || !centreOf(course)) return null;
  try {
    const remote = await findShared(course);
    if (!remote) return null;
    course.sharedKey = remote.key;
    const summary = applyShared(course, remote);
    course.sharedVersion = remote.version;
    course.sharedAt = new Date().toISOString();
    return { summary, text: describeChanges(summary) };
  } catch (e) {
    console.warn('share', e);
    return null;
  }
}
