import { Renderer, FS_IO } from '../gl.js';
import { pickMime, bitrateFor, presentResult } from '../export.js';
import { IS_IOS, IS_MOBILE, keepAwake, waitForMetadata, usePlaybackAudioSession } from '../mobile.js';
import { buildSchedule, findSegment } from './schedule.js';
import { detectBeats, TapTempo } from './beat.js';

const $ = s => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = t => { t = Math.max(0, t || 0); const m = Math.floor(t / 60); return `${m}:${(t % 60).toFixed(1).padStart(4, '0')}`; };
const setFill = el => el.style.setProperty('--fill', ((el.value - el.min) / (el.max - el.min)) * 100 + '%');

const MAX_CLIPS = 5;
const COLORS = ['#ff4fa3', '#53f0ff', '#ffb14f', '#9dff7a', '#a98bff'];
const PREVIEW_LONG = IS_MOBILE ? 720 : 960;

/* ---------- State ---------- */
const S = {
  bpm: 120, offsetFrac: 0, every: 1, randomness: 0, order: 'random', jump: 'jump',
  overlap: 0, blend: 1, aspect: 'auto', punch: 0, flash: 0, seed: 1337,
  secStart: 0, secEnd: 0, total: 0, soundtrack: 'none', song: null,
};
const clips = [];
let segs = [];
let curSeg = -1;
let exportJob = null;
let lastDownload = null;
const beatLen = () => 60 / S.bpm;
const offsetSec = () => S.offsetFrac * beatLen();

/* ---------- GL ---------- */
const canvas = $('#cut-canvas');
const r = new Renderer(canvas, { preserve: IS_IOS });
const gl = r.gl;
const COMP_FS = FS_IO + /* glsl */ `
uniform sampler2D uAccum, uLayer;
uniform float uWeight, uMode, uZoom;
uniform vec2 uCover;
void main() {
  vec3 a = texture(uAccum, vUv).rgb;
  vec2 luv = (vUv - 0.5) * uCover / uZoom + 0.5;
  vec3 l = texture(uLayer, luv).rgb;
  vec3 b;
  if (uMode < 0.5) b = l;
  else if (uMode < 1.5) b = 1.0 - (1.0 - a) * (1.0 - l);
  else if (uMode < 2.5) b = min(a + l, 1.0);
  else if (uMode < 3.5) b = abs(a - l);
  else b = a * l;
  outColor = vec4(mix(a, b, clamp(uWeight, 0.0, 1.0)), 1.0);
}`;
const FINAL_FS = FS_IO + `uniform sampler2D uTex; uniform float uFlash;
void main() { vec3 c = texture(uTex, vUv).rgb; outColor = vec4(mix(c, vec3(1.0), uFlash), 1.0); }`;
const compProg = r.fx(COMP_FS);
const finalProg = r.fx(FINAL_FS);
let accum = null;

function makeClipTex() {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  return t;
}
function uploadClip(c) {
  if (c.video.readyState < 2) return;
  gl.bindTexture(gl.TEXTURE_2D, c.tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c.video);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
}

function frameAspect() {
  if (S.aspect !== 'auto') return +S.aspect;
  const c = clips[0];
  return c ? c.video.videoWidth / c.video.videoHeight : 16 / 9;
}
function sizeFor(shortSide, longCap) {
  const a = frameAspect();
  let w, h;
  if (longCap) { if (a >= 1) { w = longCap; h = longCap / a; } else { h = longCap; w = longCap * a; } }
  else if (a >= 1) { h = shortSide; w = shortSide * a; } else { w = shortSide; h = shortSide / a; }
  return [Math.max(2, Math.round(w / 2) * 2), Math.max(2, Math.round(h / 2) * 2)];
}
function resizeTo(w, h) {
  r.resize(w, h);
  if (accum) accum.dispose();
  accum = r.pingpong(w, h);
}
resizeTo(...sizeFor(0, PREVIEW_LONG));

