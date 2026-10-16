// The only module that talks to the tracker. Everything else uses `tracker`
// (below) and never touches navigator.bluetooth, so a native shell can swap in
// its own transport later (docs/plan-addition-native-app.md).
//
// Protocol: docs/ble-protocol.md.
import { Reassembler, chunkRecord, encodeLogStart, encodeSession, encodeLabel, encodeSwing } from './capturelog.js';

export const UUID = {
  service: '7a1e0001-3c5b-4f0e-9a52-6b8d2f4c1e90',
  status: '7a1e0002-3c5b-4f0e-9a52-6b8d2f4c1e90',
  control: '7a1e0003-3c5b-4f0e-9a52-6b8d2f4c1e90',
  data: '7a1e0004-3c5b-4f0e-9a52-6b8d2f4c1e90',
  ack: '7a1e0005-3c5b-4f0e-9a52-6b8d2f4c1e90',
  live: '7a1e0006-3c5b-4f0e-9a52-6b8d2f4c1e90',
  capture: '7a1e0007-3c5b-4f0e-9a52-6b8d2f4c1e90',
};

export const OP = {
  startRound: 0x01, endRound: 0x02, setTime: 0x03, identify: 0x04, setCapture: 0x05,
  syncFrom: 0x10, eraseLog: 0x11, stopSync: 0x12, setTrigger: 0x20, setSoundGate: 0x21,
};

const FLAG = { charging: 0, round: 1, gpsData: 2, gpsFix: 3, imu: 4, mic: 5, time: 6, buttonDown: 7 };

// ---------- packets ----------
// Status, 20 bytes little-endian.
export function decodeStatus(dv) {
  if (dv.byteLength < 20) throw new Error(`Status is ${dv.byteLength} bytes, expected 20`);
  const flags = dv.getUint8(4);
  const bit = (n) => !!(flags & (1 << n));
  const hdop = dv.getUint16(8, true);
  const busy = dv.getUint16(18, true);
  return {
    proto: dv.getUint8(0),
    battery: dv.getUint8(1),
    batteryMv: dv.getUint16(2, true),
    charging: bit(FLAG.charging),
    roundActive: bit(FLAG.round),
    gpsData: bit(FLAG.gpsData),
    gpsFix: bit(FLAG.gpsFix),
    imuOk: bit(FLAG.imu),
    micOk: bit(FLAG.mic),
    timeOk: bit(FLAG.time),
    buttonDown: bit(FLAG.buttonDown),
    fixQuality: dv.getUint8(5),
    sats: dv.getUint8(6),
    buttonPresses: dv.getUint8(7),
    hdop: hdop === 0xffff ? null : hdop / 100,
    records: dv.getUint16(10, true),
    firmware: `${dv.getUint8(12)}.${dv.getUint8(13)}.${dv.getUint8(14)}`,
    micLevel: dv.getUint8(15),
    gyroPeak: dv.getUint16(16, true),
    busyPins: Array.from({ length: 16 }, (_, i) => i).filter((i) => busy & (1 << i)),
  };
}

export function encodeStatus(s) {
  const dv = new DataView(new ArrayBuffer(20));
  const flags = [s.charging, s.roundActive, s.gpsData, s.gpsFix, s.imuOk, s.micOk, s.timeOk, s.buttonDown]
    .reduce((a, v, i) => a | (v ? 1 << i : 0), 0);
  const [ma, mi, pa] = (s.firmware ?? '0.0.0').split('.').map(Number);
  dv.setUint8(0, s.proto ?? 1); dv.setUint8(1, s.battery); dv.setUint16(2, s.batteryMv, true);
  dv.setUint8(4, flags); dv.setUint8(5, s.fixQuality ?? (s.gpsFix ? 1 : 0)); dv.setUint8(6, s.sats);
  dv.setUint8(7, s.buttonPresses & 0xff); dv.setUint16(8, s.hdop == null ? 0xffff : Math.round(s.hdop * 100), true);
  dv.setUint16(10, s.records ?? 0, true); dv.setUint8(12, ma); dv.setUint8(13, mi); dv.setUint8(14, pa);
  dv.setUint8(15, s.micLevel); dv.setUint16(16, s.gyroPeak, true);
  dv.setUint16(18, (s.busyPins ?? []).reduce((a, p) => a | (1 << p), 0), true);
  return dv;
}

