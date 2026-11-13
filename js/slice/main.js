import { Renderer, FS_IO } from '../gl.js';
import { pickMime, bitrateFor, presentResult } from '../export.js';
import { IS_IOS, IS_MOBILE, keepAwake, waitForMetadata, usePlaybackAudioSession } from '../mobile.js';
import { detectBeats, TapTempo } from '../cut/beat.js';

const $ = s => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = t => { t = Math.max(0, t || 0); const m = Math.floor(t / 60); return `${m}:${(t % 60).toFixed(1).padStart(4, '0')}`; };
const setFill = el => el.style.setProperty('--fill', ((el.value - el.min) / (el.max - el.min)) * 100 + '%');
const hex3 = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
const MAX_SLICES = 10;
const PREVIEW_LONG = IS_MOBILE ? 720 : 960;

/* ---------- State ---------- */
const S = {
  dir: 0, count: 4, gap: 0, gapColor: '#000000', look: 0,
  mode: 'beat', bpm: 120, offsetFrac: 0, every: 2, hold: 1, pattern: 'alternate', density: 0.5, seed: 7,
  secStart: 0, secEnd: 0, duration: 0,
};
let ready = false, fileName = 'video', exportJob = null, lastDownload = null;
let freeEvents = [];          // free form: { id, start, end, mask }
const overrides = new Map();  // beat mode: pause index -> mask the user picked
let events = [];              // resolved list for the current mode
let selectedKey = null;       // id (free) or index (beat) of the pause being edited
let nextId = 1;
const fullMask = () => (1 << S.count) - 1;
const beatLen = () => 60 / S.bpm;

/* ---------- Pause list ---------- */
function rng(seed) { let t = (seed + 0x6d2b79f5) >>> 0; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
function patternMask(k) {
  const n = S.count;
  let m = 0;
  switch (S.pattern) {
    case 'alternate': for (let i = 0; i < n; i++) if (i % 2 === k % 2) m |= 1 << i; break;
    case 'sweep': m = 1 << (k % n); break;
    case 'build': for (let i = 0; i <= k % n; i++) m |= 1 << i; break;
    case 'halves': for (let i = 0; i < n; i++) if ((i < n / 2) === (k % 2 === 0)) m |= 1 << i; break;
    case 'all': m = fullMask(); break;
    default: // random
      for (let i = 0; i < n; i++) if (rng(S.seed * 7919 + k * 131 + i * 17) < S.density) m |= 1 << i;
      if (m === 0) m = 1 << Math.floor(rng(S.seed + k) * n);
      if (m === fullMask() && n > 1) m &= ~(1 << Math.floor(rng(S.seed + k * 3) * n));
  }
  return m & fullMask();
}
function rebuildEvents() {
  if (S.mode === 'beat') {
    const beat = beatLen(), off = S.offsetFrac * beat;
    const hold = Math.min(S.hold, S.every) * beat;
    events = [];
    for (let k = 0, t = off; t < S.duration - 0.01 && k < 5000; k++, t += S.every * beat) {
      const custom = overrides.has(k);
      events.push({ key: k, index: k, start: t, end: Math.min(S.duration, t + hold), mask: (custom ? overrides.get(k) : patternMask(k)) & fullMask(), custom });
    }
  } else {
    freeEvents.sort((a, b) => a.start - b.start);
    events = freeEvents.map((e, i) => ({ key: e.id, index: i, start: e.start, end: e.end, mask: e.mask & fullMask(), custom: true, ref: e }));
  }
  if (!events.some(e => e.key === selectedKey)) selectedKey = events.length ? events[0].key : null;
  activeKey = undefined; // force a fresh freeze frame
  drawTimelineBase();
  renderEditor();
  updateBadge();
  dirty = true;
}
const selectedEvent = () => events.find(e => e.key === selectedKey) || null;
function setMask(ev, mask) {
  mask &= fullMask();
  if (S.mode === 'beat') overrides.set(ev.index, mask); else ev.ref.mask = mask;
  rebuildEvents();
}
function activeEventAt(t) {
  // binary search for the last pause starting at or before t
  let lo = 0, hi = events.length - 1, found = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (events[mid].start <= t) { found = mid; lo = mid + 1; } else hi = mid - 1; }
  return found >= 0 && t < events[found].end ? events[found] : null;
}

