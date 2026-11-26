// Rounds played with the shot tracker: keep the tracker in round mode, sync
// its capture log during the round, and turn the swings it saves into shots
// on the map. Chips and putts are entered by hand, unless the round has the
// beta turned on (round.shortGame, shortgame.js): then chips become tracker
// shots and putts fill in each hole's count, both correctable.
import * as db from './db.js';
import { tracker, OP } from './transport.js';
import { decodeRecord, sessions, notShots, REJECT } from './capturelog.js';
import { distance, toLocal } from './geo.js';
import { applyAutoLie } from './holemap.js';
import { playOrder, holeFor as roundHole } from './stats.js';
import { pointInPolygon } from './greens.js';
import { planShortGame } from './shortgame.js';

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

// ---------- a clear tracker for every round ----------
// Once per round, when the tracker first connects to it: copy everything on
// the tracker to the phone, check every record arrived, then clear the
// tracker's storage so a long round (or a practice recording left on it)
// can't fill it mid-round. Nothing is cleared unless the phone has every
// record; the phone keeps its copy (the Training data screen exports it).
// Returns { cleared } once done for this round, or null if it can't be done
// yet (no tracker); throws if the copy didn't complete, and tries again at
// the next connection.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let clearing = null;
export function clearTrackerForRound(round, deps) {
  clearing ??= clearOnce(round, deps).finally(() => { clearing = null; });
  return clearing;
}
async function clearOnce(round, {
  sync = syncCaptures,
  have = async (logId) => cursor(await db.capturesForLog(logId)),
  save = (r) => db.put('rounds', r),
  waitMs = 5000,
} = {}) {
  if (!round || round.trackerCleared) return null;
  if (tracker.state !== 'connected' || !tracker.hasCapture || !tracker.capture) return null;
  const logId = tracker.capture.logId;
  const used = tracker.capture.nextSeq > 1;   // seq 0 is the log-start record
  if (used) {
    let copied = false;
    for (let i = 0; i < 3 && !copied; i++) {
      for (let t = 0; tracker.sync && t < 60000; t += 200) await sleep(200);   // a sync already running
      await sync();
      const c = tracker.capture;
      copied = c?.logId === logId && (await have(logId)) >= c.nextSeq;
    }
    if (!copied) throw new Error("Couldn't copy everything off the tracker, so its storage wasn't cleared. It tries again when the tracker reconnects.");
    await tracker.send(OP.eraseLog, logId);
    for (let t = 0; tracker.capture?.logId === logId && t < waitMs; t += 100) await sleep(100);
    if (tracker.capture?.logId === logId) throw new Error("The tracker didn't confirm its storage was cleared. It tries again when the tracker reconnects.");
  }
  round.trackerCleared = true;
  await save(round);
  return { cleared: used };
}

// Round mode on the tracker (trigger 250, impact needed) and a session open,
// after clearing its storage for a new round (clearTrackerForRound).
// A gate the player has already tuned is kept. Returns what the clear did.
export async function prepareTracker(round) {
  if (tracker.state !== 'connected' || !tracker.hasCapture) return null;
  let cleared = null, clearError = null;
  try { cleared = await clearTrackerForRound(round); } catch (err) { clearError = err; }
  const c = tracker.capture;
  if (!c) return null;
  if (!c.enabled) await tracker.send(OP.setCapture, true);
  if (c.soundGate != null && !c.soundGate) await tracker.send(OP.setSoundGate, ROUND_GATE);
  if (c.trigger !== ROUND_TRIGGER) await tracker.send(OP.setTrigger, ROUND_TRIGGER);
  if (!c.session) await tracker.send(OP.startRound);
  // Firmware 0.4.0+: the app owns the round, so the button can't end it.
  if (c.locked === false) await tracker.send(OP.lockRound, true);
  if (clearError) throw clearError;
  return cleared;
}

export async function endTrackerRound() {
  if (tracker.state === 'connected' && tracker.capture?.session) await tracker.send(OP.endRound).catch(() => {});
}

