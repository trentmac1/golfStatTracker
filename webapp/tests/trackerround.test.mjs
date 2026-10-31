import test from 'node:test';
import assert from 'node:assert/strict';
import { holeFor, distanceToHole, planTrackerShots, roundTrackerData, shotId } from '../js/trackerround.js';
import { encodeLogStart, encodeSession, encodeSwing, encodeLabel, decodeRecord } from '../js/capturelog.js';
import { fromLocal } from '../js/geo.js';
import { sortShots } from '../js/stats.js';

// Two holes side by side: hole 1 runs north 350 m, hole 2 comes back south
// 300 m, 60 m to the east. Hole 2's tee is next to hole 1's green.
const O = { lat: -27.23, lon: 152.97 };
const at = (x, y) => fromLocal(O, { x, y });
const course = {
  holes: [
    { n: 1, par: 4, tee: at(0, 0), green: at(0, 350), shape: { polygon: [at(-12, 338), at(12, 338), at(12, 362), at(-12, 362)].map((p) => [p.lat, p.lon]) } },
    { n: 2, par: 4, tee: at(40, 360), green: at(60, 60) },
    { n: 3, par: 3, tee: at(80, 40), green: at(200, 40) },
  ],
};
const t0 = Date.parse('2026-10-25T00:00:00Z');
const round = { id: 'r1', date: new Date(t0).toISOString(), holeList: [1, 2, 3], holes: {}, tracker: true, holeLog: [{ hole: 1, at: t0 }], trackerDismissed: [] };

test('nothing on a green is a shot or a possible shot', async () => {
  const { onGreen } = await import('../js/trackerround.js');
  const { REJECT } = await import('../js/capturelog.js');
  assert.equal(onGreen(course, at(3, 355)), true);
  assert.equal(onGreen(course, at(0, 330)), false);           // chip 8 m short of the green
  assert.equal(onGreen(course, at(60, 60)), false);           // hole 2 has no outline
  const swings = [swing(7, 2, 60000, at(0, 2)), swing(7, 3, 700000, at(3, 355))];   // tee shot, then a putt
  const rejects = [swing(7, 4, 760000, at(-4, 350), { reasons: REJECT.noImpact, impactLevel: 600, lowImpact: 2000, buildup: 160 })];
  const plan = planTrackerShots({ round, course, shots: [], swings, presses: [], rejects });
  assert.deepEqual(plan.add.map((s) => s.tracker.seq), [2]);
  assert.equal(plan.possible.length, 0);
});

test('distance to a hole is to its line of play', () => {
  assert.ok(distanceToHole(at(5, 200), course.holes[0]) < 6);
  assert.ok(distanceToHole(at(5, 200), course.holes[1]) > 40);
});

test('a swing goes to the hole on screen, or the next one when it is clearly there', () => {
  assert.equal(holeFor(course, round, at(2, 5), t0 + 60000), 1);          // tee shot on 1
  assert.equal(holeFor(course, round, at(0, 330), t0 + 600000), 1);       // chip near 1's green
  assert.equal(holeFor(course, round, at(41, 355), t0 + 900000), 2);      // hit off 2's tee before moving the app on
  assert.equal(holeFor(course, round, null, t0 + 900000), 1);             // no position: the hole on screen
});

const swing = (logId, seq, ms, p, extra = {}) => ({ logId, seq, time: Math.floor((t0 + ms) / 1000), pos: p, hdop: 1, peakGyro: 700, impactLevel: 9000, ...extra });

test('planning: adds new swings, skips deleted ones and ones already marked by hand', () => {
  const swings = [swing(7, 2, 60000, at(0, 2)), swing(7, 3, 300000, at(3, 200)), swing(7, 4, 600000, at(1, 300))];
  const manual = { id: 'm1', roundId: 'r1', hole: 1, seq: 1, lat: at(2, 198).lat, lon: at(2, 198).lon, time: t0 + 290000, source: 'manual' };
  const r = { ...round, trackerDismissed: [shotId(7, 4)] };
  const plan = planTrackerShots({ round: r, course, shots: [manual], swings, presses: [] });
  assert.deepEqual(plan.add.map((s) => s.id), [shotId(7, 2)]);
  assert.equal(plan.add[0].source, 'tracker');
  assert.equal(plan.add[0].hole, 1);
  assert.equal(plan.add[0].lie, 'tee');
  assert.equal(plan.remove.length, 0);
  // In play order with the shot marked by hand.
  const order = sortShots([manual, ...plan.add]).map((s) => s.id);
  assert.deepEqual(order, [shotId(7, 2), 'm1']);
});

test('planning: an untouched tracker shot that no longer counts is removed; an edited one stays', () => {
  const old = (seq, extra = {}) => ({ id: shotId(7, seq), roundId: 'r1', hole: 1, seq, lat: O.lat, lon: O.lon, time: t0, source: 'tracker', ...extra });
  const plan = planTrackerShots({ round, course, shots: [old(2), old(3, { club: '7i' })], swings: [], presses: [] });
  assert.deepEqual(plan.remove, [shotId(7, 2)]);
});