/* ---------- GL ---------- */
const canvas = $('#slice-canvas');
const r = new Renderer(canvas, { preserve: IS_IOS });
const SLICE_FS = FS_IO + /* glsl */ `
uniform sampler2D uLive, uHeld;
uniform float uFrozen[${MAX_SLICES}];
uniform float uCount, uDir, uGap, uLook;
uniform vec3 uGapColor;
void main() {
  float coord = uDir < 0.5 ? vUv.x : 1.0 - vUv.y;      // columns left to right, rows top to bottom
  float pos = coord * uCount;
  int idx = int(min(floor(pos), uCount - 1.0));
  bool frozen = uFrozen[idx] > 0.5;
  vec3 c = frozen ? texture(uHeld, vUv).rgb : texture(uLive, vUv).rgb;
  if (frozen) {
    if (uLook > 0.5 && uLook < 1.5) c *= 0.5;
    else if (uLook > 1.5 && uLook < 2.5) c = vec3(luma(c));
    else if (uLook > 2.5 && uLook < 3.5) c = mix(c, vec3(1.0, 0.31, 0.64), 0.22);
    else if (uLook > 3.5) c = 1.0 - c;
  }
  if (uGap > 0.0) {
    float edge = floor(pos + 0.5);
    float span = (uDir < 0.5 ? uRes.x : uRes.y) / uCount;
    if (edge > 0.0 && edge < uCount && abs(pos - edge) * span < uGap * uScale * 0.5) c = uGapColor;
  }
  outColor = vec4(c, 1.0);
}`;
const sliceProg = r.fx(SLICE_FS);
let held = null;
let activeKey;
const frozenArr = new Float32Array(MAX_SLICES);

function fitSize(vw, vh, longSide) {
  const s = Math.min(1, longSide / Math.max(vw, vh));
  return [Math.max(2, Math.round(vw * s / 2) * 2), Math.max(2, Math.round(vh * s / 2) * 2)];
}
function resizeTo(w, h) {
  r.resize(w, h);
  if (held) held.dispose();
  held = r.createTarget(w, h);
  activeKey = undefined;
}
resizeTo(960, 540);

function render(t, step) {
  r.time = t;
  if (step) r.upload(video, video.videoWidth, video.videoHeight);
  if (!r.hasFrame) return;
  const ev = activeEventAt(t);
  const key = ev ? ev.key : null;
  // Entering a pause: hold this exact frame for the strips that freeze.
  if (key !== activeKey) { if (ev) r.blit(r.cur, held); activeKey = key; }
  for (let i = 0; i < MAX_SLICES; i++) frozenArr[i] = ev && (ev.mask >> i) & 1 ? 1 : 0;
  r.pass(sliceProg, null, {
    uFrozen: frozenArr, uCount: S.count, uDir: S.dir, uGap: S.gap, uLook: S.look, uGapColor: hex3(S.gapColor),
  }, { uLive: r.cur, uHeld: held });
}

/* ---------- Audio ---------- */
const video = $('#video');
let actx = null, monitor = null, recordDest = null;
function ensureAudio() {
  if (actx) return;
  usePlaybackAudioSession();
  actx = new (window.AudioContext || window.webkitAudioContext)();
  const src = actx.createMediaElementSource(video);
  monitor = actx.createGain();
  recordDest = actx.createMediaStreamDestination();
  src.connect(monitor); monitor.connect(actx.destination);
  src.connect(recordDest);
  applyVolume();
}
const resumeAudio = () => { if (actx && actx.state !== 'running') actx.resume().catch(() => {}); };
function click(accent) {
  if (!actx) return;
  const o = actx.createOscillator(), g = actx.createGain();
  o.frequency.value = accent ? 1760 : 1100;
  g.gain.setValueAtTime(0.0001, actx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.35, actx.currentTime + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.06);
  o.connect(g); g.connect(actx.destination);
  o.start(); o.stop(actx.currentTime + 0.07);
}