// ---------- which hole a swing belongs to ----------
// Metres from p to a polygon of {lat, lon} points (0 inside it).
function metresFromPolygon(p, pts) {
  if (pointInPolygon(p, pts)) return 0;
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = toLocal(p, pts[i]), b = toLocal(p, pts[(i + 1) % pts.length]);
    const ex = b.x - a.x, ey = b.y - a.y, L2 = ex * ex + ey * ey;
    const t = L2 ? Math.max(0, Math.min(1, -(a.x * ex + a.y * ey) / L2)) : 0;
    best = Math.min(best, Math.hypot(a.x + t * ex, a.y + t * ey));
  }
  return best;
}

// On a hole's tee: on or within TEE_BOX_M of one of its mapped tee boxes,
// or, with none mapped, within TEE_POINT_M of its tee point. Kept tight so a
// ball that finishes near a tee isn't taken for a tee shot.
export const TEE_BOX_M = 5, TEE_POINT_M = 15;
export function onTee(courseHole, p) {
  if (!p || !courseHole) return false;
  const boxes = (courseHole.features?.tees ?? []).filter((r) => r?.length > 2);
  if (boxes.length) return boxes.some((r) => metresFromPolygon(p, r.map(([lat, lon]) => ({ lat, lon }))) <= TEE_BOX_M);
  return !!courseHole.tee && distance(p, courseHole.tee) <= TEE_POINT_M;
}

// The hole in play at the time of a swing: the hole on screen. A ball hit
// into another hole's fairway is still played on this hole, so where the
// swing was doesn't move it (until 14 Nov 2026 a swing nearer the next or
// previous hole's line went to that hole, which put shots from a neighbouring
// fairway on the wrong hole). The one exception is teeing off on the next
// hole before moving the app on: from that swing play has moved to the next
// hole, until the hole on screen changes. `earlier` is the round's other
// swings ({ pos, time } with time in ms, any order), used to see that.
export function holeFor(course, round, p, timeMs, earlier = []) {
  const order = playOrder(course, round);
  let h = order[0], since = -Infinity;
  for (const e of round.holeLog ?? []) if (e.at <= timeMs) { h = e.hole; since = e.at; }
  const seen = earlier.filter((w) => w.pos && w.time > since && w.time < timeMs).sort((a, b) => a.time - b.time);
  for (const w of [...seen, { pos: p }]) {
    const next = order[order.indexOf(h) + 1];
    if (next != null && onTee(roundHole(course, next), w.pos)) h = next;
  }
  return h;
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

// Metres from p to the nearest mapped green outline (0 on one), or null if
// the course has none mapped.
export function metresFromGreen(course, p) {
  let best = null;
  for (const h of course?.holes ?? []) {
    const poly = h?.shape?.polygon;
    if (!(poly?.length > 2)) continue;
    const d = metresFromPolygon(p, poly.map(([lat, lon]) => ({ lat, lon })));
    if (best == null || d < best) best = d;
  }
  return best;
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
  const swings = [], presses = [], hidden = [], rejects = [], strokes = [];
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
      for (const c of s.strokes ?? []) if (inRound(c)) strokes.push({ ...c, logId });
    }
  }
  const byTime = (a, b) => a.time - b.time || a.seq - b.seq;
  return { swings: swings.sort(byTime), presses: presses.sort(byTime), hidden: hidden.sort(byTime), rejects: rejects.sort(byTime), strokes: strokes.sort(byTime) };
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

// Possible shots are one per spot and stay clear of shots: none within
// POSSIBLE_M and POSSIBLE_MS of a shot or of a louder possible shot. Was 15 m
// and 90 s from shots, 10 m and 60 s between them; 3 minutes (7 Nov 2026)
// drops the practice swings and rehearsals made while partners play: about
// 1 in 5 of the empty ? pins on 31 Oct-6 Nov, with no shot lost.
export const POSSIBLE_M = 15, POSSIBLE_MS = 180000;

