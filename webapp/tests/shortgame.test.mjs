import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planTrackerShots, applyShortGame, roundTrackerData } from '../js/trackerround.js';
import { isStroke, strokeType, greenPlace, strokeId, STROKE } from '../js/shortgame.js';
import { decodeRecord, KIND, sessions } from '../js/capturelog.js';
import { fromLocal } from '../js/geo.js';

// Hole 1 runs north 350 m to a 24 m square green; hole 2 has only a green point.
const O = { lat: -27.23, lon: 152.97 };
const at = (x, y) => fromLocal(O, { x, y });
const course = {
  holes: [
    { n: 1, par: 4, tee: at(0, 0), green: at(0, 350), shape: { polygon: [at(-12, 338), at(12, 338), at(12, 362), at(-12, 362)].map((p) => [p.lat, p.lon]) } },
    { n: 2, par: 4, tee: at(40, 360), green: at(60, 60) },
  ],
};
const t0 = Date.parse('2026-11-28T00:00:00Z');
const mkRound = (extra = {}) => ({ id: 'r1', date: new Date(t0).toISOString(), holeList: [1, 2], holes: {}, tracker: true, shortGame: true,
  holeLog: [{ hole: 1, at: t0 }], trackerDismissed: [], ...extra });
const swing = (seq, ms, p) => ({ logId: 7, seq, time: Math.floor((t0 + ms) / 1000), deviceMs: ms, pos: p, hdop: 1, peakGyro: 900, impactLevel: 9000 });
const putt = (seq, ms, p, x = {}) => ({ logId: 7, seq, time: Math.floor((t0 + ms) / 1000), deviceMs: ms, pos: p, hdop: 1,
  peak: 35, area: 18, durMs: 600, pre: 4, post: 10, high: 6, low: 5, ...x });
const chip = (seq, ms, p, x = {}) => putt(seq, ms, p, { peak: 75, area: 28, durMs: 500, high: 14, ...x });

test('stroke rules from the 26 Nov recording', () => {
  assert.equal(isStroke(putt(1, 0, at(0, 0))), true);
  assert.equal(isStroke(putt(1, 0, at(0, 0), { pre: 12 })), false);        // moving just before
  assert.equal(isStroke(putt(1, 0, at(0, 0), { durMs: 150 })), false);     // a twitch
  assert.equal(isStroke(putt(1, 0, at(0, 0), { peak: 400 })), false);      // a full swing
  assert.equal(strokeType(chip(1, 0, at(0, 0))), 'chip');
  assert.equal(strokeType(putt(1, 0, at(0, 0))), 'putt');
  assert.equal(strokeType(putt(1, 0, at(0, 0), { high: 0, peak: 60 })), 'chip');   // no sound: by size
  assert.deepEqual(greenPlace(course.holes[0], at(0, 350)).inside, true);
  assert.ok(Math.abs(greenPlace(course.holes[0], at(0, 330)).edge - 8) < 0.1);
  assert.equal(greenPlace(course.holes[1], at(60, 65)).inside, true);       // circle round the green point
  assert.equal(greenPlace({ n: 3 }, at(0, 0)), null);
});

test('beta round: chips become tracker shots, putts fill the count, practice strokes and full swings left out', () => {
  const round = mkRound();
  const swings = [swing(2, 60000, at(0, 2)), swing(3, 300000, at(5, 200))];   // tee shot, approach to 30 m short
  const strokes = [
    putt(10, 20000, at(0, 5)),                // on the tee before the drive: far from any green
    chip(11, 302000, at(5, 200)),             // 2 s after the approach: its follow-through
    chip(12, 420000, at(2, 318)),             // a practice chip...
    chip(13, 428000, at(3, 319)),             // ...then the chip, 20 m short
    putt(14, 500000, at(0, 345)),             // putt from 7 m inside the front
    putt(15, 530000, at(1, 351)),             // 6 m further on: the second putt
    putt(16, 531000, at(1, 351), { peak: 20 }),   // within 3 s: the smaller goes
    putt(17, 540000, at(0, 362.5)),           // 0.5 m off the back, sounds like a putt: putt
  ];
  const plan = planTrackerShots({ round, course, shots: [], swings, presses: [], strokes });
  const chips = plan.add.filter((s) => s.shortGame === 'chip');
  assert.deepEqual(chips.map((s) => s.id), [strokeId(7, 13)]);
  assert.equal(chips[0].hole, 1);
  assert.equal(chips[0].source, 'tracker');
  assert.deepEqual(plan.shortGame.chips, { 1: 1 });
  assert.deepEqual(plan.shortGame.putts, { 1: 3 });
  // No ? pin next to the chip.
  assert.ok(!plan.possible.some((p) => Math.abs(p.time - (t0 + 428000)) < 60000));

  // Into the hole stats; a count the player set stays.
  assert.equal(applyShortGame(round, plan.shortGame, [1]), true);
  assert.equal(round.holes[1].putts, 3); assert.equal(round.holes[1].puttsAuto, true);
  assert.equal(round.holes[1].chips, 1); assert.equal(round.holes[1].chipsAuto, true);
  assert.equal(applyShortGame(round, plan.shortGame, [1]), false);
  round.holes[1].putts = 2; delete round.holes[1].puttsAuto;
  applyShortGame(round, { chips: {}, putts: { 1: 4 } }, [1]);
  assert.equal(round.holes[1].putts, 2);
  assert.equal(round.holes[1].chips, 0);                 // the chip went (deleted): auto count follows

  // A deleted chip doesn't come back; an untouched one the rules drop is removed.
  const shots = [...plan.add];
  const again = planTrackerShots({ round: mkRound({ trackerDismissed: [strokeId(7, 13)] }), course, shots, swings, presses: [], strokes });
  assert.ok(again.remove.includes(strokeId(7, 13)));
  assert.equal(again.add.length, 0);
});

test('without the beta, strokes change nothing', () => {
  const round = mkRound({ shortGame: false });
  const swings = [swing(2, 60000, at(0, 2))];
  const plan = planTrackerShots({ round, course, shots: [], swings, presses: [], strokes: [chip(13, 428000, at(3, 319)), putt(14, 500000, at(0, 345))] });
  assert.equal(plan.shortGame, null);
  assert.equal(plan.add.length, 1);
});

test('stroke records from the firmware (0.7.0 host test)', () => {
  const bin = new Uint8Array(readFileSync(new URL('./fixtures/capture-log-strokes.bin', import.meta.url)));
  const recs = [];
  for (let o = 0; o < bin.length; ) { const len = bin[o + 2] | (bin[o + 3] << 8); const b = bin.subarray(o, o + len); recs.push({ ...decodeRecord(b), bytes: b, logId: 3 }); o += len; }
  const st = recs.filter((r) => r.kind === KIND.stroke);
  assert.equal(st.length, 2);
  assert.ok(st.every((r) => r.crcOk));
  assert.ok(st[0].peak > 31 && st[0].peak < 36 && st[0].durMs > 500 && st[0].durMs < 700 && st[0].high === 10 && st[0].pre < 3);
  assert.ok(st[1].peak > 74 && st[1].high === 200 && st[1].low === 54);
  assert.deepEqual(st[0].gravity, [0, 0, 1]);
  assert.equal(st[0].inRecording, false);
  assert.equal(strokeType(st[0]), 'putt'); assert.equal(strokeType(st[1]), 'chip');
  assert.equal(sessions(recs)[0].strokes.length, 2);
});