/* ---------- Loading ---------- */
let objectUrl = null, currentFile = null;
$('#file-input').addEventListener('change', e => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; });
['dragenter', 'dragover'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); $('#dropzone').classList.add('drag'); }));
['dragleave', 'drop'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); $('#dropzone').classList.remove('drag'); }));
document.addEventListener('drop', e => { const f = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith('video/') || /\.(mp4|mov|webm|m4v|mkv)$/i.test(f.name)); if (f) loadFile(f); });

async function loadFile(file) {
  if (exportJob) return;
  ready = false;
  currentFile = file;
  fileName = file.name.replace(/\.[^.]+$/, '') || 'video';
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  ensureAudio();
  video.src = objectUrl;
  video.loop = false;
  try { await waitForMetadata(video); } catch (e) { alert("This browser can't decode that video. Try an H.264 MP4 or a WebM file."); return; }
  S.duration = video.duration || 0;
  S.secStart = 0; S.secEnd = S.duration;
  $('#sec-start').value = '0.0'; $('#sec-end').value = S.duration.toFixed(1);
  $('#sec-start').max = $('#sec-end').max = S.duration.toFixed(1);
  updateSectionLabel();
  resizeTo(...fitSize(video.videoWidth, video.videoHeight, PREVIEW_LONG));
  freeEvents = [];
  overrides.clear();
  $('#viewer').classList.add('has-video');
  $('#play-btn').disabled = false;
  $('#export-btn').disabled = false;
  $('#detect-btn').disabled = false;
  $('#render-jump').hidden = false;
  ready = true;
  hookFrames();
  rebuildEvents();
  play();
}

/* ---------- Playback (iOS: start media first, inside the tap) ---------- */
const playBtn = $('#play-btn'), playOverlay = $('#play-overlay'), soundBtn = $('#sound-btn');
let wantPlay = true;
async function play() {
  const attempt = video.play();
  resumeAudio();
  try { await attempt; playOverlay.hidden = true; }
  catch (e) {
    video.muted = true;
    try { await video.play(); playOverlay.hidden = true; soundBtn.hidden = false; } catch (e2) { playOverlay.hidden = false; }
  }
  syncPlayBtn();
}
function enableSound() {
  if (!video.muted) return;
  video.muted = false;
  const p = video.play();
  resumeAudio();
  soundBtn.hidden = true;
  p.catch(() => { video.muted = true; soundBtn.hidden = false; });
}
const syncPlayBtn = () => playBtn.classList.toggle('paused', video.paused);
soundBtn.addEventListener('click', e => { e.stopPropagation(); enableSound(); });
playOverlay.addEventListener('click', () => { wantPlay = true; play(); });
playBtn.addEventListener('click', () => { if (video.paused) { wantPlay = true; play(); } else { wantPlay = false; video.pause(); syncPlayBtn(); } });
document.addEventListener('click', () => { if (ready && video.muted && !video.paused && !exportJob) enableSound(); });
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && ready && !exportJob && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement.tagName)) { e.preventDefault(); playBtn.click(); }
});
video.addEventListener('pause', syncPlayBtn);
video.addEventListener('play', syncPlayBtn);
video.addEventListener('ended', () => {
  if (exportJob) { finishExport(false); return; }
  seek(S.secStart);
  if (wantPlay) play();
});
function seek(t) { video.currentTime = t; activeKey = undefined; dirty = true; }

const volIn = $('#volume'), muteBtn = $('#mute-btn');
let muted = false;
function applyVolume() { if (monitor) monitor.gain.value = muted ? 0 : +volIn.value; muteBtn.classList.toggle('muted', muted || +volIn.value === 0); setFill(volIn); }
volIn.oninput = () => { muted = false; applyVolume(); };
muteBtn.onclick = () => { muted = !muted; applyVolume(); };
setFill(volIn);