// A hidden swing (a thud or knock that didn't turn like a downswing) more
// than HIDDEN_GREEN_M from every green isn't a ?: too far out for a chip,
// and a full shot from there turns. 8 Nov 2026, five rounds: 0 of 47 real ?
// shots, about 1 in 10 empty pins.
export const HIDDEN_GREEN_M = 40;

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
//
// With round.shortGame (beta), stroke candidates become chips (tracker shots
// with shortGame: 'chip', ids from strokeId) and putts per hole:
// { chips: {hole: n}, putts: {hole: n} } in `shortGame`.
export function planTrackerShots({ round, course, shots, swings, presses, hidden = [], rejects = [], strokes = [] }) {
  const dismissed = new Set(round.trackerDismissed ?? []);
  const want = new Map();
  for (const w of swings) {
    const id = shotId(w.logId, w.seq);
    if (dismissed.has(id) || !w.pos || onGreen(course, w.pos)) continue;
    const t = w.time * 1000;
    const marked = shots.some((s) => s.source !== 'tracker' && s.lat != null && distance(s, w.pos) < 10 && t - s.time >= -60000 && t - s.time < 180000);
    if (!marked) want.set(id, w);
  }
  // Where play has got to, for holeFor(): every swing that counts.
  const played = [...want.values()].map((w) => ({ pos: w.pos, time: w.time * 1000 }));
  const isChip = (s) => s.shortGame === 'chip';
  const remove = shots.filter((s) => s.source === 'tracker' && !isChip(s) && !want.has(s.id) && !touched(s)).map((s) => s.id);
  const kept = shots.filter((s) => !remove.includes(s.id));
  const have = new Set(shots.map((s) => s.id));
  let seq = shots.reduce((a, s) => Math.max(a, s.seq ?? 0), 0);
  const add = [];
  for (const [id, w] of want) {
    if (have.has(id)) continue;
    const t = w.time * 1000;
    const hole = holeFor(course, round, w.pos, t, played);
    const first = ![...kept, ...add].some((s) => s.hole === hole && s.time < t);
    const shot = {
      id, roundId: round.id, hole, seq: ++seq, lat: w.pos.lat, lon: w.pos.lon,
      accuracy: w.hdop != null ? Math.max(2.5, w.hdop * 2.5) : 5, time: t,
      club: null, source: 'tracker', confidence: null, penalty: false, lie: first ? 'tee' : null, mishit: false, target: null,
      tracker: { logId: w.logId, seq: w.seq, peakGyro: w.peakGyro ?? null, impact: w.impactLevel ?? null },
    };
    applyAutoLie(shot, roundHole(course, hole), first);
    add.push(shot);
  }
  // Chips and putts (beta).
  let shortGame = null;
  if (round.shortGame) {
    const fullNow = [...kept, ...add].filter((s) => !isChip(s));
    const sg = planShortGame({ round, course, strokes, shots: fullNow, holeAt: (p, t) => holeFor(course, round, p, t, played) });
    const wantChip = new Set(sg.chips.map((c) => c.id));
    for (const s of shots) if (isChip(s) && !wantChip.has(s.id) && !touched(s)) remove.push(s.id);
    for (const c of sg.chips) {
      if (have.has(c.id)) continue;
      const shot = {
        id: c.id, roundId: round.id, hole: c.hole, seq: ++seq, lat: c.lat, lon: c.lon,
        accuracy: c.hdop != null ? Math.max(2.5, c.hdop * 2.5) : 5, time: c.time,
        club: null, source: 'tracker', shortGame: 'chip', confidence: null, penalty: false, lie: null, mishit: false, target: null,
        tracker: { logId: c.c.logId, seq: c.c.seq, peak: c.c.peak, turn: c.c.area, sound: c.c.high },
      };
      applyAutoLie(shot, roundHole(course, c.hole), false);
      add.push(shot);
    }
    const chipCount = {}, puttCount = {};
    for (const s of [...shots, ...add]) if (isChip(s) && !remove.includes(s.id)) chipCount[s.hole] = (chipCount[s.hole] ?? 0) + 1;
    for (const [h, list] of Object.entries(sg.putts)) puttCount[h] = list.length;
    shortGame = { chips: chipCount, putts: puttCount, puttSpots: sg.putts };
  }
  for (let i = kept.length - 1; i >= 0; i--) if (remove.includes(kept[i].id)) kept.splice(i, 1);

  // Possible shots.
  const final = [...kept, ...add];
  const near = (a, b, m, ms) => distance(a, b) <= m && Math.abs(a.time - b.time) <= ms;
  const cands = [
    ...hidden.map((w) => ({ w, why: HIDDEN_WHY[w.why] ?? w.why, kind: 'hidden' })),
    ...rejects.map((j) => ({ w: j, why: nearMiss(j), kind: 'reject' })).filter((c) => c.why),
  ].filter(({ w }) => w.pos && !onGreen(course, w.pos) && !dismissed.has(shotId(w.logId, w.seq)) && !have.has(shotId(w.logId, w.seq)))
    .filter(({ w, kind }) => kind !== 'hidden' || !(metresFromGreen(course, w.pos) > HIDDEN_GREEN_M))
    .map(({ w, why, kind }) => ({ id: shotId(w.logId, w.seq), lat: w.pos.lat, lon: w.pos.lon, time: w.time * 1000, why, kind,
      peakGyro: w.peakGyro ?? null, impact: w.impactLevel ?? null, logId: w.logId, seq: w.seq, hdop: w.hdop }))
    .filter((c) => !final.some((s) => s.lat != null && near(c, s, POSSIBLE_M, POSSIBLE_MS)))
    .sort((a, b) => (b.impact ?? 0) - (a.impact ?? 0));
  const possible = [];
  for (const c of cands) if (!possible.some((p) => near(c, p, POSSIBLE_M, POSSIBLE_MS))) possible.push(c);
  for (const p of possible) p.hole = holeFor(course, round, p, p.time, played);
  possible.sort((a, b) => a.time - b.time);

  const pressHoles = {};
  for (const p of presses) {
    const h = holeFor(course, round, p.pos, p.time * 1000, played);
    pressHoles[h] = (pressHoles[h] ?? 0) + 1;
  }
  return { add, remove, presses: pressHoles, possible, shortGame };
}