/* ---------- Audio ---------- */
const audioEl = $('#soundtrack-el');
let actx = null, monitor = null, recordDest = null, bus = null;
// Everything audible goes through one bus: the soundtrack element (single clip
// or song) and, in the mix modes, a gain per clip driven by the edit.
function ensureAudio() {
  if (actx) return;
  usePlaybackAudioSession();
  actx = new (window.AudioContext || window.webkitAudioContext)();
  bus = actx.createGain();
  monitor = actx.createGain();
  recordDest = actx.createMediaStreamDestination();
  actx.createMediaElementSource(audioEl).connect(bus);
  bus.connect(monitor); monitor.connect(actx.destination);
  bus.connect(recordDest);
  clips.forEach(attachClipAudio);
  applyVolume();
}
function attachClipAudio(c) {
  if (!actx || c.gain) return;
  c.gain = actx.createGain();
  c.gain.gain.value = 0;
  c.lastGain = 0;
  actx.createMediaElementSource(c.video).connect(c.gain);
  c.gain.connect(bus);
}
const isMix = () => S.soundtrack === 'mix-cuts' || S.soundtrack === 'mix-all';
const usesElement = () => S.soundtrack === 'song' || S.soundtrack.startsWith('clip:');
const resumeAudio = async () => { if (actx && actx.state !== 'running') { try { await actx.resume(); } catch (e) { /* needs gesture */ } } };
document.addEventListener('pointerdown', () => { ensureAudio(); resumeAudio(); }, { passive: true });

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

/* ---------- Master clock ---------- */
const silent = { playing: false, base: 0, t0: 0 };
const master = {
  get audio() { return usesElement() && audioEl.readyState >= 1; },
  now() { return this.audio ? audioEl.currentTime : (silent.playing ? silent.base + (performance.now() - silent.t0) / 1000 : silent.base); },
  get playing() { return this.audio ? !audioEl.paused : silent.playing; },
  // Everything that starts media happens synchronously first, inside the tap
  // (iOS only allows playback that starts in the gesture itself).
  async play() {
    ensureAudio();
    syncClips(this.now(), true);
    const started = this.audio ? audioEl.play() : null;
    if (!this.audio && !silent.playing) { silent.t0 = performance.now(); silent.playing = true; }
    resumeAudio();
    if (started) await started;
  },
  pause() {
    if (this.audio) audioEl.pause();
    else if (silent.playing) { silent.base = this.now(); silent.playing = false; }
    clips.forEach(c => c.video.pause());
  },
  seek(t) {
    if (this.audio) audioEl.currentTime = t;
    silent.base = t; silent.t0 = performance.now();
    curSeg = -1;
    syncClips(t, this.playing);
  },
};
function syncClips(t, play) {
  for (const c of clips) {
    if (S.jump === 'continuous') c.video.currentTime = t % Math.max(0.1, c.duration);
    if (play) c.video.play().catch(() => {});
  }
}

/* ---------- Clips ---------- */
const videoBox = document.createElement('div');
videoBox.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0;pointer-events:none;overflow:hidden';
document.body.appendChild(videoBox);
let nextId = 1;

async function addClip(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  Object.assign(video, { muted: true, playsInline: true, loop: true, preload: 'auto', src: url });
  video.setAttribute('playsinline', '');
  videoBox.appendChild(video);
  try {
    await waitForMetadata(video); // iOS won't fire loadeddata until playback starts
    video.play().catch(() => {});  // muted clips may start without a tap; frames arrive once it does
  } catch (e) {
    alert(`This browser can't decode ${file.name}. Try an H.264 MP4 or WebM.`);
    video.remove(); URL.revokeObjectURL(url);
    return;
  }
  clips.push({
    id: nextId++, file, url, video, name: file.name, tex: makeClipTex(),
    opacity: 1, volume: 1, enabled: true, duration: video.duration || 1,
  });
  const c = clips[clips.length - 1];
  attachClipAudio(c);
  c.video.muted = !isMix();
}

async function addFiles(files) {
  ensureAudio();
  const vids = [...files].filter(f => f.type.startsWith('video/') || /\.(mp4|mov|webm|m4v|mkv)$/i.test(f.name));
  const room = MAX_CLIPS - clips.length;
  if (vids.length > room) alert(`Beat Cut holds ${MAX_CLIPS} clips, so only the first ${Math.max(0, room)} were added.`);
  for (const f of vids.slice(0, Math.max(0, room))) await addClip(f);
  afterClipsChanged();
  if (clips.length && !master.playing) master.play().then(() => { $('#play-overlay').hidden = true; syncPlay(); }).catch(() => { $('#play-overlay').hidden = false; });
}

function removeClip(i) {
  if (exportJob) return;
  const [c] = clips.splice(i, 1);
  c.video.pause(); c.video.remove(); URL.revokeObjectURL(c.url); gl.deleteTexture(c.tex);
  if (c.gain) c.gain.disconnect();
  if (S.soundtrack === 'clip:' + c.id) setSoundtrack('none');
  afterClipsChanged();
}

