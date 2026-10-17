import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  decodeRecord, crc16, Reassembler, chunkRecord, sessions, exportJson, encodeSwing, encodeLabel,
  encodeSession, encodeLogStart, impactOffsetMs, KIND,
} from '../js/capturelog.js';
import { decodeCapture, encodeCapture, encodeControl, OP, tracker } from '../js/transport.js';

// Written by the firmware's own code (firmware/test/host/test_capture.cpp,
// store.cpp + capture.cpp against simulated sensors): log start, session
// start, a swing peaking at device_ms 6000 with a click 20 ms later, a label
// 2 s after it, a label with no swing, session end.
const fixture = new Uint8Array(readFileSync(new URL('./fixtures/capture-log.bin', import.meta.url)));

function split(bytes) {
  const out = [];
  for (let a = 0; a < bytes.length;) {
    const len = bytes[a + 2] | (bytes[a + 3] << 8);
    out.push(bytes.slice(a, a + len));
    a += len;
  }
  return out;
}

test('decodes records written by the firmware', () => {
  const recs = split(fixture).map((b) => decodeRecord(b, { full: true }));
  assert.deepEqual(recs.map((r) => r.kind), [1, 2, 4, 5, 5, 3]);
  assert.ok(recs.every((r) => r.crcOk));
  assert.deepEqual(recs.map((r) => r.seq), [0, 1, 2, 3, 4, 5]);
  const [start, , swing, label, missed] = recs;
  assert.equal(start.firmware, '0.2.0');
  assert.equal(swing.len, 7548);
  assert.equal(swing.lowCount, 500); assert.equal(swing.low.length, 500); assert.equal(swing.lowImpact, 3000);
  assert.ok(Math.abs(swing.lowRateHz - 252) < 0.5 && Math.abs(swing.lowStartMs + 1500) < 3);
  assert.equal(swing.deviceMs, 6000);
  assert.ok(Math.abs(swing.pos.lat + 27.39284) < 1e-6 && Math.abs(swing.pos.lon - 152.947079) < 1e-6);
  assert.equal(swing.sats, 12); assert.equal(swing.hdop, 1.1);
  assert.equal(swing.imuCount, 416); assert.equal(swing.imuPeakIndex, 312);
  assert.equal(swing.imu.length, 416); assert.equal(swing.env.length, 2000);
  assert.ok(swing.peakGyro > 880);
  // The sample at the peak index is the biggest rotation.
  const g = swing.imu.map(([x, y, z]) => Math.hypot(x, y, z));
  assert.equal(g.indexOf(Math.max(...g)), 312);
  assert.deepEqual(swing.flags, { imuOverrun: false, audioMissing: false, imuMissing: false });
  const off = impactOffsetMs(split(fixture)[2]);
  assert.ok(Math.abs(off - 20) <= 3, `impact at ${off} ms`);
  assert.equal(label.refSeq, 2); assert.equal(label.gapMs, 2000);
  assert.equal(missed.refSeq, null); assert.equal(missed.gapMs, null);
});

test('swing shape: thud ratio and jolt from a firmware-written swing', async () => {
  const { swingShape } = await import('../js/capturelog.js');
  const sh = swingShape(split(fixture)[2]);
  assert.ok(Math.abs(sh.thud - 3000 / 40000) < 0.01, `thud ${sh.thud}`);
  assert.ok(sh.jolt != null && sh.jolt < 1, `jolt ${sh.jolt}`);   // simulated swing: steady 1 g
  assert.ok(sh.build > 110 && sh.still < 70);
});

test('a damaged record fails its CRC', () => {
  const swing = split(fixture)[2];
  swing[100] ^= 0x40;
  assert.equal(decodeRecord(swing).crcOk, false);
  assert.equal(crc16(new TextEncoder().encode('123456789')), 0x29b1);   // CRC-16/CCITT-FALSE check value
});

test('reassembles chunks and drops a record with a lost chunk', () => {
  const recs = split(fixture);
  const got = [];
  const re = new Reassembler((b) => got.push(b));
  for (const r of recs) for (const c of chunkRecord(r, r[4] | (r[5] << 8), 182)) re.push(c);
  assert.equal(re.push(new DataView(new Uint8Array([0xff]).buffer)), 'end');
  assert.equal(got.length, recs.length);
  assert.deepEqual(got[2], recs[2]);

  const got2 = [];
  const re2 = new Reassembler((b) => got2.push(b));
  const chunks = chunkRecord(recs[2], 2, 247);
  chunks.splice(5, 1);
  for (const c of chunks) re2.push(c);
  for (const c of chunkRecord(recs[3], 3, 247)) re2.push(c);
  assert.equal(got2.length, 1);
  assert.equal(decodeRecord(got2[0]).seq, 3);
  assert.ok(re2.errors > 0);
});

