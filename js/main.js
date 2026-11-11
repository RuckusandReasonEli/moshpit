import { Renderer } from './gl.js';
import { EFFECTS } from './effects/index.js';
import { AudioEngine, BANDS } from './audio.js';
import { pickMime, bitrateFor, downloadBlob } from './export.js';
import { GLOBAL, Grader, isNeutral } from './global.js';

const $ = s => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = t => { t = Math.max(0, t || 0); const m = Math.floor(t / 60), s = Math.floor(t % 60); return `${m}:${String(s).padStart(2, '0')}`; };
const getFx = id => EFFECTS.find(f => f.id === id);

const PREVIEW_LONG_SIDE = 960;
const GALLERY_LONG_SIDE = 400;
const WINDOW = 3;

const video = $('#video');
const viewer = $('#viewer');
const mainCanvas = $('#main-canvas');
const audio = new AudioEngine();

const state = {
  ready: false,
  fileName: 'video',
  hasAudio: undefined,
  audioOn: false,
  selected: EFFECTS[0].id,
  params: {},
  winStart: 0,
  loopMode: 'window',
  playedFor: 0,
  wantPlay: true,
};
let dirty = true, frameCount = 0, exportJob = null;
const markDirty = () => { dirty = true; };

/* ---------- Params ---------- */
const isRange = p => p.type !== 'select' && p.type !== 'color';
function defaultParams(fx) {
  const values = {}, mods = {};
  for (const p of fx.params) {
    values[p.id] = p.value;
    if (isRange(p)) mods[p.id] = p.mod ? { ...p.mod } : { band: 'none', depth: 0.5 };
  }
  return { values, mods };
}
EFFECTS.forEach(fx => { state.params[fx.id] = defaultParams(fx); });
state.params.global = defaultParams(GLOBAL);
state.globalOn = true;
state.fxOn = true;
const globalParams = () => (state.globalOn ? resolve(GLOBAL) : null);

function resolve(fx) {
  const st = state.params[fx.id], out = {};
  for (const p of fx.params) {
    let v = st.values[p.id];
    if (isRange(p)) {
      const m = st.mods[p.id];
      if (state.audioOn && m.band !== 'none') v = clamp(v + m.depth * (p.max - p.min) * (audio.levels[m.band] || 0), p.min, p.max);
    }
    out[p.id] = v;
  }
  return out;
}
const linkedBands = fx => {
  const st = state.params[fx.id];
  return new Set(Object.values(st.mods).filter(m => m.band !== 'none' && Math.abs(m.depth) > 0.001).map(m => m.band));
};

/* ---------- Renderers ---------- */
let mainR, galR;
try {
  mainR = new Renderer(mainCanvas);
  galR = new Renderer(document.createElement('canvas'));
} catch (e) {
  viewer.querySelector('.dz-inner').innerHTML = `<h2>WebGL2 is required</h2><p>${e.message} Try a recent Chrome, Edge, Firefox or Safari.</p>`;
  throw e;
}
mainR.grader = new Grader(mainR);
galR.grader = new Grader(galR);
const mainInst = new Map(), galInst = new Map();
const instance = (map, r, fx) => { if (!map.has(fx.id)) map.set(fx.id, fx.create(r)); return map.get(fx.id); };
const resetAll = () => { [...mainInst.values(), ...galInst.values()].forEach(i => i.reset()); };

function fitSize(vw, vh, longSide) {
  const s = Math.min(1, longSide / Math.max(vw, vh));
  return [Math.max(2, Math.round(vw * s / 2) * 2), Math.max(2, Math.round(vh * s / 2) * 2)];
}
function setPreviewSizes() {
  const vw = video.videoWidth, vh = video.videoHeight;
  mainR.resize(...fitSize(vw, vh, PREVIEW_LONG_SIDE));
  galR.resize(...fitSize(vw, vh, GALLERY_LONG_SIDE));
  for (const c of cards.values()) { c.canvas.width = galR.w; c.canvas.height = galR.h; }
}