function afterClipsChanged() {
  const has = clips.length > 0;
  $('#viewer').classList.toggle('has-video', has);
  $('#render-jump').hidden = !has;
  $('#play-btn').disabled = !has;
  $('#export-btn').disabled = !has;
  if (!exportJob) resizeTo(...sizeFor(0, PREVIEW_LONG));
  renderSlots();
  renderSoundtrackOptions();
  updateTotal();
}

/* ---------- Slots UI ---------- */
const slotsEl = $('#slots');
function renderSlots() {
  slotsEl.innerHTML = '';
  clips.forEach((c, i) => {
    c.color = COLORS[i];
    const el = document.createElement('div');
    el.className = 'slot' + (c.enabled ? '' : ' off');
    el.style.setProperty('--clip', c.color);
    el.innerHTML = `
      <div class="slot-thumb"><canvas width="192" height="120"></canvas><span class="slot-num">${i + 1}</span><button class="slot-remove" title="Remove clip">×</button></div>
      <div class="slot-body">
        <div class="slot-name" title="${c.name}">${c.name}</div>
        <div class="slot-meta"><span>${fmt(c.duration)}</span><label><input type="checkbox" ${c.enabled ? 'checked' : ''}> In rotation</label></div>
        <div><div class="slot-op"><span>Opacity</span><span class="op-val">${Math.round(c.opacity * 100)}%</span></div>
        <input type="range" class="op-in" min="0" max="1" step="0.01" value="${c.opacity}"></div>
        <div class="slot-vol"><div class="slot-op"><span>Volume</span><span class="vol-val">${Math.round(c.volume * 100)}%</span></div>
        <input type="range" class="vol-in" min="0" max="1.5" step="0.01" value="${c.volume}"></div>
      </div>`;
    el.querySelector('.slot-remove').onclick = () => removeClip(i);
    el.querySelector('input[type=checkbox]').onchange = e => { c.enabled = e.target.checked; el.classList.toggle('off', !c.enabled); rebuild(); };
    const vol = el.querySelector('.vol-in');
    vol.style.setProperty('accent-color', c.color);
    setFill(vol);
    vol.oninput = () => { c.volume = +vol.value; el.querySelector('.vol-val').textContent = Math.round(c.volume * 100) + '%'; setFill(vol); };
    const op = el.querySelector('.op-in');
    op.style.setProperty('accent-color', c.color);
    setFill(op);
    op.oninput = () => { c.opacity = +op.value; el.querySelector('.op-val').textContent = Math.round(c.opacity * 100) + '%'; setFill(op); };
    c.el = el;
    c.thumb = el.querySelector('canvas').getContext('2d');
    drawThumb(c);
    slotsEl.appendChild(el);
  });
  if (clips.length < MAX_CLIPS) {
    const add = document.createElement('label');
    add.className = 'slot empty';
    add.htmlFor = 'clip-input';
    add.innerHTML = `<div><b>+</b>Add clip ${clips.length + 1} of ${MAX_CLIPS}</div>`;
    slotsEl.appendChild(add);
  }
}
function drawThumb(c) {
  if (!c.thumb || c.video.readyState < 2) return;
  const cw = 192, ch = 120, a = c.video.videoWidth / c.video.videoHeight;
  let w = cw, h = cw / a;
  if (h < ch) { h = ch; w = ch * a; }
  c.thumb.drawImage(c.video, (cw - w) / 2, (ch - h) / 2, w, h);
}