/* ---------- Section ---------- */
const secStartIn = $('#sec-start'), secEndIn = $('#sec-end');
function updateSectionLabel() { $('#sec-len').textContent = `${(S.secEnd - S.secStart).toFixed(1)}s of ${S.duration.toFixed(1)}s`; }
function onSection() {
  S.secStart = clamp(+secStartIn.value || 0, 0, Math.max(0, S.duration - 0.5));
  S.secEnd = clamp(+secEndIn.value || S.duration, S.secStart + 0.5, S.duration);
  updateSectionLabel(); drawTimelineBase();
  if (video.currentTime < S.secStart || video.currentTime > S.secEnd) seek(S.secStart);
}
secStartIn.onchange = onSection;
secEndIn.onchange = onSection;

/* ---------- Slice controls ---------- */
document.querySelectorAll('#dir .seg-btn').forEach(b => b.onclick = () => {
  S.dir = +b.dataset.v;
  document.querySelectorAll('#dir .seg-btn').forEach(x => x.classList.toggle('is-on', x === b));
  renderEditor(); updateBadge(); dirty = true;
});
const countIn = $('#count');
countIn.oninput = () => { S.count = +countIn.value; $('#count-val').textContent = S.count; setFill(countIn); rebuildEvents(); };
const gapIn = $('#gap');
gapIn.oninput = () => { S.gap = +gapIn.value; $('#gap-val').textContent = S.gap + ' px'; setFill(gapIn); dirty = true; };
$('#gap-color').oninput = e => { S.gapColor = e.target.value; dirty = true; };
$('#look').onchange = e => { S.look = +e.target.value; dirty = true; };
[countIn, gapIn].forEach(setFill);

/* ---------- Timing controls ---------- */
function setMode(m) {
  S.mode = m;
  document.body.classList.toggle('mode-free', m === 'free');
  document.body.classList.toggle('mode-beat', m === 'beat');
  document.querySelectorAll('#mode .seg-btn').forEach(x => x.classList.toggle('is-on', x.dataset.v === m));
  rebuildEvents();
}
document.querySelectorAll('#mode .seg-btn').forEach(b => b.onclick = () => setMode(b.dataset.v));
const bpmIn = $('#bpm'), offsetIn = $('#offset');
function setBpm(v) { S.bpm = clamp(+v || 120, 40, 300); bpmIn.value = +S.bpm.toFixed(1); updateOffsetLabel(); rebuildEvents(); }
bpmIn.onchange = () => setBpm(bpmIn.value);
$('#half-btn').onclick = () => setBpm(S.bpm / 2);
$('#double-btn').onclick = () => setBpm(S.bpm * 2);
function updateOffsetLabel() { $('#offset-val').textContent = Math.round(S.offsetFrac * beatLen() * 1000) + ' ms'; setFill(offsetIn); }
offsetIn.oninput = () => { S.offsetFrac = +offsetIn.value; updateOffsetLabel(); rebuildEvents(); };
$('#every').onchange = e => { S.every = +e.target.value; rebuildEvents(); };
$('#hold').onchange = e => { S.hold = +e.target.value; rebuildEvents(); };
$('#pattern').onchange = e => { S.pattern = e.target.value; rebuildEvents(); };
const densIn = $('#density');
densIn.oninput = () => { S.density = +densIn.value; setFill(densIn); if (S.pattern === 'random') rebuildEvents(); };
setFill(densIn);
$('#reshuffle-btn').onclick = () => { S.seed = (Math.random() * 1e6) | 0; rebuildEvents(); };
const tapper = new TapTempo();
$('#tap-btn').onclick = e => {
  const bpm = tapper.tap();
  const btn = e.currentTarget;
  btn.classList.add('flash'); setTimeout(() => btn.classList.remove('flash'), 90);
  if (!bpm) { $('#tempo-status').textContent = 'Keep tapping on the beat...'; return; }
  S.bpm = clamp(bpm, 40, 300); bpmIn.value = +S.bpm.toFixed(1);
  if (!video.paused && tapper.taps.length >= 4) { S.offsetFrac = (video.currentTime % beatLen()) / beatLen(); offsetIn.value = S.offsetFrac; }
  updateOffsetLabel(); rebuildEvents();
  $('#tempo-status').textContent = `Tapped ${S.bpm.toFixed(1)} BPM from ${tapper.taps.length} taps${!video.paused ? ', grid aligned to your taps' : ''}.`;
};
$('#detect-btn').onclick = async () => {
  if (!currentFile) return;
  const limit = IS_MOBILE ? 250e6 : 1500e6;
  if (currentFile.size > limit) { $('#tempo-status').textContent = `That file is ${(currentFile.size / 1e6).toFixed(0)} MB, too large to analyze on this device. Tap or type the tempo instead.`; return; }
  const btn = $('#detect-btn');
  btn.disabled = true; btn.textContent = 'Listening...';
  $('#tempo-status').textContent = 'Analyzing the audio. Long clips take a few seconds.';
  try {
    const { bpm, offset } = await detectBeats(currentFile);
    S.bpm = bpm; bpmIn.value = bpm;
    S.offsetFrac = clamp(offset / beatLen(), 0, 1); offsetIn.value = S.offsetFrac;
    updateOffsetLabel(); rebuildEvents();
    $('#tempo-status').textContent = `Detected ${bpm} BPM, first beat at ${offset.toFixed(2)}s. Use ÷2 or ×2 if it feels half or double time.`;
  } catch (e) {
    $('#tempo-status').textContent = "Couldn't find a beat in this clip's audio (or it has none). Tap or type the BPM instead.";
  }
  btn.disabled = false; btn.textContent = "Detect beat from the clip's audio";
};
updateOffsetLabel();