// Live position, 16 bytes little-endian.
export function decodeLive(dv) {
  if (dv.byteLength < 16) throw new Error(`Live is ${dv.byteLength} bytes, expected 16`);
  const unix = dv.getUint32(0, true);
  const lat = dv.getInt32(4, true) / 1e7, lon = dv.getInt32(8, true) / 1e7;
  return {
    time: unix ? new Date(unix * 1000) : null,
    pos: lat || lon ? { lat, lon } : null,
    altitude: dv.getInt16(12, true) / 10,
    speed: dv.getUint16(14, true) / 100,
  };
}

export function encodeLive(l) {
  const dv = new DataView(new ArrayBuffer(16));
  dv.setUint32(0, l.time ? Math.floor(l.time.getTime() / 1000) : 0, true);
  dv.setInt32(4, l.pos ? Math.round(l.pos.lat * 1e7) : 0, true);
  dv.setInt32(8, l.pos ? Math.round(l.pos.lon * 1e7) : 0, true);
  dv.setInt16(12, Math.round((l.altitude ?? 0) * 10), true);
  dv.setUint16(14, Math.round((l.speed ?? 0) * 100), true);
  return dv;
}

// Capture, 20 bytes little-endian (Phase 3).
export function decodeCapture(dv) {
  if (dv.byteLength < 20) throw new Error(`Capture is ${dv.byteLength} bytes, expected 20`);
  const f = dv.getUint8(1);
  return {
    version: dv.getUint8(0),
    enabled: !!(f & 1), session: !!(f & 2), full: !!(f & 4), syncing: !!(f & 8), flashOk: !!(f & 16),
    trigger: dv.getUint16(2, true),
    logId: dv.getUint32(4, true),
    nextSeq: dv.getUint16(8, true),
    swings: dv.getUint16(10, true),
    labels: dv.getUint16(12, true),
    usedKb: dv.getUint16(14, true),
    totalKb: dv.getUint16(16, true),
    imuOverruns: dv.getUint16(18, true),
    // Firmware 0.3.0+: round mode's impact-sound gate (null = not supported).
    soundGate: dv.byteLength >= 24 ? dv.getUint16(20, true) : null,
    gatedOut: dv.byteLength >= 24 ? dv.getUint16(22, true) : 0,
  };
}

export function encodeCapture(c) {
  const dv = new DataView(new ArrayBuffer(c.soundGate == null ? 20 : 24));
  dv.setUint8(0, 1);
  dv.setUint8(1, (c.enabled ? 1 : 0) | (c.session ? 2 : 0) | (c.full ? 4 : 0) | (c.syncing ? 8 : 0) | (c.flashOk ? 16 : 0));
  dv.setUint16(2, c.trigger, true); dv.setUint32(4, c.logId >>> 0, true); dv.setUint16(8, c.nextSeq, true);
  dv.setUint16(10, c.swings, true); dv.setUint16(12, c.labels, true); dv.setUint16(14, c.usedKb, true);
  dv.setUint16(16, c.totalKb, true); dv.setUint16(18, c.imuOverruns ?? 0, true);
  if (c.soundGate != null) { dv.setUint16(20, c.soundGate, true); dv.setUint16(22, c.gatedOut ?? 0, true); }
  return dv;
}

// Control: op byte, then the op's argument.
const ARG_BYTES = { [OP.setTime]: 4, [OP.eraseLog]: 4, [OP.syncFrom]: 2, [OP.setTrigger]: 2, [OP.setSoundGate]: 2, [OP.setCapture]: 1 };
export function encodeControl(op, arg) {
  const n = ARG_BYTES[op] ?? 0;
  const dv = new DataView(new ArrayBuffer(1 + n));
  dv.setUint8(0, op);
  if (n === 4) dv.setUint32(1, arg >>> 0, true);
  else if (n === 2) dv.setUint16(1, arg & 0xffff, true);
  else if (n === 1) dv.setUint8(1, arg ? 1 : 0);
  return new Uint8Array(dv.buffer);
}

// ---------- transports ----------
// Same shape for every transport:
//   connect() -> { name, capture }, disconnect(), control(bytes), ack(seq),
//   onStatus(DataView), onLive(DataView), onCapture(DataView), onData(DataView),
//   onDisconnect()  (set by `tracker`). `capture` is false for Phase 2 firmware.

export class WebBluetoothTransport {
  static available() { return typeof navigator !== 'undefined' && !!navigator.bluetooth; }
  constructor() { this.device = null; this.chr = {}; }