/* ---------- Soundtrack ---------- */
const stSel = $('#soundtrack');
function renderSoundtrackOptions() {
  const opts = [`<option value="none">No audio</option>`];
  if (clips.length) {
    opts.push(`<option value="mix-cuts">Mix all clips (follows the cuts)</option>`);
    opts.push(`<option value="mix-all">Mix all clips (all at once)</option>`);
  }
  clips.forEach((c, i) => opts.push(`<option value="clip:${c.id}">Clip ${i + 1} audio: ${c.name}</option>`));
  if (S.song) opts.push(`<option value="song">Song: ${S.song.name}</option>`);
  stSel.innerHTML = opts.join('');
  stSel.value = S.soundtrack;
  $('#detect-btn').disabled = S.soundtrack === 'none';
  document.body.classList.toggle('mix-audio', isMix());
}
function soundtrackFile() {
  if (S.soundtrack === 'song') return S.song;
  if (isMix()) return clips[0] ? clips[0].file : null; // beat detection listens to clip 1
  const c = clips.find(c => 'clip:' + c.id === S.soundtrack);
  return c ? c.file : null;
}
let stUrl = null;
async function setSoundtrack(v) {
  const wasPlaying = master.playing;
  master.pause();
  S.soundtrack = v;
  if (stUrl) { URL.revokeObjectURL(stUrl); stUrl = null; }
  ensureAudio();
  clips.forEach(c => { c.video.muted = !isMix(); });
  const f = usesElement() ? soundtrackFile() : null;
  if (isMix()) { audioEl.removeAttribute('src'); audioEl.load(); }
  else if (f) {
    ensureAudio();
    stUrl = URL.createObjectURL(f);
    audioEl.src = stUrl;
    try {
      await new Promise((res, rej) => { audioEl.onloadedmetadata = res; audioEl.onerror = rej; });
    } catch (e) {
      alert("Couldn't read audio from that file.");
      S.soundtrack = 'none';
      audioEl.removeAttribute('src'); audioEl.load();
    }
  } else { S.soundtrack = 'none'; audioEl.removeAttribute('src'); audioEl.load(); }
  if (S.soundtrack === 'none' || usesElement()) clips.forEach(c => setClipGain(c, 0));
  renderSoundtrackOptions();
  updateTotal(true);
  master.seek(S.secStart);
  if (wasPlaying) master.play().then(() => { $('#play-overlay').hidden = true; }).catch(() => { $('#play-overlay').hidden = false; syncPlay(); });
}
stSel.onchange = () => setSoundtrack(stSel.value);
$('#song-input').onchange = e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  S.song = f;
  setSoundtrack('song');
};

/* ---------- Timeline length & section ---------- */
const secStartIn = $('#sec-start'), secEndIn = $('#sec-end');
function updateTotal(resetSection) {
  const prevTotal = S.total;
  S.total = usesElement() && isFinite(audioEl.duration) ? audioEl.duration : Math.max(0, ...clips.map(c => c.duration));
  if (resetSection || S.secEnd === 0 || Math.abs(S.secEnd - prevTotal) < 0.05 || S.secEnd > S.total) S.secEnd = S.total;
  if (resetSection || S.secStart >= S.secEnd) S.secStart = 0;
  secStartIn.max = secEndIn.max = S.total.toFixed(1);
  secStartIn.value = S.secStart.toFixed(1);
  secEndIn.value = S.secEnd.toFixed(1);
  updateSectionLabel();
  rebuild();
}
function updateSectionLabel() { $('#sec-len').textContent = `${(S.secEnd - S.secStart).toFixed(1)}s of ${S.total.toFixed(1)}s`; }
function onSectionInput() {
  S.secStart = clamp(+secStartIn.value || 0, 0, Math.max(0, S.total - 0.5));
  S.secEnd = clamp(+secEndIn.value || S.total, S.secStart + 0.5, S.total);
  updateSectionLabel();
  drawTimelineBase();
  const t = master.now();
  if (t < S.secStart || t > S.secEnd) master.seek(S.secStart);
}
secStartIn.onchange = onSectionInput;
secEndIn.onchange = onSectionInput;

/* ---------- Schedule ---------- */
function rebuild() {
  const rotation = clips.map((c, i) => (c.enabled ? i : -1)).filter(i => i >= 0);
  segs = buildSchedule({
    duration: S.total, bpm: S.bpm, offset: offsetSec(), every: S.every, randomness: S.randomness,
    order: S.order, clips: rotation, seed: S.seed,
  });
  curSeg = -1;
  $('#beat-badge').textContent = `${S.bpm.toFixed(S.bpm % 1 ? 1 : 0)} BPM`;
  drawTimelineBase();
}

