import { R10 } from './r10-protocol.js';
import { connectR10 } from './transport.js';
import { estimateCarryFt } from './physics.js';

const MS_TO_MPH = 2.23694;
const $ = (id) => document.getElementById(id);

// ── Persistent state ─────────────────────────────────────────
const store = {
  load(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; }
    catch { return fallback; }
  },
  save(key, value) { localStorage.setItem(key, JSON.stringify(value)); },
};
let settings = store.load('trajectr_settings', { ballDistanceFt: 8, hrDistanceFt: 200, diagnostics: false });
if (settings.hrDistanceFt === undefined) settings.hrDistanceFt = 200;
if (settings.diagnostics === undefined) settings.diagnostics = false;
let history = store.load('trajectr_history', []);

// ── Live state ───────────────────────────────────────────────
let r10 = null;
let transport = null;
let swings = [];          // this session
let derby = { on: false, hr: 0, outs: 10, best: 0 };
let reads = { cycles: 0, awaiting: false };  // radar RECORDING cycles vs. metrics that actually arrived

// ── Logging (Settings screen debug panel) ────────────────────
function log(tag, msg) {
  const el = $('debug-log');
  const line = document.createElement('div');
  line.className = 'log-' + tag;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.appendChild(line);
  while (el.children.length > 400) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}

// ── Connection ───────────────────────────────────────────────
function setConnUi(state, label) {
  const badge = $('ble-badge');
  badge.className = 'ble-widget ' + state;
  $('ble-label').textContent = label;
}

async function connect() {
  if (transport) { // acts as disconnect toggle
    transport.disconnect();
    transport = null; r10 = null;
    setConnUi('idle', 'Connect R10');
    setDeviceState('—');
    return;
  }
  try {
    setConnUi('scanning', 'Connecting…');
    transport = await connectR10({
      onDisconnect: () => {
        log('err', 'Device disconnected');
        transport = null; r10 = null;
        setConnUi('idle', 'Connect R10');
        setDeviceState('—');
      },
      onBattery: (pct) => { $('battery').textContent = pct + '%'; },
      onLog: log,
      onRawMeasurement: settings.diagnostics
        ? (chan, hex) => { if (hex !== '000000' && hex !== '000001' && hex !== '000100') log('raw', `${chan}: ${hex}`); }
        : null,
    });
    r10 = new R10(transport, {
      onState: setDeviceState,
      onMetrics: handleSwing,
      onError: (e) => {
        log('err', `Device: ${e.code} (${e.severity})` +
          (e.deviceTilt ? ` roll ${e.deviceTilt.roll?.toFixed(1)}° pitch ${e.deviceTilt.pitch?.toFixed(1)}°` : ''));
        if (e.code === 'PLATFORM_TILTED') toast('R10 is tilted — set it on flat ground');
        if (e.code === 'RADAR_SATURATION') toast('Radar saturated — check spacing to net');
      },
      onLog: log,
    });
    await r10.start();
    await r10.sendShotConfig(settings.ballDistanceFt);
    await r10.startTiltCalibration().catch(e => log('err', 'Tilt cal failed: ' + e.message));
    setConnUi('connected', transport.name);
  } catch (e) {
    log('err', 'Connect failed: ' + e.message);
    toast('Connect failed: ' + e.message);
    transport?.disconnect?.();
    transport = null; r10 = null;
    setConnUi('idle', 'Connect R10');
  }
}

function setDeviceState(name) {
  if ($('device-state').textContent !== name) log('info', 'State: ' + name);
  // Read-rate tracking: each RECORDING arms a cycle; if the device settles back to
  // WAITING without ever pushing metrics, that swing was seen but not read.
  if (name === 'RECORDING') {
    reads.cycles++;
    reads.awaiting = true;
    renderSessionStats();
  } else if (name === 'WAITING' && reads.awaiting) {
    reads.awaiting = false;
    log('info', `Radar triggered but no metrics (${readRate()}% read rate)`);
    renderSessionStats();
  }
  $('device-state').textContent = name;
  $('device-state').className = 'state-chip ' + (name === 'WAITING' ? 'ready' : name === 'ERROR' ? 'error' : '');
  $('session-sub').textContent =
    name === 'WAITING' ? 'Ready — take a swing' :
    name === 'RECORDING' ? 'Tracking…' :
    name === 'PROCESSING' ? 'Processing swing…' :
    name === 'STANDBY' ? 'Device asleep — swing to wake or reconnect' :
    name === '—' ? 'Connect your R10 to start' : 'Device is getting ready…';
}