/* ---------- Gallery ---------- */
const cards = new Map();
const gallery = $('#gallery');
for (const fx of EFFECTS) {
  const el = document.createElement('button');
  el.className = 'fx-card';
  el.dataset.id = fx.id;
  el.style.setProperty('--c1', fx.swatch[0]);
  el.style.setProperty('--c2', fx.swatch[1]);
  el.innerHTML = `<canvas></canvas><span class="fx-pill">EQ LINKED</span><div class="fx-meta"><h3>${fx.name}</h3><p>${fx.description}</p></div>`;
  el.addEventListener('click', () => selectEffect(fx.id));
  gallery.appendChild(el);
  const canvas = el.querySelector('canvas');
  cards.set(fx.id, { el, canvas, ctx2d: canvas.getContext('2d') });
}
let galleryVisible = true;
new IntersectionObserver(entries => { galleryVisible = entries[0].isIntersecting; }, { threshold: 0.01 }).observe(gallery);

function refreshCardPills() {
  for (const fx of EFFECTS) cards.get(fx.id).el.classList.toggle('has-links', linkedBands(fx).size > 0);
}

/* ---------- Param UI ---------- */
const paramsEl = $('#params');
let paramRows = [];
const bandOptions = `<option value="none">Off</option>` + BANDS.map(b => `<option value="${b.id}">${b.label} (${b.range})</option>`).join('');
const fmtVal = (p, v) => (p.step >= 1 ? Math.round(v) : (+v).toFixed(p.step < 0.01 ? 3 : 2));
const setFill = (input) => { const pct = ((input.value - input.min) / (input.max - input.min)) * 100; input.style.setProperty('--fill', pct + '%'); };

/** Build slider/select/color controls for any param set (an effect or Global Effects). */
function buildControls(container, def, grouped) {
  const st = state.params[def.id];
  const rows = [];
  container.innerHTML = '';
  let parent = container, group = null;
  for (const p of def.params) {
    if (grouped && p.group !== group) {
      group = p.group;
      const det = document.createElement('details');
      det.className = 'group';
      det.open = group === 'Light';
      det.innerHTML = `<summary>${group}</summary><div class="params"></div>`;
      container.appendChild(det);
      parent = det.querySelector('.params');
    }
    const row = document.createElement('div');
    row.className = 'param';
    if (p.type === 'select') {
      row.classList.add('select-param');
      row.innerHTML = `<div class="param-head"><span class="param-label">${p.label}</span></div><select>${p.options.map((o, i) => `<option value="${i}">${o}</option>`).join('')}</select>`;
      const sel = row.querySelector('select');
      sel.value = st.values[p.id];
      sel.addEventListener('change', () => { st.values[p.id] = +sel.value; afterChange(def); });
      parent.appendChild(row);
      continue;
    }
    if (p.type === 'color') {
      row.classList.add('color-param');
      row.innerHTML = `<div class="param-head"><span class="param-label">${p.label}</span><input type="color"></div>`;
      const inp = row.querySelector('input');
      inp.value = st.values[p.id];
      inp.addEventListener('input', () => { st.values[p.id] = inp.value; afterChange(def); });
      parent.appendChild(row);
      continue;
    }
    row.innerHTML = `
      <div class="param-head"><span class="param-label">${p.label}</span><span class="param-val"></span><button class="mod-btn" title="Link to an audio band">+EQ</button></div>
      <div class="slider-wrap"><input type="range" min="${p.min}" max="${p.max}" step="${p.step}"><div class="mod-ghost"></div></div>
      <div class="mod-row" hidden>
        <label>Band<select class="band">${bandOptions}</select></label>
        <label>Depth <span class="depth-val"></span><input class="depth" type="range" min="-1" max="1" step="0.01"></label>
      </div>`;
    const input = row.querySelector('input[type=range]');
    const valEl = row.querySelector('.param-val');
    const modBtn = row.querySelector('.mod-btn');
    const modRow = row.querySelector('.mod-row');
    const band = row.querySelector('.band');
    const depth = row.querySelector('.depth');
    const depthVal = row.querySelector('.depth-val');
    const ghost = row.querySelector('.mod-ghost');
    const m = st.mods[p.id];
    input.value = st.values[p.id];
    band.value = m.band;
    depth.value = m.depth;
    const sync = () => {
      valEl.textContent = fmtVal(p, st.values[p.id]);
      depthVal.textContent = (m.depth > 0 ? '+' : '') + Math.round(m.depth * 100) + '%';
      const linked = m.band !== 'none';
      modBtn.classList.toggle('linked', linked);
      modBtn.textContent = linked ? BANDS.find(b => b.id === m.band).short : '+EQ';
      row.classList.toggle('linked', linked);
      setFill(input); setFill(depth);
      refreshCardPills(); refreshEqUsage();
    };
    input.addEventListener('input', () => { st.values[p.id] = +input.value; sync(); afterChange(def); });
    input.addEventListener('dblclick', () => { st.values[p.id] = p.value; input.value = p.value; sync(); afterChange(def); });
    band.addEventListener('change', () => { m.band = band.value; sync(); });
    depth.addEventListener('input', () => { m.depth = +depth.value; sync(); });
    modBtn.addEventListener('click', () => { modRow.hidden = !modRow.hidden; });
    sync();
    parent.appendChild(row);
    rows.push({ p, ghost });
  }
  return rows;
}
function afterChange(def) { if (def.id === 'global') updateBadge(); markDirty(); }

