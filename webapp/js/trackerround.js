// Rounds played with the shot tracker: keep the tracker in round mode, sync
// its capture log during the round, and turn the swings it saves into shots
// on the map. Chips and putts are still entered by hand for now
// (docs/plan-addition-short-game.md has the automatic version).
import * as db from './db.js';
import { tracker, OP } from './transport.js';
import { decodeRecord, sessions, notShots, REJECT } from './capturelog.js';
import { distance, toLocal } from './geo.js';
import { holeLine, applyAutoLie } from './holemap.js';
import { playOrder } from './stats.js';
import { pointInPolygon } from './greens.js';

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
  // Firmware 0.4.0+: the app owns the round, so the button can't end it.
  if (c.locked === false) await tracker.send(OP.lockRound, true);
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

// On a green (inside any hole's mapped green outline): putting, picking the
// ball up, walking off. Not a full shot. On 31 Oct, 5 saved swings and 227
// rejects were on greens and none of the 27 shots; the closest chip was 5.7 m
// off the edge. Holes with no outline never count.
export function onGreen(course, p) {
  if (!p || !course?.holes) return false;
  return course.holes.some((h) => h?.shape?.polygon?.length > 2
    && pointInPolygon(p, h.shape.polygon.map(([lat, lon]) => ({ lat, lon }))));
}

// ---------- turning swings into shots ----------
// Swings and short-game presses saved during the round, from capture rows
// (any logs). Swings the app marks as not shots (thud, knock, same spot)
// come back separately as `hidden`, and the tracker's reject records
// (firmware 0.4.0) as `rejects`: both can be shown as possible shots.
// The button's own jolt is left out altogether.
export function roundTrackerData(round, rows, now = Date.now()) {
  const from = Date.parse(round.date) - 2 * 60000;
  const to = round.finishedAt ? Date.parse(round.finishedAt) + 60000 : now + 60000;
  const byLog = new Map();
  for (const r of rows) {
    if (!byLog.has(r.logId)) byLog.set(r.logId, []);
    byLog.get(r.logId).push(r);
  }
  const swings = [], presses = [], hidden = [], rejects = [];
  const inRound = (r) => r.time && r.time * 1000 >= from && r.time * 1000 <= to;
  for (const [logId, list] of byLog) {
    if (!list.some(inRound)) continue;
    for (const s of sessions(list)) {
      const mine = s.swings.filter((w) => inRound(w) && !s.pressSeqs.has(w.seq));
      const not = notShots(mine, s.labelledSeqs);
      for (const w of mine) {
        if (!not.has(w.seq)) swings.push({ ...w, logId });
        else hidden.push({ ...w, logId, why: not.get(w.seq) });
      }
      for (const l of s.labels) if (inRound(l) && l.swingSeq == null) presses.push({ ...l, logId });
      for (const j of s.rejects ?? []) if (inRound(j)) rejects.push({ ...j, logId });
    }
  }
  const byTime = (a, b) => a.time - b.time || a.seq - b.seq;
  return { swings: swings.sort(byTime), presses: presses.sort(byTime), hidden: hidden.sort(byTime), rejects: rejects.sort(byTime) };
}

// A reject worth showing as a possible shot: a real-sized swing that failed
// only one of the tracker's rules, and not by much. Walking and handling
// fail more than one, or by a lot, and stay out of the way. Tuned on the
// 31 Oct round (27 shots; the old rules showed 69 empty ? pins):
// - no strike heard: the 2 chips found this way had low band 1649 and 2439
//   and build-up 167 and 182; walking rarely has both.
// - moving just before: the 2 shots (still 116 and 119) had strikes of 3243
//   and 4835; walking past something noisy is much quieter.
export const NEAR_MISS = { peak: 300, impact: 300, low: 1400, build: 140, buildFast: 80, still: 120, movingImpact: 2500 };
export function nearMiss(j) {
  const N = NEAR_MISS;
  if (!j.pos || j.peakGyro < N.peak) return null;
  if (j.reasons === REJECT.noImpact && j.impactLevel >= N.impact && (j.lowImpact ?? 0) >= N.low && j.buildup >= N.build) return 'no strike heard';
  if (j.reasons === REJECT.noBuildup && j.buildup >= N.buildFast) return 'too sudden for a swing';
  if (j.reasons === REJECT.moving && j.still <= N.still && j.impactLevel >= N.movingImpact) return 'you were moving just before';
  return null;
}
export const HIDDEN_WHY = { thud: 'it sounded like a thud', jolt: 'the tracker jumped like a knock', 'same spot': 'a louder swing was saved nearby' };