/* ---------- Pause editor ---------- */
const picker = $('#strip-picker');
function renderEditor() {
  const ev = selectedEvent();
  picker.className = 'strip-picker ' + (S.dir === 0 ? 'cols' : 'rows') + (ev ? '' : ' disabled');
  picker.innerHTML = '';
  for (let i = 0; i < S.count; i++) {
    const b = document.createElement('button');
    b.className = 'strip' + (ev && (ev.mask >> i) & 1 ? ' frozen' : '');
    b.textContent = i + 1;
    b.title = `${S.dir === 0 ? 'Column' : 'Row'} ${i + 1}`;
    b.onclick = () => { const e = selectedEvent(); if (e) setMask(e, e.mask ^ (1 << i)); };
    picker.appendChild(b);
  }
  const idx = ev ? events.indexOf(ev) : -1;
  $('#pe-title').textContent = ev ? `Pause ${idx + 1} of ${events.length}` : 'Pauses';
  $('#pe-sub').textContent = !ready ? 'Add a video to start placing pauses.'
    : !ev ? (S.mode === 'free' ? 'No pauses yet. Move the playhead and tap + Add pause at playhead.' : 'No pauses fit in this clip at the current tempo.')
    : `At ${fmt(ev.start)} for ${(ev.end - ev.start).toFixed(2)}s${S.mode === 'beat' ? ` (${Math.min(S.hold, S.every)} beat${Math.min(S.hold, S.every) === 1 ? '' : 's'})${ev.custom ? ', your own pick' : ', from the pattern'}` : ''}.`;
  $('#pe-prev').disabled = idx <= 0;
  $('#pe-next').disabled = idx < 0 || idx >= events.length - 1;
  $('#pe-reset').disabled = !(ev && ev.custom && S.mode === 'beat');
  if (S.mode === 'free') {
    $('#pe-start').value = ev ? ev.start.toFixed(2) : '';
    $('#pe-len').value = ev ? (ev.end - ev.start).toFixed(2) : '';
    $('#pe-start').disabled = $('#pe-len').disabled = $('#pe-delete').disabled = !ev;
    $('#pe-add').disabled = !ready;
  }
}
function select(key, jump) {
  selectedKey = key;
  const ev = selectedEvent();
  if (jump && ev && video.paused) seek(ev.start + 0.001);
  renderEditor(); drawTimelineBase();
}
$('#pe-prev').onclick = () => { const i = events.indexOf(selectedEvent()); if (i > 0) select(events[i - 1].key, true); };
$('#pe-next').onclick = () => { const i = events.indexOf(selectedEvent()); if (i >= 0 && i < events.length - 1) select(events[i + 1].key, true); };
$('#pe-all').onclick = () => { const e = selectedEvent(); if (e) setMask(e, fullMask()); };
$('#pe-none').onclick = () => { const e = selectedEvent(); if (e) setMask(e, 0); };
$('#pe-invert').onclick = () => { const e = selectedEvent(); if (e) setMask(e, ~e.mask); };
$('#pe-reset').onclick = () => { const e = selectedEvent(); if (e && S.mode === 'beat') { overrides.delete(e.index); rebuildEvents(); } };
$('#pe-add').onclick = () => {
  if (!ready) return;
  const t = clamp(video.currentTime, 0, Math.max(0, S.duration - 0.1));
  const before = [...freeEvents].sort((a, b) => a.start - b.start).filter(e => e.start <= t).pop();
  const prevLen = before ? before.end - before.start : 1;
  // Each new pause starts with the opposite strips of the previous one.
  let mask = before ? ~before.mask & fullMask() : 0;
  if (!mask) { for (let i = 0; i < S.count; i += 2) mask |= 1 << i; }
  const ev = { id: nextId++, start: t, end: Math.min(S.duration, t + prevLen), mask };
  freeEvents.push(ev);
  selectedKey = ev.id;
  rebuildEvents();
};
$('#pe-delete').onclick = () => { const e = selectedEvent(); if (!e || S.mode !== 'free') return; freeEvents = freeEvents.filter(x => x !== e.ref); rebuildEvents(); };
function onFreeTiming() {
  const e = selectedEvent();
  if (!e || S.mode !== 'free') return;
  const start = clamp(+$('#pe-start').value || 0, 0, Math.max(0, S.duration - 0.05));
  const len = clamp(+$('#pe-len').value || 0.5, 0.05, S.duration);
  e.ref.start = start; e.ref.end = Math.min(S.duration, start + len);
  rebuildEvents();
}
$('#pe-start').onchange = onFreeTiming;
$('#pe-len').onchange = onFreeTiming;