/* ---------- Timeline drawing ---------- */
const tl = $('#timeline');
const tlCtx = tl.getContext('2d');
const tlBase = document.createElement('canvas');
function drawTimelineBase() {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(100, Math.round(tl.clientWidth * dpr)), H = Math.round(76 * dpr);
  tl.width = tlBase.width = W; tl.height = tlBase.height = H;
  const g = tlBase.getContext('2d');
  g.fillStyle = '#0d0b0b'; g.fillRect(0, 0, W, H);
  if (!(S.total > 0)) return;
  const x = t => (t / S.total) * W;
  const top = 8 * dpr, segH = H - 26 * dpr;
  for (const s of segs) {
    const c = clips[s.clip];
    if (!c || s.end < 0) continue;
    const x0 = Math.max(0, x(s.start)), x1 = Math.min(W, x(s.end));
    g.fillStyle = COLORS[s.clip];
    g.globalAlpha = 0.85 * (0.35 + 0.65 * c.opacity);
    g.fillRect(x0 + 0.5 * dpr, top, Math.max(1, x1 - x0 - 1 * dpr), segH);
  }
  g.globalAlpha = 1;
  const beat = beatLen();
  const px = x(beat);
  const step = px < 3 * dpr ? Math.ceil((3 * dpr) / px / 4) * 4 : 1;
  const first = Math.ceil((0 - offsetSec()) / beat);
  for (let k = first; ; k += step) {
    const t = offsetSec() + k * beat;
    if (t > S.total) break;
    if (t < 0) continue;
    const bar = ((k % 4) + 4) % 4 === 0;
    g.fillStyle = bar ? '#f4efeb' : '#7d716c';
    g.fillRect(x(t), H - (bar ? 16 : 9) * dpr, Math.max(1, dpr), (bar ? 16 : 9) * dpr);
  }
  g.fillStyle = 'rgba(0,0,0,0.62)';
  g.fillRect(0, 0, x(S.secStart), H);
  g.fillRect(x(S.secEnd), 0, W - x(S.secEnd), H);
  g.fillStyle = '#ff4fa3';
  g.fillRect(x(S.secStart), 0, 2 * dpr, H);
  g.fillRect(x(S.secEnd) - 2 * dpr, 0, 2 * dpr, H);
}
function drawTimeline(t) {
  tlCtx.drawImage(tlBase, 0, 0);
  if (!(S.total > 0)) return;
  const px = (t / S.total) * tl.width;
  tlCtx.fillStyle = '#ffffff';
  tlCtx.fillRect(px - 1, 0, 2 * (window.devicePixelRatio || 1), tl.height);
}
tl.addEventListener('click', e => {
  if (!(S.total > 0) || exportJob) return;
  const rect = tl.getBoundingClientRect();
  master.seek(clamp(((e.clientX - rect.left) / rect.width) * S.total, 0, S.total - 0.05));
});
window.addEventListener('resize', drawTimelineBase);

/* ---------- Controls ---------- */
const bpmIn = $('#bpm');
function setBpm(v, fromInput) {
  S.bpm = clamp(+v || 120, 40, 300);
  if (!fromInput) bpmIn.value = +S.bpm.toFixed(1);
  updateOffsetLabel();
  rebuild();
}
bpmIn.onchange = () => setBpm(bpmIn.value, false);
$('#half-btn').onclick = () => setBpm(S.bpm / 2);
$('#double-btn').onclick = () => setBpm(S.bpm * 2);

const offsetIn = $('#offset');
function updateOffsetLabel() { $('#offset-val').textContent = Math.round(offsetSec() * 1000) + ' ms'; setFill(offsetIn); }
offsetIn.oninput = () => { S.offsetFrac = +offsetIn.value; updateOffsetLabel(); rebuild(); };

const tapper = new TapTempo();
$('#tap-btn').onclick = e => {
  const bpm = tapper.tap();
  const btn = e.currentTarget;
  btn.classList.add('flash'); setTimeout(() => btn.classList.remove('flash'), 90);
  if (!bpm) { $('#tempo-status').textContent = 'Keep tapping on the beat...'; return; }
  setBpm(bpm);
  if (master.playing && tapper.taps.length >= 4) {
    S.offsetFrac = ((master.now() % beatLen()) + beatLen()) % beatLen() / beatLen();
    offsetIn.value = S.offsetFrac; updateOffsetLabel(); rebuild();
  }
  $('#tempo-status').textContent = `Tapped ${S.bpm.toFixed(1)} BPM from ${tapper.taps.length} taps${master.playing ? ', beat aligned to your taps' : ''}.`;
};

$('#detect-btn').onclick = async () => {
  const f = soundtrackFile();
  if (!f) return;
  // Detection decodes the whole file into memory; phones can't hold a huge video's audio.
  const limit = IS_MOBILE ? 250e6 : 1500e6;
  if (f.size > limit) {
    $('#tempo-status').textContent = `That file is ${(f.size / 1e6).toFixed(0)} MB, too large to analyze on this device. Tap the tempo, type it, or use a song file.`;
    return;
  }
  const btn = $('#detect-btn');
  btn.disabled = true; btn.textContent = 'Listening...';
  $('#tempo-status').textContent = 'Analyzing the soundtrack. Long songs take a few seconds.';
  try {
    const { bpm, offset } = await detectBeats(f);
    setBpm(bpm);
    S.offsetFrac = clamp(offset / beatLen(), 0, 1);
    offsetIn.value = S.offsetFrac; updateOffsetLabel(); rebuild();
    $('#tempo-status').textContent = `Detected ${bpm} BPM${isMix() ? " from clip 1's audio" : ''}, first beat at ${offset.toFixed(2)}s. Use ÷2 or ×2 if it feels half or double time.`;
  } catch (e) {
    console.error(e);
    $('#tempo-status').textContent = `Couldn't detect a beat (${e.message || 'decode failed'}). Enter or tap the BPM instead.`;
  }
  btn.disabled = false; btn.textContent = 'Detect beat from soundtrack';
};