// A shot is the player's once they've changed it: then sync leaves it alone.
const touched = (s) => s.edited || s.accepted || s.club || s.lieByHand || s.target || s.penalty || s.mishit;

// What to change so the round's tracker shots match the synced swings: add
// new ones, drop untouched ones the checks no longer count (a louder swing
// from the same spot arrived later), and never bring back one the player
// deleted. Nothing on a green counts (onGreen). A swing within 10 m and 3
// minutes of a shot marked by hand is already that shot. Also lists possible
// shots: swings the checks hid and near-miss rejects, not deleted, not next
// to a shot already there, one per spot (the loudest). Returns { add: [shot], remove: [id], presses: {hole: n},
// possible: [{ id, hole, lat, lon, time, why, ... }] }.
export function planTrackerShots({ round, course, shots, swings, presses, hidden = [], rejects = [] }) {
  const dismissed = new Set(round.trackerDismissed ?? []);
  const want = new Map();
  for (const w of swings) {
    const id = shotId(w.logId, w.seq);
    if (dismissed.has(id) || !w.pos || onGreen(course, w.pos)) continue;
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
  // Possible shots.
  const final = [...kept, ...add];
  const near = (a, b, m, ms) => distance(a, b) <= m && Math.abs(a.time - b.time) <= ms;
  const cands = [
    ...hidden.map((w) => ({ w, why: HIDDEN_WHY[w.why] ?? w.why, kind: 'hidden' })),
    ...rejects.map((j) => ({ w: j, why: nearMiss(j), kind: 'reject' })).filter((c) => c.why),
  ].filter(({ w }) => w.pos && !onGreen(course, w.pos) && !dismissed.has(shotId(w.logId, w.seq)) && !have.has(shotId(w.logId, w.seq)))
    .map(({ w, why, kind }) => ({ id: shotId(w.logId, w.seq), lat: w.pos.lat, lon: w.pos.lon, time: w.time * 1000, why, kind,
      peakGyro: w.peakGyro ?? null, impact: w.impactLevel ?? null, logId: w.logId, seq: w.seq, hdop: w.hdop }))
    .filter((c) => !final.some((s) => s.lat != null && near(c, s, 15, 90000)))
    .sort((a, b) => (b.impact ?? 0) - (a.impact ?? 0));
  const possible = [];
  for (const c of cands) if (!possible.some((p) => near(c, p, 10, 60000))) possible.push(c);
  for (const p of possible) p.hole = holeFor(course, round, p, p.time);
  possible.sort((a, b) => a.time - b.time);

  const pressHoles = {};
  for (const p of presses) {
    const h = holeFor(course, round, p.pos, p.time * 1000);
    pressHoles[h] = (pressHoles[h] ?? 0) + 1;
  }
  return { add, remove, presses: pressHoles, possible };
}

export async function reconcileTrackerShots(round, course) {
  const data = roundTrackerData(round, await db.all('captures'));
  const shots = await db.shotsForRound(round.id);
  const plan = planTrackerShots({ round, course, shots, ...data });
  for (const id of plan.remove) await db.del('shots', id);
  for (const s of plan.add) await db.put('shots', s);
  return { added: plan.add.length, removed: plan.remove.length, presses: plan.presses, possible: plan.possible };
}

// A possible shot the player confirms: a tracker shot that sync keeps.
// Accepted and dismissed ids are kept on the round as labels for tuning.
export async function acceptPossible(round, course, p, shots) {
  const t = p.time;
  const first = !shots.some((s) => s.hole === p.hole && s.time < t);
  const shot = {
    id: p.id, roundId: round.id, hole: p.hole, seq: shots.reduce((a, s) => Math.max(a, s.seq ?? 0), 0) + 1,
    lat: p.lat, lon: p.lon, accuracy: p.hdop != null ? Math.max(2.5, p.hdop * 2.5) : 5, time: t,
    club: null, source: 'tracker', confidence: null, penalty: false, lie: first ? 'tee' : null, mishit: false, target: null,
    accepted: true, tracker: { logId: p.logId, seq: p.seq, peakGyro: p.peakGyro, impact: p.impact, was: p.why },
  };
  applyAutoLie(shot, course.holes[p.hole - 1], first);
  await db.put('shots', shot);
  round.trackerAccepted = [...new Set([...(round.trackerAccepted ?? []), p.id])];
  await db.put('rounds', round);
  return shot;
}

export async function dismissPossible(round, p) {
  round.trackerDismissed = [...new Set([...(round.trackerDismissed ?? []), p.id])];
  await db.put('rounds', round);
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