  async connect({ reuse = true } = {}) {
    if (!this.device || !reuse) {
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [UUID.service] }],
        optionalServices: [UUID.service],
      });
      this.device.addEventListener('gattserverdisconnected', () => this.onDisconnect?.());
    }
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(UUID.service);
    for (const k of ['status', 'live', 'control']) this.chr[k] = await svc.getCharacteristic(UUID[k]);
    // Phase 3 firmware adds Capture, Data and Ack; older firmware doesn't have them.
    let capture = true;
    for (const k of ['capture', 'data', 'ack']) {
      try { this.chr[k] = await svc.getCharacteristic(UUID[k]); } catch { capture = false; }
    }
    const handler = { status: () => this.onStatus, live: () => this.onLive, capture: () => this.onCapture, data: () => this.onData };
    for (const k of capture ? ['status', 'live', 'capture', 'data'] : ['status', 'live']) {
      const c = this.chr[k];
      c.addEventListener('characteristicvaluechanged', (e) => handler[k]()?.(e.target.value));
      await c.startNotifications();
      if (k !== 'data') { try { handler[k]()?.(await c.readValue()); } catch { /* notify will follow */ } }
    }
    return { name: this.device.name || 'Golf Tracker', capture };
  }

  async disconnect() { try { this.device?.gatt?.disconnect(); } catch { /* already */ } }
  async control(bytes) { await this.chr.control.writeValueWithResponse(bytes); }
  async ack(seq) {
    if (!this.chr.ack) return;
    const b = new Uint8Array([seq & 0xff, (seq >> 8) & 0xff]);
    await this.chr.ack.writeValueWithoutResponse(b).catch(() => {});
  }
}

// A pretend tracker for trying the app without hardware. It keeps a capture
// log like the real one: a swing every 12 s during a round, a label for each
// pretend button press.
export class FakeTransport {
  static available() { return true; }
  constructor({ near = { lat: -27.4398, lon: 152.9785 }, tick = 1000 } = {}) {
    this.near = near; this.tick = tick; this.timer = null;
    this.log = []; this.logId = 0; this.capture = null;
  }

  newLog() {
    this.logId = (Math.random() * 0xffffffff) >>> 0 || 1;
    this.log = [encodeLogStart(0, this.logId, Math.floor(Date.now() / 1000))];
  }

  ctx() {
    const s = this.s;
    return { time: Math.floor(Date.now() / 1000), deviceMs: Date.now() - this.t0,
      pos: s.gpsFix ? { lat: this.near.lat, lon: this.near.lon } : null, hdop: s.hdop, sats: s.sats };
  }

  append(make) {
    if (this.capture.usedKb >= this.capture.totalKb - 8) { this.capture.full = true; return null; }
    const seq = this.log.length;
    const rec = make(seq);
    this.log.push(rec);
    this.capture.usedKb = Math.ceil(this.log.reduce((n, r) => n + r.length, 0) / 1024);
    return seq;
  }

