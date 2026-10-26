// Rounds played with the shot tracker: keep the tracker in round mode, sync
// its capture log during the round, and turn the swings it saves into shots
// on the map. Chips and putts are still entered by hand for now
// (docs/plan-addition-short-game.md has the automatic version).
import * as db from './db.js';
import { tracker, OP } from './transport.js';
import { decodeRecord, sessions, notShots } from './capturelog.js';
import { distance, toLocal } from './geo.js';
import { holeLine, applyAutoLie } from './holemap.js';
import { playOrder } from './stats.js';

export const ROUND_TRIGGER = 250, ROUND_GATE = 1000;   // as the Training data screen's Round mode
export const shotId = (logId, seq) => `trk-${(logId >>> 0).toString(16)}-${seq}`;

// ---------- capture log sync ----------
// Smallest seq of a log not yet on the phone: where the next sync starts.
export function cursor(rows) {
  const have = new Set(rows.map((r) => r.seq));
  let s = 0;
  while (have.has(s)) s++;
  return s;
}

// Pulls whatever the tracker has that the phone doesn't. Returns the number
// of records stored, or 0 if there was nothing new (or no capture log).
export async function syncCaptures() {
  const c = tracker.capture;
  if (!c || !tracker.hasCapture || tracker.state !== 'connected' || tracker.sync) return 0;
  const logId = c.logId;
  const from = cursor(await db.capturesForLog(logId));
  if (c.nextSeq <= from) return 0;
  let n = 0;
  await tracker.syncLog(from, async (bytes) => {
    const r = decodeRecord(bytes);
    if (!r.crcOk) return;
    await db.put('captures', { ...r, id: `${logId}-${r.seq}`, logId, bytes, syncedAt: new Date().toISOString() });
    n++;
  });
  await db.setSetting('captureLastSync', new Date().toISOString());
  return n;
}

// Round mode on the tracker (trigger 250, impact needed) and a session open.
// A gate the player has already tuned is kept.
export async function prepareTracker() {
  if (tracker.state !== 'connected' || !tracker.hasCapture) return;
  const c = tracker.capture;
  if (!c) return;
  if (!c.enabled) await tracker.send(OP.setCapture, true);
  if (c.soundGate != null && !c.soundGate) await tracker.send(OP.setSoundGate, ROUND_GATE);
  if (c.trigger !== ROUND_TRIGGER) await tracker.send(OP.setTrigger, ROUND_TRIGGER);
  if (!c.session) await tracker.send(OP.startRound);
}

export async function endTrackerRound() {
  if (tracker.state === 'connected' && tracker.capture?.session) await tracker.send(OP.endRound).catch(() => {});
}

// ---------- which hole a swing belongs to ----------
function toSegment(p, a, b) {
  const v = toLocal(a, b), w = toLocal(a, p);
  const len2 = v.x * v.x + v.y * v.y;
  const t = len2 ? Math.max(0, Math.min(1, (w.x * v.x + w.y * v.y) / len2)) : 0;
  return Math.hypot(w.x - t * v.x, w.y - t * v.y);
}
export function distanceToHole(p, courseHole) {
  const line = holeLine(courseHole);
  if (line) {
    let best = Infinity;
    for (let i = 1; i < line.length; i++) best = Math.min(best, toSegment(p, line[i - 1], line[i]));
    return best;
  }
  const pts = [courseHole?.tee, courseHole?.green].filter(Boolean);
  return pts.length ? Math.min(...pts.map((q) => distance(p, q))) : Infinity;
}

// The hole on screen at the time of the swing, unless the swing is clearly
// on the next (or previous) hole: players often walk to the next tee and hit
// before moving the app on, or finish entering putts afterwards.
export function holeFor(course, round, p, timeMs) {
  const order = playOrder(course, round);
  const log = round.holeLog ?? [];
  let h = order[0];
  for (const e of log) if (e.at <= timeMs) h = e.hole;
  if (!p) return h;
  const i = order.indexOf(h);
  const cands = [order[i - 1], h, order[i + 1]].filter((x) => x != null);
  const d = (n) => distanceToHole(p, course.holes[n - 1]);
  const here = d(h);
  let best = h, bestD = here;
  for (const n of cands) if (d(n) + 15 < bestD) { best = n; bestD = d(n); }
  return bestD < 80 || here === Infinity ? best : h;
}

