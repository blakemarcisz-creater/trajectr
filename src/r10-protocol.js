// R10 protocol layer — reverse-engineered Garmin Approach R10 BLE protocol.
// Ported from the MIT-licensed reference implementation (github.com/mholow/gsp-r10-adapter)
// and proven working against real hardware via the Web Bluetooth test harness.
//
// Transport-agnostic: pass a transport with { write(Uint8Array): Promise, onNotify(cb) }.

export const UUIDS = {
  BATTERY_SERVICE: '0000180f-0000-1000-8000-00805f9b34fb',
  BATTERY_CHAR: '00002a19-0000-1000-8000-00805f9b34fb',
  DEVICE_INFO_SERVICE: '0000180a-0000-1000-8000-00805f9b34fb',
  FIRMWARE_CHAR: '00002a28-0000-1000-8000-00805f9b34fb',
  MODEL_CHAR: '00002a24-0000-1000-8000-00805f9b34fb',
  DEVICE_INTERFACE_SERVICE: '6a4e2800-667b-11e3-949a-0800200c9a66',
  DEVICE_INTERFACE_NOTIFIER: '6a4e2812-667b-11e3-949a-0800200c9a66',
  DEVICE_INTERFACE_WRITER: '6a4e2822-667b-11e3-949a-0800200c9a66',
  MEASUREMENT_SERVICE: '6a4e3400-667b-11e3-949a-0800200c9a66',
};

export const STATE_NAMES = ['STANDBY', 'INTERFERENCE_TEST', 'WAITING', 'RECORDING', 'PROCESSING', 'ERROR'];
const ERROR_CODES = ['UNKNOWN', 'OVERHEATING', 'RADAR_SATURATION', 'PLATFORM_TILTED'];
const SEVERITIES = ['WARNING', 'SERIOUS', 'FATAL'];

// ── CRC-16 (poly 0xA001, reflected) ──────────────────────────
const CRC_TABLE = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let value = 0, temp = i;
  for (let j = 0; j < 8; j++) {
    if (((value ^ temp) & 1) !== 0) value = (value >>> 1) ^ 0xA001;
    else value = value >>> 1;
    temp = temp >>> 1;
  }
  CRC_TABLE[i] = value;
}
function crc16(bytes) {
  let crc = 0;
  for (const b of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ b) & 0xff];
  return new Uint8Array([crc & 0xff, (crc >> 8) & 0xff]);
}

// ── COBS ─────────────────────────────────────────────────────
function cobsEncode(input) {
  const result = [];
  let distanceIndex = 0, distance = 1;
  for (const b of input) {
    if (b !== 0 && distance < 255) { result.push(b); distance++; }
    else { result.splice(distanceIndex, 0, distance); distanceIndex = result.length; distance = 1; }
  }
  if (result.length !== 255 && result.length > 0) result.splice(distanceIndex, 0, distance);
  return new Uint8Array(result);
}
function cobsDecode(input) {
  const arr = Array.from(input);
  const result = [];
  let distanceIndex = 0;
  while (distanceIndex < arr.length) {
    const distance = arr[distanceIndex];
    if (arr.length < distanceIndex + distance || distance < 1) return new Uint8Array(0);
    for (let i = 1; i < distance; i++) result.push(arr[distanceIndex + i]);
    distanceIndex += distance;
    if (distance < 0xFF && distanceIndex < arr.length) result.push(0);
  }
  return new Uint8Array(result);
}