document.querySelectorAll('#every .seg-btn').forEach(b => b.onclick = () => {
  S.every = +b.dataset.v;
  document.querySelectorAll('#every .seg-btn').forEach(x => x.classList.toggle('is-on', x === b));
  rebuild();
});
function bindRange(id, key, label, after) {
  const el = $('#' + id);
  const sync = () => { S[key] = +el.value; $('#' + label).textContent = Math.round(S[key] * 100) + '%'; setFill(el); };
  el.oninput = () => { sync(); if (after) after(); };
  sync();
}
bindRange('randomness', 'randomness', 'random-val', rebuild);
bindRange('overlap', 'overlap', 'overlap-val');
bindRange('punch', 'punch', 'punch-val');
bindRange('flash', 'flash', 'flash-val');
$('#order').onchange = e => { S.order = e.target.value; rebuild(); };
$('#jump').onchange = e => { S.jump = e.target.value; syncClips(master.now(), master.playing); };
$('#blend').onchange = e => { S.blend = +e.target.value; };
$('#aspect').onchange = e => { S.aspect = e.target.value; if (!exportJob) resizeTo(...sizeFor(0, PREVIEW_LONG)); };
$('#reshuffle-btn').onclick = () => { S.seed = (Math.random() * 1e9) | 0; rebuild(); };
updateOffsetLabel();

/* ---------- Transport ---------- */
const playBtn = $('#play-btn');
const syncPlay = () => playBtn.classList.toggle('paused', !master.playing);
playBtn.onclick = async () => {
  if (master.playing) master.pause();
  else { try { await master.play(); $('#play-overlay').hidden = true; } catch (e) { $('#play-overlay').hidden = false; } }
  syncPlay();
};
$('#play-overlay').onclick = () => playBtn.click();
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && clips.length && !exportJob && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement.tagName)) { e.preventDefault(); playBtn.click(); }
});
const volIn = $('#volume'), muteBtn = $('#mute-btn');
let muted = false;
function applyVolume() { if (monitor) monitor.gain.value = muted ? 0 : +volIn.value; muteBtn.classList.toggle('muted', muted || +volIn.value === 0); setFill(volIn); }
volIn.oninput = () => { muted = false; applyVolume(); };
muteBtn.onclick = () => { muted = !muted; applyVolume(); };
setFill(volIn);

$('#clip-input').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
['dragenter', 'dragover'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); $('#dropzone').classList.add('drag'); }));
['dragleave', 'drop'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); $('#dropzone').classList.remove('drag'); }));
document.addEventListener('drop', e => { if (!exportJob && e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); });

/* ---------- Cut handling ---------- */
function jumpTarget(seg, c) {
  const len = seg.end - seg.start;
  return seg.jump * Math.max(0, c.duration - len - 0.1);
}
function onCut(i) {
  const seg = segs[i];
  if (!seg) return;
  const c = clips[seg.clip];
  if (S.jump === 'jump' && !(seg.preseekAt && performance.now() - seg.preseekAt < 800)) c.video.currentTime = jumpTarget(seg, c);
  seg.preseekAt = 0;
  if (master.playing && c.video.paused) c.video.play().catch(() => {});
  clips.forEach((k, idx) => k.el && k.el.classList.toggle('active', idx === seg.clip));
}
function preseek(i, t, visible) {
  if (S.jump !== 'jump') return;
  const next = segs[i + 1];
  if (!next || next.preseekAt || visible.has(next.clip)) return;
  const lead = next.start - t;
  if (lead > 0.35 || lead < 0) return;
  const c = clips[next.clip];
  c.video.currentTime = Math.max(0, jumpTarget(next, c) - lead);
  next.preseekAt = performance.now();
}