function updateBadge() {
  const fx = getFx(state.selected);
  const g = state.globalOn && !isNeutral(resolve(GLOBAL));
  $('#effect-badge').textContent = state.fxOn ? fx.name + (g ? ' + Global' : '') : (g ? 'Global Effects only' : 'Original');
}

function buildParams() {
  const fx = getFx(state.selected);
  $('#fx-name').textContent = fx.name;
  $('#fx-desc').textContent = fx.description;
  paramRows = buildControls(paramsEl, fx, false);
  updateBadge();
}
let globalRows = [];
function buildGlobal() { globalRows = buildControls($('#global-params'), GLOBAL, true); updateBadge(); }

function updateGhosts() {
  if (!state.audioOn) return;
  for (const [def, rows] of [[getFx(state.selected), paramRows], [GLOBAL, globalRows]]) {
    const vals = resolve(def);
    for (const { p, ghost } of rows) ghost.style.left = ((vals[p.id] - p.min) / (p.max - p.min)) * 100 + '%';
  }
}

function selectEffect(id) {
  if (exportJob) return;
  state.selected = id;
  setFxOn(true);
  for (const [k, c] of cards) c.el.classList.toggle('is-selected', k === id);
  buildParams();
  const inst = mainInst.get(id);
  if (inst) inst.reset();
  markDirty();
}

$('#reset-btn').addEventListener('click', () => {
  const fx = getFx(state.selected);
  state.params[fx.id] = defaultParams(fx);
  buildParams(); markDirty();
});
$('#randomize-btn').addEventListener('click', () => {
  const fx = getFx(state.selected);
  const st = state.params[fx.id];
  for (const p of fx.params) {
    if (p.type === 'color') continue;
    if (!isRange(p)) { st.values[p.id] = Math.floor(Math.random() * p.options.length); continue; }
    const span = (p.max - p.min) * 0.5;
    let v = p.value + (Math.random() * 2 - 1) * span;
    v = Math.round(clamp(v, p.min, p.max) / p.step) * p.step;
    st.values[p.id] = +v.toFixed(4);
  }
  buildParams(); markDirty();
});

/* ---------- Effect + Global toggles ---------- */
function setFxOn(on) {
  state.fxOn = on;
  $('#fx-toggle').checked = on;
  $('#fx-block').classList.toggle('is-off', !on);
  updateBadge(); markDirty();
}
$('#fx-toggle').addEventListener('change', e => setFxOn(e.target.checked));
$('#global-toggle').addEventListener('change', e => {
  state.globalOn = e.target.checked;
  $('#global-block').classList.toggle('is-off', !state.globalOn);
  refreshEqUsage(); updateBadge(); markDirty();
});
$('#global-reset').addEventListener('click', () => { state.params.global = defaultParams(GLOBAL); buildGlobal(); markDirty(); });