test('sessions and the JSON export', () => {
  const ctx = (t) => ({ time: 1790000000 + t, deviceMs: t * 1000, pos: { lat: -27.4, lon: 152.9 }, hdop: 1, sats: 9 });
  const bytes = [
    encodeLogStart(0, 0xabc), encodeSession(1, true, ctx(0)), encodeSwing(2, ctx(10)), encodeSwing(3, ctx(20), { loud: false }),
    encodeLabel(4, ctx(25), 3, 5000), encodeLabel(5, ctx(60)), encodeSession(6, false, ctx(70)),
    encodeSession(7, true, ctx(100)), encodeSwing(8, ctx(110)),
  ];
  const rows = bytes.map((b) => ({ ...decodeRecord(b), bytes: b, logId: 0xabc, id: `abc-${b[4]}` }));
  const ss = sessions(rows);
  assert.equal(ss.length, 2);
  assert.equal(ss[0].swings.length, 2); assert.equal(ss[0].real, 1); assert.equal(ss[0].missed, 1); assert.equal(ss[0].ended, true);
  assert.equal(ss[1].swings.length, 1); assert.equal(ss[1].ended, false);
  const out = exportJson(rows, { appVersion: 'test' });
  assert.equal(out.app, 'golftracker-capture');
  assert.equal(out.logs[0].logId, '00000abc');
  const s0 = out.logs[0].sessions[0];
  assert.deepEqual(s0.swings.map((w) => w.labelled), [false, true]);
  assert.equal(s0.swings[1].label_gap_ms, 5000);
  assert.equal(s0.swings[0].imu.raw.length, 416);
  assert.equal(s0.swings[0].envelope.sqrt_level.length, 2000);
  assert.equal(s0.labels[1].swing_seq, null);
  assert.equal(s0.labels[0].swing_seq, 3);
  assert.ok(JSON.stringify(out).length < 40000 * 3);
});

test('a press that makes its own snippet labels the shot before it', () => {
  // As in Trent's 15 Oct session: shot peaks at 0 s, reaching for the button
  // makes a snippet peaking 1.9 s later, the press follows 0.1 s after that.
  const ctx = (ms) => ({ time: 1790000000 + Math.floor(ms / 1000), deviceMs: 100000 + ms });
  const bytes = [
    encodeSession(1, true, ctx(0)), encodeSwing(2, ctx(0)), encodeSwing(3, ctx(1900)), encodeLabel(4, ctx(2000), 3, 100),
    encodeSwing(5, ctx(30000)), encodeLabel(6, ctx(33000), 5, 3000),
  ];
  const rows = bytes.map((b) => ({ ...decodeRecord(b), bytes: b, logId: 1 }));
  const [s] = sessions(rows);
  assert.deepEqual([...s.labelledSeqs.keys()], [2, 5]);
  assert.equal(s.labelledSeqs.get(2), 2000);
  assert.equal(s.real, 2); assert.equal(s.missed, 0);
  assert.deepEqual([...s.pressSeqs], [3]);
});

test('round mode: swings close together at the same spot keep only the most likely shot', () => {
  const pos = { lat: -27.39, lon: 152.94 };
  const ctx = (ms, p = pos) => ({ time: 1790000000 + Math.floor(ms / 1000), deviceMs: 100000 + ms, pos: p, hdop: 1, sats: 9 });
  const bytes = [
    encodeSession(1, true, ctx(0), 250, 1000),
    encodeSwing(2, ctx(1000)),                                   // real shot
    encodeSwing(3, ctx(40000)),                                  // practice swing 39 s later, same spot
    encodeSwing(4, ctx(130000)),                                 // next shot 90 s later
    encodeSwing(5, ctx(134000, { lat: -27.391, lon: 152.94 })),  // 4 s later but 110 m away: kept
  ];
  const rows = bytes.map((b) => ({ ...decodeRecord(b), bytes: b, logId: 1 }));
  const [s] = sessions(rows);
  assert.equal(s.soundGate, 1000);
  assert.equal(s.notShot.size, 1);
  assert.ok(s.notShot.get(2) === 'same spot' || s.notShot.get(3) === 'same spot');
  // Range mode: no same-spot marking.
  bytes[0] = encodeSession(1, true, ctx(0), 250, 0);
  const [r] = sessions(bytes.map((b) => ({ ...decodeRecord(b), bytes: b, logId: 1 })));
  assert.equal(r.notShot.size, 0);
  const out = exportJson(rows);
  assert.equal(out.logs[0].sessions[0].swings.filter((w) => w.not_shot).length, 1);
});