// ── Swing handling ───────────────────────────────────────────
function handleSwing(m) {
  const bm = m.ball_metrics, cm = m.club_metrics;
  const swing = {
    time: Date.now(),
    ev: bm?.ball_speed !== undefined ? bm.ball_speed * MS_TO_MPH : null,
    la: bm?.launch_angle ?? null,
    dir: bm?.launch_direction ?? null,
    spin: bm?.total_spin ?? null,
    bat: cm?.club_head_speed !== undefined ? cm.club_head_speed * MS_TO_MPH : null,
    hasBall: m.shot_type === 1 && !!bm,
  };
  swing.dist = swing.hasBall ? estimateCarryFt(swing.ev, swing.la, swing.spin) : null;
  reads.awaiting = false;
  swings.push(swing);
  log('ok', `Swing ${swings.length}: ` + (swing.hasBall
    ? `EV ${swing.ev.toFixed(1)} mph, LA ${swing.la.toFixed(1)}°, ~${Math.round(swing.dist)} ft`
    : `bat ${swing.bat?.toFixed(1) ?? '?'} mph (no ball tracked)`));
  renderLastSwing(swing);
  renderSessionStats();
  renderSwingList();
  if (derby.on && swing.hasBall) derbySwing(swing);
  flashMetrics();
}

function fmt(v, digits = 1) { return v === null || v === undefined ? '—' : v.toFixed(digits); }
function readRate() {
  return reads.cycles ? Math.round(100 * swings.filter(s => s.hasBall).length / reads.cycles) : 0;
}

function renderLastSwing(s) {
  $('m-ev').textContent = fmt(s.ev);
  $('m-dist').textContent = s.dist === null ? '—' : Math.round(s.dist);
  $('m-la').textContent = fmt(s.la);
  $('m-dir').textContent = fmt(s.dir);
  $('m-spin').textContent = s.spin === null ? '—' : Math.round(s.spin).toLocaleString();
  $('m-bat').textContent = fmt(s.bat);
  $('no-ball-note').style.display = s.hasBall ? 'none' : 'block';
}

function renderSessionStats() {
  const withBall = swings.filter(s => s.hasBall);
  const withBat = swings.filter(s => s.bat !== null);
  $('stat-count').textContent = swings.length;
  $('stat-tracked').textContent = withBall.length;
  $('stat-avg-ev').textContent = withBall.length
    ? (withBall.reduce((a, s) => a + s.ev, 0) / withBall.length).toFixed(1) : '—';
  $('stat-max-ev').textContent = withBall.length
    ? Math.max(...withBall.map(s => s.ev)).toFixed(1) : '—';
  $('stat-avg-bat').textContent = withBat.length
    ? (withBat.reduce((a, s) => a + s.bat, 0) / withBat.length).toFixed(1) : '—';
  $('stat-max-dist').textContent = withBall.length
    ? Math.round(Math.max(...withBall.map(s => s.dist ?? 0))) : '—';
  $('stat-read-rate').textContent = reads.cycles ? `${readRate()}%` : '—';
}

function renderSwingList() {
  $('swing-list').innerHTML = swings.slice().reverse().map((s, i) => `
    <div class="swing-row">
      <span class="swing-idx">#${swings.length - i}</span>
      <span class="swing-ev">${s.hasBall ? s.ev.toFixed(1) : '—'}</span>
      <span class="swing-details">${s.hasBall
        ? `~${Math.round(s.dist)} ft · LA ${s.la.toFixed(1)}° · dir ${s.dir.toFixed(1)}° · ${Math.round(s.spin)} rpm · bat ${fmt(s.bat)} mph`
        : `bat ${fmt(s.bat)} mph — ball not tracked`}</span>
    </div>`).join('');
}

function flashMetrics() {
  const grid = $('metrics-grid');
  grid.classList.remove('swing-flash');
  void grid.offsetWidth;
  grid.classList.add('swing-flash');
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 3500);
}

// ── Session end / history ────────────────────────────────────
function endSession() {
  if (!swings.length) { toast('No swings this session yet'); return; }
  const withBall = swings.filter(s => s.hasBall);
  history.push({
    date: new Date().toISOString(),
    count: swings.length,
    tracked: withBall.length,
    avgEV: withBall.length ? withBall.reduce((a, s) => a + s.ev, 0) / withBall.length : null,
    maxEV: withBall.length ? Math.max(...withBall.map(s => s.ev)) : null,
    maxBat: swings.some(s => s.bat !== null) ? Math.max(...swings.filter(s => s.bat !== null).map(s => s.bat)) : null,
    swings,
  });
  store.save('trajectr_history', history);
  toast(`Session saved — ${swings.length} swings, ${withBall.length} tracked`);
  swings = [];
  renderSessionStats();
  renderSwingList();
  renderHistory();
}