/* ---------- EQ meters ---------- */
const eqEl = $('#eq');
const eqFills = {};
for (const b of BANDS) {
  const el = document.createElement('div');
  el.className = 'eq-band';
  el.dataset.band = b.id;
  el.title = `${b.label}: ${b.range}`;
  el.innerHTML = `<div class="eq-bar"><div class="eq-fill"></div></div><span>${b.short}</span>`;
  eqEl.appendChild(el);
  eqFills[b.id] = el.querySelector('.eq-fill');
}
function refreshEqUsage() {
  const used = new Set([...linkedBands(getFx(state.selected)), ...(state.globalOn ? linkedBands(GLOBAL) : [])]);
  eqEl.querySelectorAll('.eq-band').forEach(el => el.classList.toggle('used', used.has(el.dataset.band)));
}
function updateMeters() {
  for (const b of BANDS) eqFills[b.id].style.transform = `scaleY(${audio.levels[b.id].toFixed(3)})`;
}

/* ---------- Audio controls ---------- */
const audioToggle = $('#audio-toggle');
function setAudioOn(on) {
  state.audioOn = on && state.hasAudio === true;
  audioToggle.checked = state.audioOn;
  document.body.classList.toggle('audio-on', state.audioOn);
  document.body.classList.toggle('audio-off', !state.audioOn);
  markDirty();
}
audioToggle.addEventListener('change', () => { audio.resume(); setAudioOn(audioToggle.checked); });
setAudioOn(false);

function setHasAudio(v) {
  if (state.hasAudio === v) return;
  state.hasAudio = v;
  const status = $('#audio-status');
  if (v === true) { status.textContent = 'Audio track detected. Turn this on to drive effects with the EQ.'; audioToggle.disabled = false; }
  else if (v === false) { status.textContent = 'No audio track found in this video, so reactivity is unavailable.'; audioToggle.disabled = true; setAudioOn(false); }
  else { status.textContent = 'Listening for an audio track...'; audioToggle.disabled = true; }
}
function detectAudio() {
  if (typeof video.mozHasAudio === 'boolean') return video.mozHasAudio;
  if (video.audioTracks && typeof video.audioTracks.length === 'number') return video.audioTracks.length > 0;
  if (typeof video.webkitAudioDecodedByteCount === 'number' && video.webkitAudioDecodedByteCount > 0) return true;
  return null;
}

const rangeIn = $('#audio-range'), smoothIn = $('#audio-smooth');
rangeIn.addEventListener('input', () => { audio.range = +rangeIn.value; $('#audio-range-val').textContent = rangeIn.value + ' dB'; setFill(rangeIn); });
smoothIn.addEventListener('input', () => { audio.smoothing = +smoothIn.value; $('#audio-smooth-val').textContent = Math.round(smoothIn.value * 100) + '%'; setFill(smoothIn); });
$('#audio-agc').addEventListener('change', e => { audio.autoGain = e.target.checked; audio.peak = {}; });
setFill(rangeIn); setFill(smoothIn);

const volIn = $('#volume'), muteBtn = $('#mute-btn');
let muted = false;
const applyVolume = () => { audio.setVolume(muted ? 0 : +volIn.value); muteBtn.classList.toggle('muted', muted || +volIn.value === 0); setFill(volIn); };
volIn.addEventListener('input', () => { muted = false; applyVolume(); });
muteBtn.addEventListener('click', () => { muted = !muted; applyVolume(); });
setFill(volIn);

/* ---------- Loading ---------- */
let objectUrl = null;
const fileInput = $('#file-input');
fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); fileInput.value = ''; });
['dragenter', 'dragover'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); $('#dropzone').classList.add('drag'); }));
['dragleave', 'drop'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); $('#dropzone').classList.remove('drag'); }));
document.addEventListener('drop', e => { const f = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|m4v)$/i.test(f.name)); if (f) loadFile(f); });