  async connect() {
    const t0 = Date.now();
    this.t0 = t0;
    this.s = { battery: 87, batteryMv: 4045, charging: false, roundActive: false, gpsData: true, gpsFix: false,
      imuOk: true, micOk: true, timeOk: false, buttonDown: false, sats: 0, hdop: null, buttonPresses: 0,
      records: 0, firmware: '0.2.0', micLevel: 0, gyroPeak: 0, busyPins: [] };
    if (!this.log.length) this.newLog();
    this.capture = { enabled: true, session: false, full: false, syncing: false, flashOk: true, trigger: 150,
      logId: this.logId, nextSeq: this.log.length, swings: this.log.filter((r) => r[0] === 4).length,
      labels: this.log.filter((r) => r[0] === 5).length, usedKb: 1, totalKb: 2048, imuOverruns: 0,
      soundGate: 0, gatedOut: 0 };
    this.lastSwingSeq = null; this.lastSwingAt = 0;
    this.time = null;
    this.timer = setInterval(() => {
      const t = (Date.now() - t0) / 1000;
      const s = this.s;
      s.sats = Math.min(12, Math.floor(t / 1.5));
      s.gpsFix = s.sats >= 4;
      s.fixQuality = s.gpsFix ? 1 : 0;
      s.hdop = s.gpsFix ? Math.max(0.8, 3 - t / 20) : null;
      s.timeOk = t > 3 || !!this.time;
      s.batteryMv = Math.round(4045 - t / 10);
      s.battery = Math.max(0, Math.round(87 - t / 60));
      const swing = Math.floor(t) % 12 === 0;
      s.gyroPeak = swing ? 900 + Math.round(Math.random() * 400) : Math.round(Math.random() * 25);
      s.micLevel = swing ? 180 + Math.round(Math.random() * 60) : Math.round(Math.random() * 12);
      const c = this.capture;
      if (swing && s.roundActive && c.enabled && s.gyroPeak >= c.trigger) {
        const loud = Math.random() > 0.3;   // some practice swings: no impact
        if (!loud && c.soundGate) { c.gatedOut++; }
        else {
        const seq = this.append((q) => encodeSwing(q, this.ctx(), { peak: s.gyroPeak, trigger: c.trigger, loud }));
        if (seq != null) { this.lastSwingSeq = seq; this.lastSwingAt = Date.now(); c.swings++; s.records = c.swings; this.loud = loud; }
        }
      }
      if (Math.floor(t) % 15 === 7) {
        s.buttonPresses = (s.buttonPresses + 1) & 0xff;
        if (s.roundActive && c.enabled) {
          const ref = this.lastSwingSeq != null && Date.now() - this.lastSwingAt < 20000 ? this.lastSwingSeq : null;
          if (this.append((q) => encodeLabel(q, this.ctx(), ref, ref == null ? null : Date.now() - this.lastSwingAt)) != null) c.labels++;
        }
      }
      c.session = s.roundActive; c.nextSeq = this.log.length; c.logId = this.logId;
      this.onStatus?.(encodeStatus(s));
      this.onCapture?.(encodeCapture(c));
      const wobble = (n) => (Math.random() - 0.5) * n;
      this.onLive?.(encodeLive({
        time: s.timeOk ? new Date() : null,
        pos: s.gpsFix ? { lat: this.near.lat + wobble(4e-5), lon: this.near.lon + wobble(4e-5) } : null,
        altitude: 42 + wobble(2), speed: Math.abs(wobble(0.4)),
      }));
    }, this.tick);
    return { name: 'Pretend tracker', capture: true };
  }

  async disconnect() { clearInterval(this.timer); this.timer = null; clearTimeout(this.syncTimer); this.onDisconnect?.(); }

  setRound(on) {
    if (on === this.s.roundActive) return;
    this.s.roundActive = on;
    if (this.capture.enabled) this.append((q) => encodeSession(q, on, this.ctx(), this.capture.trigger, this.capture.soundGate ?? 0));
  }

  async control(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const op = bytes[0];
    if (op === OP.startRound) this.setRound(true);
    else if (op === OP.endRound) this.setRound(false);
    else if (op === OP.setTime) this.time = dv.getUint32(1, true);
    else if (op === OP.setCapture) this.capture.enabled = !!bytes[1];
    else if (op === OP.setTrigger) this.capture.trigger = dv.getUint16(1, true);
    else if (op === OP.setSoundGate) this.capture.soundGate = dv.getUint16(1, true);
    else if (op === OP.eraseLog) {
      if (dv.getUint32(1, true) === this.logId) {
        const was = this.s.roundActive;
        this.newLog();
        Object.assign(this.capture, { swings: 0, labels: 0, usedKb: 1, full: false, logId: this.logId, nextSeq: 1 });
        if (was) { this.s.roundActive = false; this.setRound(true); }
      }
    } else if (op === OP.stopSync) { clearTimeout(this.syncTimer); this.capture.syncing = false; }
    else if (op === OP.syncFrom) {
      const from = dv.getUint16(1, true);
      const chunks = [];
      for (const r of this.log) {
        const seq = r[4] | (r[5] << 8);
        if (seq >= from) chunks.push(...chunkRecord(r, seq, 182));
      }
      chunks.push(new DataView(new Uint8Array([0xff]).buffer));
      this.capture.syncing = true;
      let i = 0;
      const pump = () => {
        for (let k = 0; k < 40 && i < chunks.length; k++) this.onData?.(chunks[i++]);
        if (i < chunks.length) this.syncTimer = setTimeout(pump, 5);
        else this.capture.syncing = false;
      };
      this.syncTimer = setTimeout(pump, 5);
    }
  }

  async ack() { /* nothing to do */ }
}