test('capture packet and the new control ops', () => {
  const c = { enabled: true, session: true, full: false, syncing: true, flashOk: true, trigger: 150, logId: 0xdeadbeef,
    nextSeq: 42, swings: 30, labels: 10, usedKb: 210, totalKb: 2048, imuOverruns: 0 };
  assert.deepEqual(decodeCapture(encodeCapture(c)), { version: 1, ...c, soundGate: null, gatedOut: 0 });   // 20-byte (0.2.x) packet
  const c3 = { ...c, soundGate: 1000, gatedOut: 7 };
  assert.equal(encodeCapture(c3).byteLength, 24);
  assert.deepEqual(decodeCapture(encodeCapture(c3)), { version: 1, ...c3 });
  assert.deepEqual([...encodeControl(OP.setSoundGate, 1000)], [0x21, 0xe8, 0x03]);
  // Hand-built as the firmware's CapturePacket (link.h).
  const b = new Uint8Array([1, 0b10011, 150, 0, 0xef, 0xbe, 0xad, 0xde, 42, 0, 30, 0, 10, 0, 210, 0, 0, 8, 3, 0]);
  const d = decodeCapture(new DataView(b.buffer));
  assert.equal(d.logId, 0xdeadbeef); assert.equal(d.session, true); assert.equal(d.full, false); assert.equal(d.flashOk, true);
  assert.equal(d.totalKb, 2048); assert.equal(d.imuOverruns, 3);
  assert.deepEqual([...encodeControl(OP.syncFrom, 0x0102)], [0x10, 2, 1]);
  assert.deepEqual([...encodeControl(OP.eraseLog, 0xdeadbeef)], [0x11, 0xef, 0xbe, 0xad, 0xde]);
  assert.deepEqual([...encodeControl(OP.setTrigger, 180)], [0x20, 180, 0]);
  assert.deepEqual([...encodeControl(OP.setCapture, true)], [0x05, 1]);
  assert.deepEqual([...encodeControl(OP.stopSync)], [0x12]);
});

test('pretend tracker: capture a round, sync it, clear it', async () => {
  await tracker.connect('fake', { tick: 10 });
  assert.equal(tracker.hasCapture, true);
  await tracker.send(OP.setSoundGate, 1000);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(tracker.capture.soundGate, 1000);
  await tracker.send(OP.setSoundGate, 0);
  await tracker.send(OP.startRound);
  await new Promise((r) => setTimeout(r, 400));     // ~40 ticks: 3 swings, 2-3 labels
  await tracker.send(OP.endRound);
  await new Promise((r) => setTimeout(r, 30));
  const c = tracker.capture;
  assert.ok(c.swings >= 2, `${c.swings} swings`);
  const got = [];
  const res = await tracker.syncLog(0, async (b) => { got.push(decodeRecord(b)); });
  assert.equal(res.records, c.nextSeq);
  assert.ok(got.every((r) => r.crcOk));
  assert.equal(got[0].kind, KIND.logStart);
  assert.equal(got.filter((r) => r.kind === KIND.swing).length, c.swings);
  // From the middle: only newer records.
  const later = [];
  await tracker.syncLog(3, async (b) => { later.push(decodeRecord(b).seq); });
  assert.equal(later[0], 3);
  const oldId = c.logId;
  await tracker.send(OP.eraseLog, oldId + 1);          // wrong id: ignored
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(tracker.capture.logId, oldId);
  await tracker.send(OP.eraseLog, oldId);
  await new Promise((r) => setTimeout(r, 30));
  assert.notEqual(tracker.capture.logId, oldId);
  assert.equal(tracker.capture.swings, 0);
  await tracker.disconnect();
});