/* ---------- Composite ---------- */
function layersAt(i, t) {
  const seg = segs[i];
  const beat = beatLen();
  const c = clips[seg.clip];
  const since = t - seg.start;
  const layers = [{ c, a: 1, w: c.opacity, mode: 0, zoom: 1 + S.punch * 0.2 * Math.exp(-since / (beat * 0.3)) }];
  if (S.overlap > 0.001) {
    const linger = S.overlap * 4 * beat;
    const strength = Math.min(1, S.overlap * 1.6);
    const seen = new Set([seg.clip]);
    const extra = [];
    for (let j = i - 1; j >= 0; j--) {
      const s = segs[j];
      const age = t - s.end;
      if (age > linger) break;
      if (seen.has(s.clip)) continue;
      seen.add(s.clip);
      const k = clips[s.clip];
      const fade = strength * (1 - age / linger);
      extra.push({ c: k, a: fade, w: k.opacity * fade, mode: S.blend, zoom: 1 });
    }
    layers.push(...extra.reverse());
  }
  return layers;
}
function composite(i, t) {
  accum.read.clear();
  if (i < 0 || !segs[i]) { r.blit(accum.read, null); return []; }
  const layers = layersAt(i, t);
  const oa = r.w / r.h;
  for (const L of layers) {
    uploadClip(L.c);
    const ca = L.c.video.videoWidth / L.c.video.videoHeight || oa;
    const cover = ca > oa ? [oa / ca, 1] : [1, ca / oa];
    r.pass(compProg, accum.write, { uWeight: L.w, uMode: L.mode, uZoom: L.zoom, uCover: cover }, { uAccum: accum.read, uLayer: L.c.tex });
    accum.swap();
  }
  const since = t - segs[i].start;
  r.pass(finalProg, null, { uFlash: S.flash * 0.85 * Math.exp(-since / (beatLen() * 0.12)) }, { uTex: accum.read });
  return layers;
}

/* ---------- Clip audio mix ---------- */
function setClipGain(c, g) {
  if (!c.gain || Math.abs(g - c.lastGain) < 0.002) return;
  c.gain.gain.setTargetAtTime(g, actx.currentTime, 0.006); // ~20 ms declick on cuts
  c.lastGain = g;
}
function updateMix(layers) {
  if (!actx) return;
  if (S.soundtrack === 'mix-all') {
    const on = clips.filter(c => c.enabled);
    const norm = 1 / Math.sqrt(Math.max(1, on.length));
    clips.forEach(c => setClipGain(c, c.enabled ? c.volume * norm : 0));
  } else if (S.soundtrack === 'mix-cuts') {
    clips.forEach(c => {
      const L = layers.find(L => L.c === c);
      setClipGain(c, L ? c.volume * L.a : 0);
    });
  }
}

audioEl.addEventListener('ended', () => { if (!exportJob) { master.seek(S.secStart); master.play().catch(() => {}); } });

/* ---------- Main loop ---------- */
const dots = [...document.querySelectorAll('#beat-dots i')];
let lastBeat = null, frameNo = 0;
function frame() {
  requestAnimationFrame(frame);
  frameNo++;
  if (!clips.length) { drawTimeline(0); return; }
  let t = master.now();
  if (!exportJob && master.playing && t >= S.secEnd - 0.01) { master.seek(S.secStart); t = S.secStart; }

  const i = segs.length ? findSegment(segs, t) : -1;
  if (i !== curSeg) { onCut(i); curSeg = i; }
  const layers = composite(i, t);
  updateMix(layers);
  if (master.playing) preseek(i, t, new Set(layers.map(L => clips.indexOf(L.c))));

  const beat = beatLen();
  const bi = Math.floor((t - offsetSec()) / beat + 1e-6);
  const inBar = ((bi % 4) + 4) % 4;
  if (bi !== lastBeat) {
    dots.forEach((d, k) => d.classList.toggle('on', k === inBar));
    if (lastBeat !== null && master.playing && !exportJob && $('#click-toggle').checked) click(inBar === 0);
    lastBeat = bi;
  }
  drawTimeline(t);
  $('#timecode').textContent = `${fmt(t)} / ${fmt(S.total)}`;
  if (frameNo % 6 === 0) clips.forEach(drawThumb);

  if (exportJob) exportTick(t);
  syncPlay();
}
requestAnimationFrame(frame);

/* ---------- Export ---------- */
const exportBtn = $('#export-btn'), cancelBtn = $('#cancel-btn'), note = $('#export-note');
exportBtn.onclick = startExport;
cancelBtn.onclick = () => finishExport(true);