// ---------- turning swings into shots ----------
// Swings and short-game presses saved during the round, from capture rows
// (any logs). Swings the app marks as not shots (thud, knock, same spot,
// the button's own jolt) are left out.
export function roundTrackerData(round, rows, now = Date.now()) {
  const from = Date.parse(round.date) - 2 * 60000;
  const to = round.finishedAt ? Date.parse(round.finishedAt) + 60000 : now + 60000;
  const byLog = new Map();
  for (const r of rows) {
    if (!byLog.has(r.logId)) byLog.set(r.logId, []);
    byLog.get(r.logId).push(r);
  }
  const swings = [], presses = [];
  const inRound = (r) => r.time && r.time * 1000 >= from && r.time * 1000 <= to;
  for (const [logId, list] of byLog) {
    if (!list.some(inRound)) continue;
    for (const s of sessions(list)) {
      const mine = s.swings.filter((w) => inRound(w) && !s.pressSeqs.has(w.seq));
      const not = notShots(mine, s.labelledSeqs);
      for (const w of mine) if (!not.has(w.seq)) swings.push({ ...w, logId });
      for (const l of s.labels) if (inRound(l) && l.swingSeq == null) presses.push({ ...l, logId });
    }
  }
  const byTime = (a, b) => a.time - b.time || a.seq - b.seq;
  return { swings: swings.sort(byTime), presses: presses.sort(byTime) };
}

// A shot is the player's once they've changed it: then sync leaves it alone.
const touched = (s) => s.edited || s.club || s.lieByHand || s.target || s.penalty || s.mishit;

// What to change so the round's tracker shots match the synced swings: add
// new ones, drop untouched ones the checks no longer count (a louder swing
// from the same spot arrived later), and never bring back one the player
// deleted. A swing within 10 m and 3 minutes of a shot marked by hand is
// already that shot. Returns { add: [shot], remove: [id], presses: {hole: n} }.
export function planTrackerShots({ round, course, shots, swings, presses }) {
  const dismissed = new Set(round.trackerDismissed ?? []);
  const want = new Map();
  for (const w of swings) {
    const id = shotId(w.logId, w.seq);
    if (dismissed.has(id) || !w.pos) continue;
    const t = w.time * 1000;
    const marked = shots.some((s) => s.source !== 'tracker' && s.lat != null && distance(s, w.pos) < 10 && t - s.time >= -60000 && t - s.time < 180000);
    if (!marked) want.set(id, w);
  }
  const remove = shots.filter((s) => s.source === 'tracker' && !want.has(s.id) && !touched(s)).map((s) => s.id);
  const kept = shots.filter((s) => !remove.includes(s.id));
  const have = new Set(shots.map((s) => s.id));
  let seq = shots.reduce((a, s) => Math.max(a, s.seq ?? 0), 0);
  const add = [];
  for (const [id, w] of want) {
    if (have.has(id)) continue;
    const t = w.time * 1000;
    const hole = holeFor(course, round, w.pos, t);
    const first = ![...kept, ...add].some((s) => s.hole === hole && s.time < t);
    const shot = {
      id, roundId: round.id, hole, seq: ++seq, lat: w.pos.lat, lon: w.pos.lon,
      accuracy: w.hdop != null ? Math.max(2.5, w.hdop * 2.5) : 5, time: t,
      club: null, source: 'tracker', confidence: null, penalty: false, lie: first ? 'tee' : null, mishit: false, target: null,
      tracker: { logId: w.logId, seq: w.seq, peakGyro: w.peakGyro ?? null, impact: w.impactLevel ?? null },
    };
    applyAutoLie(shot, course.holes[hole - 1], first);
    add.push(shot);
  }
  const pressHoles = {};
  for (const p of presses) {
    const h = holeFor(course, round, p.pos, p.time * 1000);
    pressHoles[h] = (pressHoles[h] ?? 0) + 1;
  }
  return { add, remove, presses: pressHoles };
}

export async function reconcileTrackerShots(round, course) {
  const { swings, presses } = roundTrackerData(round, await db.all('captures'));
  const shots = await db.shotsForRound(round.id);
  const plan = planTrackerShots({ round, course, shots, swings, presses });
  for (const id of plan.remove) await db.del('shots', id);
  for (const s of plan.add) await db.put('shots', s);
  return { added: plan.add.length, removed: plan.remove.length, presses: plan.presses };
}

// Called when a tracker shot is deleted, so the next sync doesn't add it back.
export async function dismissTrackerShot(round, shot) {
  if (shot.source !== 'tracker') return;
  round.trackerDismissed = [...new Set([...(round.trackerDismissed ?? []), shot.id])];
  await db.put('rounds', round);
}

// Remembers which hole was on screen when, for holeFor().
export function logHole(round, hole) {
  const log = (round.holeLog ??= []);
  if (log.at(-1)?.hole !== hole) log.push({ hole, at: Date.now() });
}
