// The only module that talks to the tracker. Everything else uses `tracker`
// (below) and never touches navigator.bluetooth, so a native shell can swap in
// its own transport later (docs/plan-addition-native-app.md).
//
// Protocol: docs/ble-protocol.md.

export const UUID = {
  service: '7a1e0001-3c5b-4f0e-9a52-6b8d2f4c1e90',
  status: '7a1e0002-3c5b-4f0e-9a52-6b8d2f4c1e90',
  control: '7a1e0003-3c5b-4f0e-9a52-6b8d2f4c1e90',
  data: '7a1e0004-3c5b-4f0e-9a52-6b8d2f4c1e90',
  ack: '7a1e0005-3c5b-4f0e-9a52-6b8d2f4c1e90',
  live: '7a1e0006-3c5b-4f0e-9a52-6b8d2f4c1e90',
};

export const OP = { startRound: 0x01, endRound: 0x02, setTime: 0x03, identify: 0x04 };

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

export function encodeControl(op, arg) {
  if (op === OP.setTime) {
    const b = new DataView(new ArrayBuffer(5));
    b.setUint8(0, op); b.setUint32(1, arg >>> 0, true);
    return new Uint8Array(b.buffer);
  }
  return new Uint8Array([op]);
}

// ---------- transports ----------
// Same shape for every transport:
//   connect() -> { name }, disconnect(), control(bytes),
//   onStatus(DataView), onLive(DataView), onDisconnect()  (set by `tracker`)

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
    for (const k of ['status', 'live']) {
      const c = this.chr[k];
      c.addEventListener('characteristicvaluechanged', (e) => (k === 'status' ? this.onStatus : this.onLive)?.(e.target.value));
      await c.startNotifications();
      try { (k === 'status' ? this.onStatus : this.onLive)?.(await c.readValue()); } catch { /* notify will follow */ }
    }
    return { name: this.device.name || 'Golf Tracker' };
  }

  async disconnect() { try { this.device?.gatt?.disconnect(); } catch { /* already */ } }
  async control(bytes) { await this.chr.control.writeValueWithResponse(bytes); }
}

// A pretend tracker for trying the app without hardware.
export class FakeTransport {
  static available() { return true; }
  constructor({ near = { lat: -27.4398, lon: 152.9785 }, tick = 1000 } = {}) {
    this.near = near; this.tick = tick; this.timer = null;
  }

  async connect() {
    const t0 = Date.now();
    this.s = { battery: 87, batteryMv: 4045, charging: false, roundActive: false, gpsData: true, gpsFix: false,
      imuOk: true, micOk: true, timeOk: false, buttonDown: false, sats: 0, hdop: null, buttonPresses: 0,
      records: 0, firmware: '0.1.0', micLevel: 0, gyroPeak: 0, busyPins: [] };
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
      if (Math.floor(t) % 15 === 7) s.buttonPresses = (s.buttonPresses + 1) & 0xff;
      this.onStatus?.(encodeStatus(s));
      const wobble = (n) => (Math.random() - 0.5) * n;
      this.onLive?.(encodeLive({
        time: s.timeOk ? new Date() : null,
        pos: s.gpsFix ? { lat: this.near.lat + wobble(4e-5), lon: this.near.lon + wobble(4e-5) } : null,
        altitude: 42 + wobble(2), speed: Math.abs(wobble(0.4)),
      }));
    }, this.tick);
    return { name: 'Pretend tracker' };
  }

  async disconnect() { clearInterval(this.timer); this.timer = null; this.onDisconnect?.(); }

  async control(bytes) {
    const op = bytes[0];
    if (op === OP.startRound) this.s.roundActive = true;
    else if (op === OP.endRound) this.s.roundActive = false;
    else if (op === OP.setTime) this.time = new DataView(bytes.buffer).getUint32(1, true);
  }
}

// ---------- the connection the app shares ----------
// One connection for the whole app, so it survives moving between screens.
export const tracker = {
  transport: null, kind: null, name: null, state: 'idle', // idle | connecting | connected | lost
  status: null, live: null, error: null, lastSeen: null,
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
    t.onDisconnect = () => { if (this.state !== 'idle') { this.state = 'lost'; this.emit(); } };
    this.state = 'connecting'; this.error = null; this.emit();
    try {
      ({ name: this.name } = await t.connect());
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
    await t?.disconnect();
    this.emit();
  },

  async send(op, arg) {
    if (!this.transport || this.state !== 'connected') throw new Error('Tracker not connected');
    await this.transport.control(encodeControl(op, arg));
  },
};