async function startExport() {
  if (!clips.length || exportJob) return;
  // Unlock media inside this tap (iOS), since playback starts after a short delay below.
  ensureAudio(); resumeAudio();
  clips.forEach(c => c.video.play().catch(() => {}));
  if (master.audio && audioEl.paused) audioEl.play().then(() => { if (!exportJob || exportJob.finishing) audioEl.pause(); }).catch(() => {});
  if (typeof MediaRecorder === 'undefined') { alert('This browser does not support MediaRecorder, which is needed to render video.'); return; }
  const mime = pickMime($('#ex-format').value);
  if (!mime) { alert('No supported recording format found in this browser.'); return; }
  ensureAudio(); await resumeAudio();
  const fps = +$('#ex-fps').value;
  const [w, h] = sizeFor(+$('#ex-res').value);
  master.pause();
  resizeTo(w, h);
  segs.forEach(s => { s.preseekAt = 0; });
  master.seek(S.secStart);
  await new Promise(res => setTimeout(res, 400)); // let clips land on their first frames

  let stream = canvas.captureStream(0);
  let vtrack = stream.getVideoTracks()[0];
  const manual = typeof vtrack.requestFrame === 'function';
  if (!manual) { vtrack.stop(); stream = canvas.captureStream(fps); vtrack = stream.getVideoTracks()[0]; }
  const tracks = [vtrack];
  const withAudio = S.soundtrack !== 'none' && recordDest;
  const audioLabel = isMix() ? ' with mixed clip audio' : ' with soundtrack';
  if (withAudio) tracks.push(recordDest.stream.getAudioTracks()[0]);
  const rec = new MediaRecorder(new MediaStream(tracks), { mimeType: mime, videoBitsPerSecond: bitrateFor(w, h, $('#ex-quality').value) * (fps / 30), audioBitsPerSecond: 192000 });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise(res => { rec.onstop = res; });
  exportJob = { rec, chunks, stopped, vtrack, manual, fps, w, h, mime, start: S.secStart, end: S.secEnd, lastFrameT: -1, finishing: false };
  keepAwake().then(lock => { if (exportJob) exportJob.wake = lock; else if (lock) lock.release(); });
  document.body.classList.add('exporting');
  exportBtn.hidden = true; cancelBtn.hidden = false;
  $('#render-overlay').hidden = false;
  $('#result').hidden = true;
  note.textContent = `${w}x${h} at ${fps} fps, ${mime.split(';')[0].replace('video/', '').toUpperCase()}${withAudio ? audioLabel : ', silent'}. Overlap, punch and flash can still be tweaked live.`;
  rec.start(1000);
  try { await master.play(); } catch (e) { finishExport(true); alert('Playback was blocked. Click anywhere on the page and try again.'); }
}

function exportTick(t) {
  const job = exportJob;
  if (job.finishing) return;
  if (job.manual && (job.lastFrameT < 0 || t - job.lastFrameT >= 1 / job.fps - 0.004)) { job.vtrack.requestFrame(); job.lastFrameT = t; }
  const pct = clamp((t - job.start) / Math.max(0.01, job.end - job.start), 0, 1);
  $('#render-fill').style.width = (pct * 100).toFixed(1) + '%';
  $('#render-pct').textContent = Math.round(pct * 100) + '%';
  $('#render-sub').textContent = `${fmt(job.end - t)} left. Keep this tab visible while it renders.`;
  exportBtn.textContent = `Rendering ${Math.round(pct * 100)}%`;
  if (t >= job.end - 0.01 || (S.soundtrack !== 'none' && audioEl.ended)) finishExport(false);
}

async function finishExport(cancelled) {
  const job = exportJob;
  if (!job || job.finishing) return;
  job.finishing = true;
  master.pause();
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
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(job.chunks, { type });
    const name = `beatcut_${Math.round(S.bpm)}bpm_${job.w}x${job.h}.${ext}`;
    if (lastDownload) URL.revokeObjectURL(lastDownload);
    lastDownload = presentResult(blob, name, $('#result'));
    note.textContent = IS_IOS ? `Ready: ${name}. Tap ${$('#result button') ? 'Save video' : 'Download'} to keep it.` : `Saved ${name}.`;
  } else note.textContent = cancelled ? 'Render cancelled.' : 'Nothing was recorded. Try again with the tab in the foreground.';
  resizeTo(...sizeFor(0, PREVIEW_LONG));
  master.seek(S.secStart);
}

/* ---------- Boot ---------- */
renderSlots();
renderSoundtrackOptions();
rebuild();