// ---------- the connection the app shares ----------
// One connection for the whole app, so it survives moving between screens.
export const tracker = {
  transport: null, kind: null, name: null, state: 'idle', // idle | connecting | connected | lost
  status: null, live: null, capture: null, hasCapture: false, error: null, lastSeen: null,
  sync: null,     // { got, records, errors } while syncing the capture log
  listeners: new Set(),

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  emit() { for (const fn of this.listeners) { try { fn(this); } catch (e) { console.error(e); } } },

  bluetoothAvailable() { return WebBluetoothTransport.available(); },

  async connect(kind = 'ble', opts = {}) {
    if (this.state === 'connecting') return;
    if (this.transport && this.kind !== kind) await this.disconnect();
    if (!this.transport) {
      const T = kind === 'fake' ? FakeTransport : WebBluetoothTransport;
      if (!T.available()) throw new Error('This browser has no Bluetooth. On iPhone, open the app in Bluefy.');
      this.transport = new T(opts);
      this.kind = kind;
    }
    const t = this.transport;
    t.onStatus = (dv) => { try { this.status = decodeStatus(dv); this.lastSeen = Date.now(); this.emit(); } catch (e) { console.warn(e); } };
    t.onLive = (dv) => { try { this.live = decodeLive(dv); this.emit(); } catch (e) { console.warn(e); } };
    t.onCapture = (dv) => { try { this.capture = decodeCapture(dv); this.emit(); } catch (e) { console.warn(e); } };
    t.onData = (dv) => { this.dataSink?.(dv); };
    t.onDisconnect = () => { this.lostSink?.(); if (this.state !== 'idle') { this.state = 'lost'; this.emit(); } };
    this.state = 'connecting'; this.error = null; this.emit();
    try {
      const info = await t.connect();
      this.name = info.name;
      this.hasCapture = !!info.capture;
      this.state = 'connected';
      await this.send(OP.setTime, Math.floor(Date.now() / 1000)).catch(() => {});
    } catch (e) {
      this.state = this.status ? 'lost' : 'idle';
      // The picker was closed: not an error worth showing.
      this.error = e?.name === 'NotFoundError' ? null : (e?.message || String(e));
      if (!this.status) { this.transport = null; this.kind = null; }
    }
    this.emit();
  },

  async disconnect() {
    const t = this.transport;
    this.state = 'idle'; this.transport = null; this.kind = null; this.status = null; this.live = null; this.name = null;
    this.capture = null; this.hasCapture = false; this.sync = null; this.dataSink = null;
    await t?.disconnect();
    this.emit();
  },

  async send(op, arg) {
    if (!this.transport || this.state !== 'connected') throw new Error('Tracker not connected');
    await this.transport.control(encodeControl(op, arg));
  },

  // Pulls the capture log from `fromSeq`. `onRecord(bytes)` is awaited for each
  // whole record (store it there). Resolves with counts when the tracker sends
  // its end marker; rejects if the data stops for `idleMs`.
  async syncLog(fromSeq, onRecord, { idleMs = 8000 } = {}) {
    if (!this.hasCapture) throw new Error('This tracker firmware has no capture log. Update it to 0.2.0 or later.');
    if (this.sync) throw new Error('Already syncing');
    const state = { got: 0, records: 0, errors: 0, lastSeq: null };
    this.sync = state; this.emit();
    let queue = Promise.resolve();
    try {
      await new Promise((resolve, reject) => {
        let timer = null;
        const idle = () => { clearTimeout(timer); timer = setTimeout(() => reject(new Error('The tracker stopped sending. Sync again to carry on from here.')), idleMs); };
        const re = new Reassembler((bytes) => {
          queue = queue.then(async () => {
            await onRecord(bytes);
            state.records++;
            state.lastSeq = bytes[4] | (bytes[5] << 8);
            if (state.records % 10 === 0) await this.transport?.ack?.(state.lastSeq);
            this.emit();
          });
        });
        this.dataSink = (dv) => {
          idle();
          state.got += dv.byteLength;
          const r = re.push(dv);
          if (r === 'bad') state.errors = re.errors;
          if (r === 'end') { clearTimeout(timer); queue.then(resolve, reject); }
        };
        this.lostSink = () => { clearTimeout(timer); reject(new Error('Connection lost. Sync again to carry on from here.')); };
        idle();
        this.send(OP.syncFrom, fromSeq).catch((e) => { clearTimeout(timer); reject(e); });
      });
      await queue;
      if (state.lastSeq != null) await this.transport?.ack?.(state.lastSeq);
      return state;
    } finally {
      await queue.catch(() => {});
      this.dataSink = null; this.lostSink = null; this.sync = null; this.emit();
    }
  },
};