// ── Minimal protobuf wire format ─────────────────────────────
function varintEncode(n) {
  const out = [];
  n = n >>> 0;
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return out;
}
function tagBytes(fieldNum, wireType) { return varintEncode((fieldNum << 3) | wireType); }
function fieldVarint(fieldNum, value) { return new Uint8Array([...tagBytes(fieldNum, 0), ...varintEncode(value)]); }
function fieldFloat(fieldNum, value) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, value, true);
  return new Uint8Array([...tagBytes(fieldNum, 5), ...b]);
}
function fieldMessage(fieldNum, msgBytes) {
  return new Uint8Array([...tagBytes(fieldNum, 2), ...varintEncode(msgBytes.length), ...msgBytes]);
}
function concatBytes(...arrs) {
  const len = arrs.reduce((a, x) => a + x.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}
function readVarint(bytes, i) {
  let result = 0, shift = 0, b;
  do { b = bytes[i++]; result |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
  return [result >>> 0, i];
}
function decodeFields(bytes) {
  const fields = new Map();
  let i = 0;
  while (i < bytes.length) {
    const [tag, ni] = readVarint(bytes, i); i = ni;
    const fieldNum = tag >>> 3, wireType = tag & 7;
    let raw;
    if (wireType === 0) { const [v, ni2] = readVarint(bytes, i); raw = v; i = ni2; }
    else if (wireType === 5) { raw = bytes.slice(i, i + 4); i += 4; }
    else if (wireType === 1) { raw = bytes.slice(i, i + 8); i += 8; }
    else if (wireType === 2) { const [len, ni2] = readVarint(bytes, i); i = ni2; raw = bytes.slice(i, i + len); i += len; }
    else break;
    if (!fields.has(fieldNum)) fields.set(fieldNum, []);
    fields.get(fieldNum).push({ wireType, raw });
  }
  return fields;
}
function asFloat32(raw) { return new DataView(raw.buffer, raw.byteOffset, 4).getFloat32(0, true); }
function firstField(fields, num) { const f = fields.get(num); return f ? f[0].raw : undefined; }

// ── Message builders ─────────────────────────────────────────
const EMPTY = new Uint8Array(0);
function buildWrapper({ eventBytes, serviceBytes }) {
  const parts = [];
  if (eventBytes) parts.push(fieldMessage(30, eventBytes));
  if (serviceBytes) parts.push(fieldMessage(38, serviceBytes));
  return concatBytes(...parts);
}
const buildStatusRequest = () => buildWrapper({ serviceBytes: fieldMessage(1, EMPTY) });
const buildWakeUpRequest = () => buildWrapper({ serviceBytes: fieldMessage(3, EMPTY) });
function buildSubscribeRequest() {
  const alertMessage = fieldVarint(1, 8); // AlertType.LAUNCH_MONITOR = 8
  return buildWrapper({ eventBytes: fieldMessage(1, fieldMessage(1, alertMessage)) });
}
function buildShotConfigRequest(teeRangeMeters) {
  const cfg = concatBytes(
    fieldFloat(1, 21.0),   // temperature °C
    fieldFloat(2, 0.5),    // humidity
    fieldFloat(3, 0.0),    // altitude
    fieldFloat(4, 1.225),  // air density kg/m³
    fieldFloat(5, teeRangeMeters)
  );
  return buildWrapper({ serviceBytes: fieldMessage(11, cfg) });
}

// ── Parsers ──────────────────────────────────────────────────
function parseFloats(bytes, names) {
  const f = decodeFields(bytes);
  const out = {};
  names.forEach((name, idx) => {
    const r = firstField(f, idx + 1);
    if (r !== undefined && typeof r !== 'number') out[name] = asFloat32(r);
  });
  return out;
}
function parseMetrics(bytes) {
  const f = decodeFields(bytes);
  const out = { shot_id: firstField(f, 1), shot_type: firstField(f, 2) };
  const bm = firstField(f, 3);
  if (bm) out.ball_metrics = parseFloats(bm, ['launch_angle', 'launch_direction', 'ball_speed', 'spin_axis', 'total_spin']);
  const cm = firstField(f, 4);
  if (cm) out.club_metrics = parseFloats(cm, ['club_head_speed', 'club_angle_face', 'club_angle_path', 'attack_angle']);
  const sm = firstField(f, 5);
  if (sm) {
    const sf = decodeFields(sm);
    out.swing_metrics = {
      back_swing_start_time: firstField(sf, 1),
      down_swing_start_time: firstField(sf, 2),
      impact_time: firstField(sf, 3),
      follow_through_end_time: firstField(sf, 4),
    };
  }
  return out;
}
function parseState(bytes) {
  const st = firstField(decodeFields(bytes), 1);
  return st !== undefined ? STATE_NAMES[st] ?? `UNKNOWN(${st})` : undefined;
}
function parseError(bytes) {
  const f = decodeFields(bytes);
  const out = {};
  const code = firstField(f, 1);
  const severity = firstField(f, 2);
  if (code !== undefined) out.code = ERROR_CODES[code] ?? `UNKNOWN(${code})`;
  if (severity !== undefined) out.severity = SEVERITIES[severity] ?? `UNKNOWN(${severity})`;
  const tilt = firstField(f, 3);
  if (tilt !== undefined) out.deviceTilt = parseFloats(tilt, ['roll', 'pitch']);
  return out;
}
function parseWrapper(bytes) {
  const f = decodeFields(bytes);
  const out = {};
  const ev = firstField(f, 30);
  if (ev !== undefined) {
    const ef = decodeFields(ev);
    out.event = {};
    const notif = firstField(ef, 3);
    if (notif !== undefined) {
      const nf = decodeFields(notif);
      const details = firstField(nf, 1001);
      if (details) {
        const df = decodeFields(details);
        const notification = {};
        const st = firstField(df, 1); if (st !== undefined) notification.state = parseState(st);
        const met = firstField(df, 2); if (met !== undefined) notification.metrics = parseMetrics(met);
        const err = firstField(df, 3); if (err !== undefined) notification.error = parseError(err);
        out.event.notification = notification;
      }
    }
    const sub = firstField(ef, 2);
    if (sub !== undefined) out.event.subscribed = true;
  }
  const svc = firstField(f, 38);
  if (svc !== undefined) {
    const sf = decodeFields(svc);
    out.service = {};
    const statusResp = firstField(sf, 2);
    if (statusResp !== undefined) {
      const st = firstField(decodeFields(statusResp), 1);
      out.service.status = st !== undefined ? parseState(st) : undefined;
    }
    const wakeResp = firstField(sf, 4);
    if (wakeResp !== undefined) out.service.wakeStatus = firstField(decodeFields(wakeResp), 1);
    const shotCfgResp = firstField(sf, 12);
    if (shotCfgResp !== undefined) out.service.shotConfigSuccess = firstField(decodeFields(shotCfgResp), 1) === 1;
  }
  return out;
}

// ── R10 session ──────────────────────────────────────────────
// callbacks: onState(name), onMetrics(metrics), onError({code,severity,deviceTilt}), onLog(tag, msg)
export class R10 {
  constructor(transport, callbacks = {}) {
    this.transport = transport;
    this.cb = callbacks;
    this.header = 0;
    this.handshakeDone = false;
    this.currentMessage = [];
    this.protoCounter = 0;
    this.pending = new Map();
    this.writeChain = Promise.resolve();
    this.processedShotIds = new Set();
    this.onHandshakeComplete = null;
    transport.onNotify((bytes) => this.handleNotify(bytes));
  }

  log(tag, msg) { this.cb.onLog?.(tag, msg); }

  enqueue(fn) {
    this.writeChain = this.writeChain.then(fn).catch(e => this.log('err', 'Write failed: ' + e.message));
    return this.writeChain;
  }

  rawSend(payload) {
    return this.enqueue(() => this.transport.write(new Uint8Array([this.header, ...payload])));
  }

  sendFramed(body) {
    const length = 2 + body.length + 2;
    const withLen = concatBytes(new Uint8Array([length & 0xff, (length >> 8) & 0xff]), body);
    const fullFrame = concatBytes(withLen, crc16(withLen));
    const framed = concatBytes(new Uint8Array([0x00]), cobsEncode(fullFrame), new Uint8Array([0x00]));
    const chunks = [];
    for (let off = 0; off < framed.length; off += 19) chunks.push(framed.slice(off, off + 19));
    // All chunks of one message are enqueued as ONE atomic unit so an ack triggered by
    // an incoming notification can't interleave mid-message (device drops the frame if it does).
    return this.enqueue(async () => {
      for (const chunk of chunks) await this.transport.write(new Uint8Array([this.header, ...chunk]));
    });
  }

  sendProtobuf(protoBytes) {
    const counter = this.protoCounter++;
    const counterB = new Uint8Array(4); new DataView(counterB.buffer).setUint32(0, counter, true);
    const lenB = new Uint8Array(4); new DataView(lenB.buffer).setUint32(0, protoBytes.length, true);
    const body = concatBytes(new Uint8Array([0xb3, 0x13]), counterB, new Uint8Array([0, 0]), lenB, lenB, protoBytes);
    return new Promise((resolve, reject) => {
      this.pending.set(counter, resolve);
      this.sendFramed(body);
      setTimeout(() => {
        if (this.pending.has(counter)) {
          this.pending.delete(counter);
          reject(new Error('Timed out waiting for device response'));
        }
      }, 6000);
    });
  }

  async start() {
    this.header = 0;
    this.handshakeDone = false;
    this.protoCounter = 0;
    const handshakeP = new Promise((resolve, reject) => {
      this.onHandshakeComplete = resolve;
      setTimeout(() => reject(new Error('Handshake timed out')), 10000);
    });
    await this.rawSend([0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0]);
    await handshakeP;
    this.log('ok', 'Handshake complete');

    const wake = await this.sendProtobuf(buildWakeUpRequest());
    this.log('ok', 'Wake: ' + JSON.stringify(wake.service ?? {}));
    const status = await this.sendProtobuf(buildStatusRequest());
    if (status.service?.status) this.cb.onState?.(status.service.status);
    await this.sendProtobuf(buildSubscribeRequest());
    this.log('ok', 'Subscribed to launch monitor alerts');
  }

  async sendShotConfig(ballDistanceFt) {
    const meters = ballDistanceFt * 0.3048;
    const resp = await this.sendProtobuf(buildShotConfigRequest(meters));
    this.log(resp.service?.shotConfigSuccess ? 'ok' : 'err',
      `Shot config (${ballDistanceFt} ft): ` + JSON.stringify(resp.service ?? {}));
    return resp;
  }

  handleNotify(bytes) {
    const rest = bytes.slice(1);
    if (!this.handshakeDone) { this.continueHandshake(rest); return; }

    let msg = rest;
    let readComplete = false;
    if (msg[msg.length - 1] === 0x00) { readComplete = true; msg = msg.slice(0, -1); }
    if (msg.length > 0 && msg[0] === 0x00) { this.currentMessage = []; msg = msg.slice(1); }
    this.currentMessage.push(...msg);

    if (readComplete && this.currentMessage.length > 0) {
      const decoded = cobsDecode(new Uint8Array(this.currentMessage));
      this.currentMessage = [];
      this.processFrame(decoded);
    }
  }

  continueHandshake(msg) {
    const hex = Array.from(msg).map(b => b.toString(16).padStart(2, '0')).join('');
    if (hex.startsWith('010000000000000000010000')) {
      this.header = msg[12];
      this.rawSend([0x00]);
      this.handshakeDone = true;
      this.onHandshakeComplete?.();
    } else {
      this.log('err', 'Unexpected handshake reply: ' + hex);
    }
  }

  processFrame(frame) {
    if (frame.length < 4) return;
    const crcExpected = frame.slice(-2);
    const crcActual = crc16(frame.slice(0, -2));
    if (crcExpected[0] !== crcActual[0] || crcExpected[1] !== crcActual[1]) {
      this.log('err', 'CRC mismatch on incoming frame');
    }
    const msg = frame.slice(2, -2);
    const type = (msg[0] << 8) | msg[1];
    let ackBody = [0x00];

    if (type === 0xb413 || type === 0xb313) {
      ackBody = [0x00, msg[2], msg[3], 0, 0, 0, 0, 0, 0, 0];
      const parsed = parseWrapper(msg.slice(16));
      if (type === 0xb413) {
        const counter = msg[2] | (msg[3] << 8);
        const resolve = this.pending.get(counter);
        if (resolve) { this.pending.delete(counter); resolve(parsed); }
      } else {
        this.handlePush(parsed);
      }
    }
    // Every frame must be acked (0x8813) or the device stalls.
    this.sendFramed(concatBytes(new Uint8Array([0x88, 0x13]), msg.slice(0, 2), new Uint8Array(ackBody)));
  }

  handlePush(parsed) {
    const n = parsed.event?.notification;
    if (!n) return;
    if (n.state) {
      this.cb.onState?.(n.state);
      // Device drops to STANDBY (sleep) after idling — wake it back up automatically
      // like the official app does, so a session never silently dies.
      if (n.state === 'STANDBY' && this.handshakeDone) {
        this.log('info', 'Device went to sleep — sending wake-up');
        this.sendProtobuf(buildWakeUpRequest())
          .then(() => this.log('ok', 'Device woken back up'))
          .catch(e => this.log('err', 'Auto-wake failed: ' + e.message));
      }
    }
    if (n.error?.code) this.cb.onError?.(n.error);
    if (n.metrics && n.metrics.shot_id !== undefined) {
      if (this.processedShotIds.has(n.metrics.shot_id)) return;
      this.processedShotIds.add(n.metrics.shot_id);
      this.cb.onMetrics?.(n.metrics);
    }
  }
}