function renderHistory() {
  const all = history.flatMap(h => h.swings ?? []);
  const withBall = all.filter(s => s.hasBall);
  const withBat = all.filter(s => s.bat !== null);
  // Older saved swings predate the distance model — estimate on the fly.
  const dists = withBall.map(s => s.dist ?? estimateCarryFt(s.ev, s.la, s.spin)).filter(d => d !== null);
  $('pr-ev').textContent = withBall.length ? Math.max(...withBall.map(s => s.ev)).toFixed(1) : '—';
  $('pr-dist').textContent = dists.length ? Math.round(Math.max(...dists)) : '—';
  $('pr-bat').textContent = withBat.length ? Math.max(...withBat.map(s => s.bat)).toFixed(1) : '—';
  $('pr-sessions').textContent = history.length;

  $('session-log').innerHTML = history.length
    ? history.slice().reverse().map(h => `
      <div class="swing-row">
        <span class="swing-details" style="flex:1">${new Date(h.date).toLocaleDateString()} ${new Date(h.date).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}</span>
        <span class="swing-details">${h.count} swings · ${h.tracked} tracked</span>
        <span class="swing-ev">${h.maxEV ? h.maxEV.toFixed(1) : '—'}</span>
      </div>`).join('')
    : '<div class="caption">No sessions saved yet.</div>';
}

// ── Derby ────────────────────────────────────────────────────
function derbySwing(s) {
  if (derby.outs <= 0 || s.dist === null) return;
  if (s.dist >= settings.hrDistanceFt) {
    derby.hr++;
    if (s.dist > derby.best) derby.best = s.dist;
    toast(`💥 HOME RUN — ~${Math.round(s.dist)} ft`);
  } else {
    derby.outs--;
    if (derby.outs === 0) toast(`Derby over — ${derby.hr} home runs`);
  }
  renderDerby();
}
function renderDerby() {
  $('g-hr').textContent = derby.hr;
  $('g-outs').textContent = derby.outs;
  $('g-best').textContent = derby.best ? Math.round(derby.best) : '—';
  $('derby-toggle').textContent = derby.on ? 'Stop Derby' : 'Start Derby';
  $('derby-status').textContent = derby.on
    ? `Live — every hit carrying ≥ ${settings.hrDistanceFt} ft is a home run`
    : 'Start a derby, then hit. Uses live R10 data.';
}

// ── Settings ─────────────────────────────────────────────────
function bindSettings() {
  $('set-distance').value = settings.ballDistanceFt;
  $('set-hr').value = settings.hrDistanceFt;
  $('set-distance').onchange = () => {
    settings.ballDistanceFt = parseFloat($('set-distance').value) || 8;
    store.save('trajectr_settings', settings);
    if (r10) r10.sendShotConfig(settings.ballDistanceFt).catch(e => log('err', e.message));
  };
  $('set-hr').onchange = () => {
    settings.hrDistanceFt = parseFloat($('set-hr').value) || 200;
    store.save('trajectr_settings', settings);
    renderDerby();
  };
  $('set-diag').checked = settings.diagnostics;
  $('set-diag').onchange = () => {
    settings.diagnostics = $('set-diag').checked;
    store.save('trajectr_settings', settings);
    toast(settings.diagnostics ? 'Diagnostics on — reconnect to capture raw data' : 'Diagnostics off');
  };
  $('btn-tilt-cal').onclick = () => {
    if (!r10) { toast('Connect to the R10 first'); return; }
    toast('Calibrating — keep the R10 still on the ground');
    r10.startTiltCalibration().catch(e => log('err', 'Tilt cal failed: ' + e.message));
  };
  $('btn-copy-log').onclick = async () => {
    const text = Array.from($('debug-log').children).map(l => l.textContent).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast('Log copied');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      toast('Log copied');
    }
  };
  $('btn-clear-history').onclick = () => {
    if (!confirm('Delete all saved sessions?')) return;
    history = [];
    store.save('trajectr_history', history);
    renderHistory();
    toast('History cleared');
  };
}

// ── Navigation ───────────────────────────────────────────────
function nav(screen) {
  document.querySelectorAll('.screen').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active'));
  $('screen-' + screen).classList.add('active');
  $('nav-' + screen).classList.add('active');
  if (screen === 'history') renderHistory();
}

// ── Boot ─────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  ['session', 'history', 'game', 'settings'].forEach(s => { $('nav-' + s).onclick = () => nav(s); });
  $('ble-badge').onclick = connect;
  $('btn-end-session').onclick = endSession;
  $('derby-toggle').onclick = () => {
    derby = { on: !derby.on, hr: 0, outs: 10, best: 0 };
    renderDerby();
  };
  bindSettings();
  renderDerby();
  renderHistory();
  renderSessionStats();
  setDeviceState('—');
});