function updateBadge() {
  $('#badge').textContent = `${S.count} ${S.dir === 0 ? 'columns' : 'rows'} · ${events.length} pause${events.length === 1 ? '' : 's'}`;
}

/* ---------- Timeline ---------- */
const tl = $('#timeline'), tlCtx = tl.getContext('2d'), tlBase = document.createElement('canvas');
function drawTimelineBase() {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(100, Math.round(tl.clientWidth * dpr)), H = Math.round(76 * dpr);
  tl.width = tlBase.width = W; tl.height = tlBase.height = H;
  const g = tlBase.getContext('2d');
  g.fillStyle = '#0d0b0b'; g.fillRect(0, 0, W, H);
  if (!(S.duration > 0)) return;
  const x = t => (t / S.duration) * W;
  const top = 8 * dpr, h = H - 26 * dpr;
  g.fillStyle = '#211c1b'; g.fillRect(0, top, W, h);
  for (const e of events) {
    const x0 = x(e.start), x1 = Math.max(x0 + 2 * dpr, x(e.end));
    g.fillStyle = e.custom && S.mode === 'beat' ? '#53f0ff' : '#ff4fa3';
    g.fillRect(x0, top, x1 - x0, h);
    // tiny strip diagram inside wide blocks
    if (x1 - x0 > 3 * S.count * dpr) {
      const sw = (x1 - x0) / S.count;
      for (let i = 0; i < S.count; i++) if (!((e.mask >> i) & 1)) { g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(x0 + i * sw, top + h * 0.55, sw - dpr, h * 0.4); }
    }
    if (e.key === selectedKey) { g.strokeStyle = '#ffffff'; g.lineWidth = 2 * dpr; g.strokeRect(x0 + dpr, top + dpr, x1 - x0 - 2 * dpr, h - 2 * dpr); }
  }
  if (S.mode === 'beat') {
    const beat = beatLen(), off = S.offsetFrac * beat, px = x(beat);
    const step = px < 3 * dpr ? Math.ceil((3 * dpr) / px / 4) * 4 : 1;
    for (let k = 0; ; k += step) {
      const t = off + k * beat;
      if (t > S.duration) break;
      const bar = k % 4 === 0;
      g.fillStyle = bar ? '#f4efeb' : '#7d716c';
      g.fillRect(x(t), H - (bar ? 16 : 9) * dpr, Math.max(1, dpr), (bar ? 16 : 9) * dpr);
    }
  }
  g.fillStyle = 'rgba(0,0,0,0.62)';
  g.fillRect(0, 0, x(S.secStart), H);
  g.fillRect(x(S.secEnd), 0, W - x(S.secEnd), H);
}
function drawTimeline(t) {
  tlCtx.drawImage(tlBase, 0, 0);
  if (!(S.duration > 0)) return;
  tlCtx.fillStyle = '#ffffff';
  tlCtx.fillRect((t / S.duration) * tl.width - 1, 0, 2 * (window.devicePixelRatio || 1), tl.height);
}
tl.addEventListener('click', e => {
  if (!(S.duration > 0) || exportJob) return;
  const rect = tl.getBoundingClientRect();
  const t = clamp(((e.clientX - rect.left) / rect.width) * S.duration, 0, S.duration - 0.05);
  const tol = (6 / rect.width) * S.duration;
  const hit = events.find(ev => t >= ev.start - tol && t <= ev.end + tol);
  if (hit) { select(hit.key, false); seek(hit.start + 0.001); }
  else seek(t);
});
window.addEventListener('resize', drawTimelineBase);

