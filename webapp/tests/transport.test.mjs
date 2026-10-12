import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeStatus, encodeStatus, decodeLive, encodeLive, encodeControl, OP, FakeTransport, tracker } from '../js/transport.js';

test('status round-trips through the 20-byte packet', () => {
  const s = { proto: 1, battery: 64, batteryMv: 3876, charging: true, roundActive: false, gpsData: true, gpsFix: true,
    imuOk: true, micOk: false, timeOk: true, buttonDown: false, fixQuality: 1, sats: 9, buttonPresses: 3, hdop: 1.23,
    records: 0, firmware: '0.1.0', micLevel: 200, gyroPeak: 1450, busyPins: [1, 9] };
  const dv = encodeStatus(s);
  assert.equal(dv.byteLength, 20);
  assert.deepEqual(decodeStatus(dv), s);
});

test('status bytes match the firmware layout', () => {
  // Hand-built packet as the firmware sends it (StatusPacket in link.h).
  const b = new Uint8Array([1, 80, 0xa0, 0x0f, 0b00101101, 1, 7, 2, 150, 0, 0, 0, 0, 1, 0, 10, 0xe8, 0x03, 0x08, 0x00]);
  const s = decodeStatus(new DataView(b.buffer));
  assert.equal(s.batteryMv, 4000);
  assert.equal(s.charging, true); assert.equal(s.roundActive, false); assert.equal(s.gpsData, true);
  assert.equal(s.gpsFix, true); assert.equal(s.imuOk, false); assert.equal(s.micOk, true);
  assert.equal(s.sats, 7); assert.equal(s.hdop, 1.5); assert.equal(s.firmware, '0.1.0');
  assert.equal(s.gyroPeak, 1000); assert.deepEqual(s.busyPins, [3]);
  b[8] = 0xff; b[9] = 0xff;
  assert.equal(decodeStatus(new DataView(b.buffer)).hdop, null);
});

test('live position and control packets', () => {
  const l = decodeLive(encodeLive({ time: new Date(1760000000000), pos: { lat: -27.4398123, lon: 152.9785456 }, altitude: 41.5, speed: 1.25 }));
  assert.equal(l.time.getTime(), 1760000000000);
  assert.ok(Math.abs(l.pos.lat + 27.4398123) < 1e-7 && Math.abs(l.pos.lon - 152.9785456) < 1e-7);
  assert.equal(l.altitude, 41.5); assert.equal(l.speed, 1.25);
  assert.equal(decodeLive(new DataView(new ArrayBuffer(16))).pos, null);
  assert.deepEqual([...encodeControl(OP.setTime, 0x01020304)], [3, 4, 3, 2, 1]);
  assert.deepEqual([...encodeControl(OP.identify)], [4]);
});

test('pretend tracker drives the shared connection', async () => {
  const seen = [];
  const off = tracker.on((t) => seen.push(t.state));
  await tracker.connect('fake', { tick: 20 });
  assert.equal(tracker.state, 'connected');
  await new Promise((r) => setTimeout(r, 70));
  assert.ok(tracker.status && tracker.status.battery > 0);
  await tracker.send(OP.startRound);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(tracker.status.roundActive, true);
  await tracker.disconnect();
  assert.equal(tracker.state, 'idle');
  off();
  assert.ok(seen.includes('connecting'));
});