async function loadFile(file) {
  if (exportJob) return;
  state.ready = false;
  state.fileName = file.name.replace(/\.[^.]+$/, '') || 'video';
  $('#file-chip').hidden = false;
  $('#file-chip').textContent = file.name;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  audio.attach(video);
  audio.resume();
  setHasAudio(null);
  state.playedFor = 0;
  video.src = objectUrl;
  video.loop = false;
  try {
    await new Promise((res, rej) => { video.onloadeddata = res; video.onerror = () => rej(new Error('This browser cannot decode that video.')); });
  } catch (e) {
    alert(e.message + ' Try an H.264 MP4 or a WebM file.');
    return;
  }
  setPreviewSizes();
  resetAll();
  state.winStart = 0;
  const startIn = $('#window-start');
  startIn.max = Math.max(0, video.duration - WINDOW);
  startIn.value = 0;
  startIn.disabled = !(video.duration > WINDOW);
  setFill(startIn);
  updateWindowLabel();
  viewer.classList.add('has-video');
  cards.forEach(c => c.el.classList.add('live'));
  $('#play-btn').disabled = false;
  $('#export-btn').disabled = false;
  state.ready = true;
  hookFrames();
  applyVolume();
  state.wantPlay = true;
  play();
}

/* ---------- Playback ---------- */
const playBtn = $('#play-btn'), playOverlay = $('#play-overlay');
async function play() {
  await audio.resume();
  try {
    await video.play();
    playOverlay.hidden = true;
  } catch (e) {
    playOverlay.hidden = false;
  }
  syncPlayBtn();
}
function syncPlayBtn() { playBtn.classList.toggle('paused', video.paused); }
playOverlay.addEventListener('click', () => { state.wantPlay = true; play(); });
playBtn.addEventListener('click', () => {
  if (video.paused) { state.wantPlay = true; play(); } else { state.wantPlay = false; video.pause(); syncPlayBtn(); }
});
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement.tagName) && state.ready && !exportJob) { e.preventDefault(); playBtn.click(); }
});
document.addEventListener('pointerdown', () => audio.resume(), { passive: true });
video.addEventListener('pause', syncPlayBtn);
video.addEventListener('play', syncPlayBtn);

function loopBounds() {
  if (state.loopMode === 'full' || !(video.duration > WINDOW)) return [0, video.duration || 0];
  return [state.winStart, Math.min(video.duration, state.winStart + WINDOW)];
}
function updateWindowLabel() {
  const [a, b] = loopBounds();
  $('#window-label').textContent = `${fmt(a)} to ${fmt(b)}${state.loopMode === 'full' ? ' (full)' : ''}`;
}
$('#window-start').addEventListener('input', e => {
  state.winStart = +e.target.value;
  setFill(e.target);
  updateWindowLabel();
  if (state.loopMode === 'window') video.currentTime = state.winStart;
});
document.querySelectorAll('.seg-btn').forEach(b => b.addEventListener('click', () => {
  state.loopMode = b.dataset.loop;
  document.querySelectorAll('.seg-btn').forEach(x => x.classList.toggle('is-on', x === b));
  $('#window-start').disabled = state.loopMode === 'full' || !(video.duration > WINDOW);
  updateWindowLabel();
  if (state.ready) video.currentTime = loopBounds()[0];
}));
video.addEventListener('ended', () => {
  if (exportJob) { finishExport(false); return; }
  video.currentTime = loopBounds()[0];
  if (state.wantPlay) play();
});

/* ---------- Frame scheduling ---------- */
const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
let rvfcHandle = null, newFrame = false, lastTime = -1;
function hookFrames() {
  if (!hasRVFC) return;
  if (rvfcHandle !== null) video.cancelVideoFrameCallback(rvfcHandle);
  const cb = (now, meta) => {
    rvfcHandle = video.requestVideoFrameCallback(cb);
    if (exportJob) exportFrame(meta.mediaTime);
    else newFrame = true;
  };
  rvfcHandle = video.requestVideoFrameCallback(cb);
}

