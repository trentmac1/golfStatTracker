// The tracker's capture log (Phase 3 training data): record format, chunk
// reassembly for sync, grouping into sessions, and the JSON export.
// Format: docs/ble-protocol.md, "Capture log" and "Sync".

export const KIND = { logStart: 1, sessionStart: 2, sessionEnd: 3, swing: 4, label: 5, pad: 0xfe };
export const KIND_NAME = { 1: 'log-start', 2: 'session-start', 3: 'session-end', 4: 'swing', 5: 'label' };
export const GYRO_DPS_PER_LSB = 0.07;
export const ACC_G_PER_LSB = 0.000488;
const HEADER = 8, CTX = 20;

export function crc16(bytes, start = 0, end = bytes.length, crc = 0xffff) {
  for (let i = start; i < end; i++) {
    crc ^= bytes[i] << 8;
    for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function context(dv, o) {
  const fix = !!(dv.getUint8(o + 19) & 1);
  const lat = dv.getInt32(o + 8, true) / 1e7, lon = dv.getInt32(o + 12, true) / 1e7;
  const hdop = dv.getUint16(o + 16, true);
  const flags = dv.getUint8(o + 19);
  return {
    time: dv.getUint32(o, true) || null,          // Unix seconds
    deviceMs: dv.getUint32(o + 4, true),
    pos: fix && (lat || lon) ? { lat, lon } : null,
    hdop: hdop === 0xffff ? null : hdop / 100,
    sats: dv.getUint8(o + 18),
    gpsTime: !!(flags & 2),
    lowBattery: !!(flags & 4),
  };
}

// One record (Uint8Array, header included) -> object. `full` also decodes the
// swing's IMU and envelope arrays.
export function decodeRecord(bytes, { full = false } = {}) {
  if (bytes.length < HEADER) throw new Error('Record too short');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kind = dv.getUint8(0), len = dv.getUint16(2, true), seq = dv.getUint16(4, true);
  if (len !== bytes.length) throw new Error(`Record ${seq} is ${bytes.length} bytes, header says ${len}`);
  const r = { kind, type: KIND_NAME[kind] ?? `kind-${kind}`, version: dv.getUint8(1), seq, len,
    crcOk: crc16(bytes, HEADER) === dv.getUint16(6, true) };
  if (!r.crcOk) return r;
  const b = HEADER;
  if (kind === KIND.logStart) {
    r.logId = dv.getUint32(b, true);
    r.created = dv.getUint32(b + 4, true) || null;
    r.firmware = `${dv.getUint8(b + 8)}.${dv.getUint8(b + 9)}.${dv.getUint8(b + 10)}`;
    r.protocol = dv.getUint8(b + 11);
    return r;
  }
  Object.assign(r, context(dv, b));
  const x = b + CTX;
  if (kind === KIND.sessionStart || kind === KIND.sessionEnd) {
    r.trigger = dv.getUint16(x, true);
  } else if (kind === KIND.label) {
    const ref = dv.getUint16(x, true), gap = dv.getUint16(x + 2, true);
    r.refSeq = ref === 0xffff ? null : ref;
    r.gapMs = gap === 0xffff ? null : gap;
  } else if (kind === KIND.swing) {
    r.peakGyro = dv.getUint16(x, true);
    r.trigger = dv.getUint16(x + 2, true);
    r.imuCount = dv.getUint16(x + 4, true);
    r.imuPeakIndex = dv.getUint16(x + 6, true);
    r.imuRateHz = dv.getUint16(x + 8, true) / 100;
    r.envCount = dv.getUint16(x + 10, true);
    r.envStartMs = dv.getInt16(x + 12, true);
    r.envRateHz = dv.getUint16(x + 14, true) / 10;
    const f = dv.getUint8(x + 16);
    r.flags = { imuOverrun: !!(f & 1), audioMissing: !!(f & 2), imuMissing: !!(f & 4) };
    r.audioPeak = dv.getUint16(x + 18, true);
    const imuAt = x + 20, envAt = imuAt + r.imuCount * 12;
    if (envAt + r.envCount > bytes.length) { r.crcOk = false; r.error = 'Swing record is cut short'; return r; }
    if (full) {
      r.imu = [];
      for (let i = 0; i < r.imuCount; i++) {
        const row = [];
        for (let k = 0; k < 6; k++) row.push(dv.getInt16(imuAt + i * 12 + k * 2, true));
        r.imu.push(row);
      }
      r.env = Array.from(bytes.subarray(envAt, envAt + r.envCount));
    }
  }
  return r;
}

// Gyro magnitude (deg/s) and envelope (0–65535) for drawing a swing.
export function swingTraces(bytes) {
  const r = decodeRecord(bytes, { full: true });
  if (!r.imu) return null;
  const gyro = r.imu.map(([x, y, z]) => Math.hypot(x, y, z) * GYRO_DPS_PER_LSB);
  const env = r.env.map((v) => v * v);
  return { gyro, env, record: r };
}

// Impact timing for a quick look on the phone: the loudest envelope moment
// relative to the peak rotation. The real detector comes from Phase 4.
export function impactOffsetMs(bytes) {
  const t = swingTraces(bytes);
  if (!t || !t.env.length) return null;
  let best = 0;
  for (let i = 1; i < t.env.length; i++) if (t.env[i] > t.env[best]) best = i;
  if (t.env[best] < 400) return null;     // nothing much heard
  return Math.round(t.record.envStartMs + (best * 1000) / t.record.envRateHz);
}

// Rebuilds records from Data notifications: [seq u16][offset u16][bytes].
// A single 0xFF byte ends the sync.
export class Reassembler {
  constructor(onRecord) { this.onRecord = onRecord; this.cur = null; this.done = false; this.errors = 0; }

  push(dv) {
    if (dv.byteLength === 1 && dv.getUint8(0) === 0xff) { this.done = true; this.cur = null; return 'end'; }
    if (dv.byteLength < 5) { this.errors++; return 'bad'; }
    const seq = dv.getUint16(0, true), off = dv.getUint16(2, true);
    const data = new Uint8Array(dv.buffer, dv.byteOffset + 4, dv.byteLength - 4);
    if (off === 0) {
      if (data.length < HEADER) { this.errors++; return 'bad'; }
      const len = data[2] | (data[3] << 8);
      if (len < HEADER) { this.errors++; return 'bad'; }
      this.cur = { seq, len, bytes: new Uint8Array(len), got: 0 };
    } else if (!this.cur || this.cur.seq !== seq || this.cur.got !== off) {
      this.errors++; this.cur = null; return 'bad';     // lost a chunk: this record comes again next sync
    }
    const c = this.cur;
    const n = Math.min(data.length, c.len - off);
    c.bytes.set(data.subarray(0, n), off);
    c.got = off + n;
    if (c.got >= c.len) { this.cur = null; this.onRecord(c.bytes); return 'record'; }
    return 'chunk';
  }
}

// Splits a record into Data notifications (used by the pretend tracker and tests).
export function chunkRecord(bytes, seq, payload = 182) {
  const per = (payload - 4) & ~3;
  const out = [];
  for (let off = 0; off < bytes.length; off += per) {
    const n = Math.min(per, bytes.length - off);
    const dv = new DataView(new ArrayBuffer(4 + n));
    dv.setUint16(0, seq, true); dv.setUint16(2, off, true);
    new Uint8Array(dv.buffer, 4).set(bytes.subarray(off, off + n));
    out.push(dv);
  }
  return out;
}

// ---------- building records (pretend tracker, tests) ----------
function finish(kind, seq, body) {
  const len = (HEADER + body.length + 3) & ~3;
  const out = new Uint8Array(len).fill(0xff);
  out.set(body, HEADER);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, kind); dv.setUint8(1, 1); dv.setUint16(2, len, true); dv.setUint16(4, seq, true);
  dv.setUint16(6, crc16(out, HEADER), true);
  return out;
}

function ctxBytes(c) {
  const b = new Uint8Array(CTX), dv = new DataView(b.buffer);
  dv.setUint32(0, c.time ?? 0, true); dv.setUint32(4, c.deviceMs ?? 0, true);
  dv.setInt32(8, c.pos ? Math.round(c.pos.lat * 1e7) : 0, true);
  dv.setInt32(12, c.pos ? Math.round(c.pos.lon * 1e7) : 0, true);
  dv.setUint16(16, c.hdop == null ? 0xffff : Math.round(c.hdop * 100), true);
  dv.setUint8(18, c.sats ?? 0);
  dv.setUint8(19, (c.pos ? 1 : 0) | (c.time ? 2 : 0) | 8);
  return b;
}

export function encodeLogStart(seq, logId, created = 0) {
  const b = new Uint8Array(12), dv = new DataView(b.buffer);
  dv.setUint32(0, logId, true); dv.setUint32(4, created, true);
  b.set([0, 2, 0, 1], 8);
  return finish(KIND.logStart, seq, b);
}

export function encodeSession(seq, start, ctx, trigger = 150) {
  const b = new Uint8Array(CTX + 4);
  b.set(ctxBytes(ctx));
  new DataView(b.buffer).setUint16(CTX, trigger, true);
  return finish(start ? KIND.sessionStart : KIND.sessionEnd, seq, b);
}

export function encodeLabel(seq, ctx, refSeq = null, gapMs = null) {
  const b = new Uint8Array(CTX + 4), dv = new DataView(b.buffer);
  b.set(ctxBytes(ctx));
  dv.setUint16(CTX, refSeq ?? 0xffff, true); dv.setUint16(CTX + 2, gapMs ?? 0xffff, true);
  return finish(KIND.label, seq, b);
}

// A made-up swing: rotation peaking at sample 312, a click `impactMs` after it.
export function encodeSwing(seq, ctx, { peak = 900, trigger = 150, impactMs = 20, loud = true } = {}) {
  const count = 416, envCount = 2000;
  const b = new Uint8Array(CTX + 20 + count * 12 + envCount), dv = new DataView(b.buffer);
  b.set(ctxBytes(ctx));
  const x = CTX;
  dv.setUint16(x, peak, true); dv.setUint16(x + 2, trigger, true);
  dv.setUint16(x + 4, count, true); dv.setUint16(x + 6, 312, true);
  dv.setUint16(x + 8, 20800, true); dv.setUint16(x + 10, envCount, true);
  dv.setInt16(x + 12, -1500, true); dv.setUint16(x + 14, 10000, true);
  for (let i = 0; i < count; i++) {
    const d = (i - 312) / 12;
    const g = 20 + (peak - 20) * Math.exp(-d * d);
    const o = x + 20 + i * 12;
    dv.setInt16(o, Math.round(g / GYRO_DPS_PER_LSB), true);
    dv.setInt16(o + 10, Math.round(1 / ACC_G_PER_LSB), true);
  }
  const e0 = x + 20 + count * 12;
  let audioPeak = 0;
  for (let j = 0; j < envCount; j++) {
    const t = -1500 + j;
    const v = loud && Math.abs(t - impactMs) < 2 ? 40000 : 90 + Math.round(Math.random() * 40);
    audioPeak = Math.max(audioPeak, v);
    b[e0 + j] = Math.min(255, Math.floor(Math.sqrt(v)));
  }
  dv.setUint16(x + 18, audioPeak, true);
  return finish(KIND.swing, seq, b);
}

// ---------- sessions ----------
// Which swing a button press labels: the latest one whose peak was 0.75–20 s
// before the press. Reaching into the pocket for the button often makes a
// snippet of its own (sharp, with the button's click), peaking about 0.1 s
// before the press, so anything that close is the press, not the shot. The
// tracker's own ref_seq simply takes the latest snippet; it's kept in the
// export but not used. Times are the tracker's clock (device_ms), which only
// goes back if it restarted, and then nothing from before qualifies.
export const LABEL_MIN_MS = 750, LABEL_MAX_MS = 20000;
export function labelTarget(label, swings) {
  let best = null;
  for (const w of swings) {
    if (w.seq > label.seq) continue;
    const gap = label.deviceMs - w.deviceMs;
    if (gap >= LABEL_MIN_MS && gap <= LABEL_MAX_MS && (!best || w.seq > best.seq)) best = w;
  }
  return best ? best.seq : null;
}

// rows: stored captures for one log (any order). Returns sessions, each with
// its swings (labelled or not), labels, and missed shots (labels with no swing).
export function sessions(rows) {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  const out = [];
  let cur = null;
  const open = (r) => {
    cur = { logId: r.logId, startSeq: r.seq, start: r.time ?? null, end: null, trigger: r.trigger ?? null,
      swings: [], labels: [], ended: false };
    out.push(cur);
  };
  for (const r of sorted) {
    if (r.kind === KIND.sessionStart) { open(r); continue; }
    if (r.kind === KIND.logStart) continue;
    if (!cur) open({ ...r, kind: KIND.sessionStart, time: r.time });
    if (r.kind === KIND.sessionEnd) { cur.end = r.time ?? null; cur.ended = true; cur = null; continue; }
    if (r.kind === KIND.swing) cur.swings.push(r);
    if (r.kind === KIND.label) cur.labels.push(r);
  }
  for (const s of out) {
    const labelled = new Map();
    for (const l of s.labels) {
      l.swingSeq = labelTarget(l, s.swings);
      if (l.swingSeq != null && !labelled.has(l.swingSeq)) labelled.set(l.swingSeq, l.deviceMs - s.swings.find((w) => w.seq === l.swingSeq).deviceMs);
    }
    s.labelledSeqs = labelled;
    s.real = s.swings.filter((w) => labelled.has(w.seq)).length;
    s.missed = s.labels.filter((l) => l.swingSeq == null).length;
    s.start ??= s.swings[0]?.time ?? s.labels[0]?.time ?? null;
  }
  return out;
}

// ---------- export ----------
// One JSON file for the Phase 4 notebook. IMU values are raw sensor counts:
// multiply by `scale` (gyro deg/s, accel g). Envelope values are √ of the
// level, so `level = value²` (0–65535).
export function exportJson(rows, { appVersion } = {}) {
  const byLog = new Map();
  for (const r of rows) {
    if (!byLog.has(r.logId)) byLog.set(r.logId, []);
    byLog.get(r.logId).push(r);
  }
  const logs = [];
  for (const [logId, list] of byLog) {
    const ss = sessions(list);
    logs.push({
      logId: logId.toString(16).padStart(8, '0'),
      sessions: ss.map((s) => ({
        start: s.start ? new Date(s.start * 1000).toISOString() : null,
        end: s.end ? new Date(s.end * 1000).toISOString() : null,
        trigger_dps: s.trigger,
        swings: s.swings.map((w) => {
          const d = decodeRecord(w.bytes, { full: true });
          return {
            seq: w.seq, time: w.time ? new Date(w.time * 1000).toISOString() : null, device_ms: w.deviceMs,
            lat: w.pos?.lat ?? null, lon: w.pos?.lon ?? null, hdop: w.hdop, sats: w.sats,
            labelled: s.labelledSeqs.has(w.seq), label_gap_ms: s.labelledSeqs.get(w.seq) ?? null,
            peak_gyro_dps: d.peakGyro, trigger_dps: d.trigger, flags: d.flags, audio_peak: d.audioPeak,
            imu: { rate_hz: d.imuRateHz, peak_index: d.imuPeakIndex, scale: { gyro_dps: GYRO_DPS_PER_LSB, accel_g: ACC_G_PER_LSB },
              columns: ['gx', 'gy', 'gz', 'ax', 'ay', 'az'], raw: d.imu },
            envelope: { rate_hz: d.envRateHz, start_ms: d.envStartMs, sqrt_level: d.env },
          };
        }),
        labels: s.labels.map((l) => ({ seq: l.seq, time: l.time ? new Date(l.time * 1000).toISOString() : null,
          device_ms: l.deviceMs, swing_seq: l.swingSeq ?? null, tracker_ref_seq: l.refSeq, tracker_gap_ms: l.gapMs, lat: l.pos?.lat ?? null, lon: l.pos?.lon ?? null })),
      })),
    });
  }
  return { app: 'golftracker-capture', version: 2, appVersion: appVersion ?? null, exportedAt: new Date().toISOString(),
    format: 'docs/ble-protocol.md, Capture log',
    label_rule: `a press labels the latest swing whose peak was ${LABEL_MIN_MS}-${LABEL_MAX_MS} ms before it (swing_seq)`, logs };
}