/* ---------- Frame loop ---------- */
const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
let rvfcHandle = null, newFrame = false, lastTime = -1, dirty = true;
function hookFrames() {
  if (!hasRVFC) return;
  if (rvfcHandle !== null) video.cancelVideoFrameCallback(rvfcHandle);
  const cb = (now, meta) => {
    rvfcHandle = video.requestVideoFrameCallback(cb);
    if (exportJob) exportFrame(meta.mediaTime); else newFrame = true;
  };
  rvfcHandle = video.requestVideoFrameCallback(cb);
}
const dots = [...document.querySelectorAll('#beat-dots i')];
let lastBeat = null;
function tick() {
  requestAnimationFrame(tick);
  if (!ready) { drawTimeline(0); return; }
  const t = video.currentTime;
  drawTimeline(t);
  $('#timecode').textContent = `${fmt(t)} / ${fmt(S.duration)}`;
  if (S.mode === 'beat') {
    const bi = Math.floor((t - S.offsetFrac * beatLen()) / beatLen() + 1e-6);
    if (bi !== lastBeat) {
      const inBar = ((bi % 4) + 4) % 4;
      dots.forEach((d, k) => d.classList.toggle('on', k === inBar));
      if (lastBeat !== null && !video.paused && !exportJob && $('#click-toggle').checked) click(inBar === 0);
      lastBeat = bi;
    }
  }
  if (exportJob) return;
  if (!video.paused && t >= S.secEnd - 0.03) { seek(S.secStart); return; }
  let step = false;
  if (hasRVFC) { step = newFrame; newFrame = false; }
  else if (t !== lastTime) { step = true; lastTime = t; }
  if (!step && !dirty) return;
  dirty = false;
  render(t, step);
}
requestAnimationFrame(tick);