function renderPreview(step, dt) {
  const t = video.currentTime;
  const fx = getFx(state.selected);
  const ctx = { step, time: t, frame: frameCount, dt };
  const gp = globalParams();
  mainR.time = t; mainR.frameIndex = frameCount; mainR.gradeParams = gp;
  if (step) mainR.upload(video, video.videoWidth, video.videoHeight);
  else mainR.regrade();
  if (mainR.hasFrame) {
    if (state.fxOn) instance(mainInst, mainR, fx).render(resolve(fx), ctx, null);
    else mainR.blit(mainR.cur, null);
  }
  if (galleryVisible && (step || galR.hasFrame)) {
    galR.time = t; galR.frameIndex = frameCount; galR.gradeParams = gp;
    if (step) galR.upload(video, video.videoWidth, video.videoHeight);
    else galR.regrade();
    for (const g of EFFECTS) {
      instance(galInst, galR, g).render(resolve(g), ctx, null);
      cards.get(g.id).ctx2d.drawImage(galR.canvas, 0, 0);
    }
  }
}

let lastNow = performance.now();
function tick(now) {
  requestAnimationFrame(tick);
  const dt = Math.min(0.1, (now - lastNow) / 1000);
  lastNow = now;
  if (!state.ready) return;
  if (!exportJob) audio.update(dt);
  updateMeters();
  updateGhosts();
  if (exportJob) return;

  if (!video.paused) {
    state.playedFor += dt;
    const [, end] = loopBounds();
    if (video.currentTime >= end - 0.03) video.currentTime = loopBounds()[0];
    if (state.hasAudio !== true) {
      const d = detectAudio();
      if (d === true || audio.signal) setHasAudio(true);
      else if (d === false || state.playedFor > 2.5) setHasAudio(false);
    }
  } else if (state.hasAudio === false && audio.signal) setHasAudio(true);

  // Playhead
  const dur = video.duration || 1;
  $('#playhead').style.left = (video.currentTime / dur) * 100 + '%';

  let step = false;
  if (hasRVFC) { step = newFrame; newFrame = false; }
  else if (video.currentTime !== lastTime) { step = true; lastTime = video.currentTime; }
  if (!step && !dirty) return;
  dirty = false;
  if (step) frameCount++;
  renderPreview(step, dt);
}
requestAnimationFrame(tick);

/* ---------- Export ---------- */
let lastDownload = null;
const exportBtn = $('#export-btn'), cancelBtn = $('#cancel-btn'), note = $('#export-note');

function outputSize(res) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (res === 'source') return fitSize(vw, vh, 1920);
  const short = +res;
  const s = Math.min(1, short / Math.min(vw, vh));
  return [Math.max(2, Math.round(vw * s / 2) * 2), Math.max(2, Math.round(vh * s / 2) * 2)];
}
function seek(t) {
  return new Promise(res => {
    const done = () => { video.removeEventListener('seeked', done); clearTimeout(to); res(); };
    const to = setTimeout(done, 2000);
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });
}

exportBtn.addEventListener('click', startExport);
cancelBtn.addEventListener('click', () => finishExport(true));