// The beta's counts into the round's hole stats. A count the player set
// (no puttsAuto / chipsAuto flag) is theirs and stays. Holes are only filled
// once play has reached them. Returns true if anything changed.
export function applyShortGame(round, shortGame, holes) {
  if (!shortGame) return false;
  let changed = false;
  for (const h of holes) {
    const hs = (round.holes[h] ??= { putts: null, chips: 0, bunker: 0, penalties: 0, fairway: null, score: null, greenPos: null });
    const putts = shortGame.putts[h] ?? 0, chips = shortGame.chips[h] ?? 0;
    if (hs.putts == null || hs.puttsAuto) {
      const v = putts > 0 ? putts : null;
      if (hs.putts !== v || !!hs.puttsAuto !== (v != null)) {
        hs.putts = v;
        if (v != null) hs.puttsAuto = true; else delete hs.puttsAuto;
        changed = true;
      }
    }
    if (!hs.chips || hs.chipsAuto) {
      if ((hs.chips ?? 0) !== chips || !!hs.chipsAuto !== chips > 0) {
        hs.chips = chips;
        if (chips > 0) hs.chipsAuto = true; else delete hs.chipsAuto;
        changed = true;
      }
    }
  }
  return changed;
}

export async function reconcileTrackerShots(round, course) {
  const data = roundTrackerData(round, await db.all('captures'));
  const shots = await db.shotsForRound(round.id);
  const plan = planTrackerShots({ round, course, shots, ...data });
  for (const id of plan.remove) await db.del('shots', id);
  for (const s of plan.add) await db.put('shots', s);
  let holesChanged = false;
  if (plan.shortGame) {
    // Holes play has reached: the one on screen and every one before it in the round.
    const order = playOrder(course, round);
    const now = (round.holeLog ?? []).at(-1)?.hole ?? order[0];
    const reached = order.slice(0, order.indexOf(now) + 1);
    holesChanged = applyShortGame(round, plan.shortGame, reached);
    if (holesChanged) await db.put('rounds', round);
  }
  return { added: plan.add.length, removed: plan.remove.length, presses: plan.presses, possible: plan.possible,
    shortGame: plan.shortGame, holesChanged };
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
  applyAutoLie(shot, roundHole(course, p.hole), first);
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