/* ---------- Export ---------- */
const exportBtn = $('#export-btn'), cancelBtn = $('#cancel-btn'), note = $('#export-note');
exportBtn.onclick = startExport;
cancelBtn.onclick = () => finishExport(true);
function outputSize(res) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (res === 'source') return fitSize(vw, vh, 1920);
  const s = Math.min(1, +res / Math.min(vw, vh));
  return [Math.max(2, Math.round(vw * s / 2) * 2), Math.max(2, Math.round(vh * s / 2) * 2)];
}
function seekAndWait(t) {
  return new Promise(res => {
    const done = () => { video.removeEventListener('seeked', done); clearTimeout(to); res(); };
    const to = setTimeout(done, 2000);
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });
}
async function startExport() {
  if (!ready || exportJob) return;
  if (video.muted) enableSound(); // renders record the audio; unmute inside this tap
  if (typeof MediaRecorder === 'undefined') { alert('This browser does not support MediaRecorder, which is needed to render video.'); return; }
  const mime = pickMime($('#ex-format').value);
  if (!mime) { alert('No supported recording format found in this browser.'); return; }
  resumeAudio();
  const [w, h] = outputSize($('#ex-res').value);
  video.pause();
  resizeTo(w, h);
  await seekAndWait(S.secStart);
  let stream = canvas.captureStream(0);
  let vtrack = stream.getVideoTracks()[0];
  const manual = typeof vtrack.requestFrame === 'function';
  if (!manual) { vtrack.stop(); stream = canvas.captureStream(30); vtrack = stream.getVideoTracks()[0]; }
  const tracks = [vtrack];
  if (recordDest) tracks.push(recordDest.stream.getAudioTracks()[0]);
  const rec = new MediaRecorder(new MediaStream(tracks), { mimeType: mime, videoBitsPerSecond: bitrateFor(w, h, $('#ex-quality').value), audioBitsPerSecond: 192000 });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise(res => { rec.onstop = res; });
  exportJob = { rec, chunks, stopped, vtrack, manual, w, h, mime, start: S.secStart, end: S.secEnd, finishing: false };
  keepAwake().then(lock => { if (exportJob) exportJob.wake = lock; else if (lock) lock.release(); });
  document.body.classList.add('exporting');
  exportBtn.hidden = true; cancelBtn.hidden = false;
  $('#render-overlay').hidden = false;
  $('#result').hidden = true;
  note.textContent = `${w}x${h}, ${mime.split(';')[0].replace('video/', '').toUpperCase()} with the clip's audio.`;
  rec.start(1000);
  if (!hasRVFC) {
    let last = -1;
    const loop = () => { if (!exportJob || exportJob.finishing) return; if (video.currentTime !== last) { last = video.currentTime; exportFrame(last); } requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
  try { await video.play(); } catch (e) { finishExport(true); alert('Playback was blocked. Tap the page and try again.'); }
}
function exportFrame(t) {
  const job = exportJob;
  if (!job || job.finishing) return;
  render(t, true);
  if (job.manual) job.vtrack.requestFrame();
  const pct = clamp((t - job.start) / Math.max(0.01, job.end - job.start), 0, 1);
  $('#render-fill').style.width = (pct * 100).toFixed(1) + '%';
  $('#render-pct').textContent = Math.round(pct * 100) + '%';
  $('#render-sub').textContent = `${fmt(job.end - t)} left. Keep this tab visible while it renders.`;
  exportBtn.textContent = `Rendering ${Math.round(pct * 100)}%`;
  if (t >= job.end - 0.02) finishExport(false);
}
async function finishExport(cancelled) {
  const job = exportJob;
  if (!job || job.finishing) return;
  job.finishing = true;
  video.pause();
  if (job.manual) job.vtrack.requestFrame();
  await new Promise(res => setTimeout(res, 120));
  if (job.rec.state !== 'inactive') job.rec.stop();
  await job.stopped;
  job.vtrack.stop();
  if (job.wake) job.wake.release().catch(() => {});
  exportJob = null;
  document.body.classList.remove('exporting');
  exportBtn.hidden = false; cancelBtn.hidden = true;
  exportBtn.textContent = 'Process & download';
  $('#render-overlay').hidden = true;
  if (!cancelled && job.chunks.length) {
    const type = job.mime.split(';')[0];
    const name = `${fileName}_slicepause_${job.w}x${job.h}.${type.includes('mp4') ? 'mp4' : 'webm'}`;
    if (lastDownload) URL.revokeObjectURL(lastDownload);
    lastDownload = presentResult(new Blob(job.chunks, { type }), name, $('#result'));
    note.textContent = IS_IOS ? `Ready: ${name}. Tap ${$('#result button') ? 'Save video' : 'Download'} to keep it.` : `Saved ${name}.`;
  } else note.textContent = cancelled ? 'Render cancelled.' : 'Nothing was recorded. Try again with the tab in the foreground.';
  resizeTo(...fitSize(video.videoWidth, video.videoHeight, PREVIEW_LONG));
  seek(S.secStart);
  if (wantPlay) play();
}

/* ---------- Boot ---------- */
setMode('beat');