test('from capture records: swings in the round become shots, presses are counted per hole, same-spot practice swings are left out', () => {
  const logId = 0x51;
  const ctx = (ms, p) => ({ time: Math.floor((t0 + ms) / 1000), deviceMs: 100000 + ms, pos: p, hdop: 1, sats: 9 });
  const bytes = [
    encodeLogStart(0, logId),
    encodeSession(1, true, ctx(0, at(0, 0)), 250, 1000),
    encodeSwing(2, ctx(50000, at(0, 1))),             // practice swing on the tee
    encodeSwing(3, ctx(80000, at(1, 1))),             // tee shot, 30 s later, same spot
    encodeSwing(4, ctx(400000, at(2, 210))),          // second shot
    encodeLabel(5, ctx(700000, at(0, 340))),          // a chip, by button
    encodeLabel(6, ctx(760000, at(0, 350))),          // a putt
    encodeSwing(7, ctx(-3600000, at(0, 0))),          // an hour before the round: not this round
  ];
  const rows = bytes.map((b) => ({ ...decodeRecord(b), bytes: b, logId }));
  const { swings, presses } = roundTrackerData(round, rows, t0 + 3600000);
  assert.equal(presses.length, 2);
  assert.equal(swings.length, 2);                      // one of the tee pair, and the second shot
  assert.ok(!swings.some((w) => w.seq === 7));
  const plan = planTrackerShots({ round, course, shots: [], swings, presses });
  assert.equal(plan.add.length, 2);
  assert.ok(plan.add.every((s) => s.hole === 1));
  assert.deepEqual(plan.presses, { 1: 2 });
});

test('possible shots: hidden swings and near-miss rejects, not next to a shot, not dismissed', async () => {
  const { nearMiss } = await import('../js/trackerround.js');
  const { REJECT } = await import('../js/capturelog.js');
  const w = (seq, ms, p, extra = {}) => ({ logId: 7, seq, time: Math.floor((t0 + ms) / 1000), pos: p, hdop: 1, peakGyro: 600, impactLevel: 2000, ...extra });
  const swings = [w(2, 60000, at(0, 2))];                                     // the tee shot
  const hidden = [
    { ...w(3, 70000, at(1, 3)), why: 'same spot' },                           // practice swing next to it: not shown
    { ...w(4, 400000, at(2, 210)), why: 'thud' },                             // second shot, hidden as a thud: shown
  ];
  const rejects = [
    w(5, 700000, at(0, 330), { reasons: REJECT.noImpact, impactLevel: 600, lowImpact: 1700, buildup: 160 }),  // chip with a quiet strike: shown
    w(6, 800000, at(0, 340), { reasons: REJECT.noImpact | REJECT.moving, impactLevel: 600 }),   // two rules: not shown
    w(7, 900000, at(0, 345), { reasons: REJECT.moving, still: 300 }),           // walking about: not shown
    w(8, 950000, at(0, 348), { reasons: REJECT.noBuildup, buildup: 90, peakGyro: 200 }),   // too small: not shown
  ];
  assert.equal(nearMiss(rejects[0]), 'no strike heard');
  assert.equal(nearMiss(rejects[1]), null);
  // 31 Oct tuning: a quiet strike needs a real build-up and a low-band thump;
  // moving just before needs a loud strike.
  assert.equal(nearMiss({ ...rejects[0], lowImpact: 900 }), null);
  assert.equal(nearMiss({ ...rejects[0], buildup: 120 }), null);
  assert.equal(nearMiss(w(9, 0, at(0, 0), { reasons: REJECT.moving, still: 116, impactLevel: 3243 })), 'you were moving just before');
  assert.equal(nearMiss(w(9, 0, at(0, 0), { reasons: REJECT.moving, still: 116, impactLevel: 1500 })), null);
  assert.equal(nearMiss(w(9, 0, at(0, 0), { reasons: REJECT.moving, still: 130, impactLevel: 4000 })), null);
  const plan = planTrackerShots({ round, course, shots: [], swings, presses: [], hidden, rejects });
  assert.deepEqual(plan.possible.map((p) => p.seq), [4, 5]);
  assert.ok(plan.possible.every((p) => p.hole === 1));
  assert.match(plan.possible[0].why, /thud/);
  const r2 = { ...round, trackerDismissed: [shotId(7, 4)] };
  assert.deepEqual(planTrackerShots({ round: r2, course, shots: [], swings, presses: [], hidden, rejects }).possible.map((p) => p.seq), [5]);
  // An accepted possible is a touched tracker shot: never removed by sync.
  const accepted = { id: shotId(7, 4), roundId: 'r1', hole: 1, seq: 9, lat: at(2, 210).lat, lon: at(2, 210).lon, time: t0 + 400000, source: 'tracker', accepted: true };
  const plan3 = planTrackerShots({ round, course, shots: [accepted], swings, presses: [], hidden, rejects });
  assert.equal(plan3.remove.length, 0);
  assert.deepEqual(plan3.possible.map((p) => p.seq), [5]);
});