async function startExport() {
  if (!state.ready || exportJob) return;
  if (typeof MediaRecorder === 'undefined') { alert('This browser does not support MediaRecorder, which is needed to render video.'); return; }
  const fx = getFx(state.selected);
  const res = $('#ex-res').value, quality = $('#ex-quality').value, range = $('#ex-range').value, format = $('#ex-format').value;
  const mime = pickMime(format);
  if (!mime) { alert('No supported recording format found in this browser.'); return; }
  await audio.resume();

  const [w, h] = outputSize(res);
  const [ws, we] = loopBounds();
  const start = range === 'window' ? ws : 0;
  const end = range === 'window' ? we : video.duration;

  video.pause();
  mainR.resize(w, h);
  const inst = instance(mainInst, mainR, fx);
  inst.reset();
  await seek(start);

  let stream = mainCanvas.captureStream(0);
  let vtrack = stream.getVideoTracks()[0];
  const manual = typeof vtrack.requestFrame === 'function';
  if (!manual) { vtrack.stop(); stream = mainCanvas.captureStream(30); vtrack = stream.getVideoTracks()[0]; }
  const tracks = [vtrack];
  const withAudio = state.hasAudio === true && audio.recordTrack;
  if (withAudio) tracks.push(audio.recordTrack);
  const rec = new MediaRecorder(new MediaStream(tracks), {
    mimeType: mime, videoBitsPerSecond: bitrateFor(w, h, quality), audioBitsPerSecond: 192000,
  });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise(r => { rec.onstop = r; });

  exportJob = { fx, inst, rec, chunks, stopped, vtrack, manual, start, end, w, h, mime, lastT: performance.now(), t0: performance.now(), finishing: false };
  document.body.classList.add('exporting');
  exportBtn.hidden = true; cancelBtn.hidden = false;
  $('#render-overlay').hidden = false;
  $('#download-again').hidden = true;
  note.textContent = `${w}x${h}, ${mime.split(';')[0].replace('video/', '').toUpperCase()}${withAudio ? ' with audio' : ''}. You can still tweak sliders while it renders.`;
  setRenderProgress(0, end - start);

  rec.start(1000);
  if (!hasRVFC) {
    let last = -1;
    const loop = () => {
      if (!exportJob || exportJob.finishing) return;
      if (video.currentTime !== last) { last = video.currentTime; exportFrame(last); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  try { await video.play(); } catch (e) { finishExport(true); alert('Playback was blocked. Click anywhere on the page and try again.'); }
}

function exportFrame(mediaTime) {
  const job = exportJob;
  if (!job || job.finishing) return;
  const now = performance.now();
  const dt = (now - job.lastT) / 1000;
  job.lastT = now;
  audio.update(dt);
  frameCount++;
  mainR.time = mediaTime; mainR.frameIndex = frameCount; mainR.gradeParams = globalParams();
  mainR.upload(video, video.videoWidth, video.videoHeight);
  if (state.fxOn) job.inst.render(resolve(job.fx), { step: true, time: mediaTime, frame: frameCount, dt }, null);
  else mainR.blit(mainR.cur, null);
  if (job.manual) job.vtrack.requestFrame();
  setRenderProgress(mediaTime - job.start, job.end - job.start);
  if (mediaTime >= job.end - 0.02) finishExport(false);
}

function setRenderProgress(done, total) {
  const pct = clamp(done / Math.max(0.001, total), 0, 1);
  $('#render-fill').style.width = (pct * 100).toFixed(1) + '%';
  $('#render-pct').textContent = Math.round(pct * 100) + '%';
  $('#render-sub').textContent = `${fmt(total - done)} left. Keep this tab visible while it renders.`;
  exportBtn.textContent = `Rendering ${Math.round(pct * 100)}%`;
}

async function finishExport(cancelled) {
  const job = exportJob;
  if (!job || job.finishing) return;
  job.finishing = true;
  video.pause();
  if (job.manual) job.vtrack.requestFrame();
  await new Promise(r => setTimeout(r, 120));
  if (job.rec.state !== 'inactive') job.rec.stop();
  await job.stopped;
  job.vtrack.stop();
  exportJob = null;
  document.body.classList.remove('exporting');
  exportBtn.hidden = false; cancelBtn.hidden = true;
  exportBtn.textContent = 'Process & download';
  $('#render-overlay').hidden = true;

  if (!cancelled && job.chunks.length) {
    const type = job.mime.split(';')[0];
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(job.chunks, { type });
    const tag = state.fxOn ? job.fx.id : 'global';
    const name = `${state.fileName}_${tag}_${job.w}x${job.h}.${ext}`;
    if (lastDownload) URL.revokeObjectURL(lastDownload);
    lastDownload = downloadBlob(blob, name);
    const again = $('#download-again');
    again.href = lastDownload; again.download = name; again.hidden = false;
    again.textContent = `Download again (${(blob.size / 1e6).toFixed(1)} MB)`;
    note.textContent = `Saved ${name}.`;
  } else {
    note.textContent = cancelled ? 'Render cancelled.' : 'Nothing was recorded. Try again with the tab in the foreground.';
  }

  setPreviewSizes();
  resetAll();
  markDirty();
  video.currentTime = loopBounds()[0];
  if (state.wantPlay) play();
}

/* ---------- Boot ---------- */
buildGlobal();
selectEffect(state.selected);
refreshCardPills();
refreshEqUsage();
