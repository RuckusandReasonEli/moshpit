import { usePlaybackAudioSession } from './mobile.js';

// Audio analysis: splits the video's soundtrack into EQ bands that any effect
// parameter can be linked to, plus a "Bass Hit" transient trigger.

export const BANDS = [
  { id: 'sub', label: 'Sub', short: 'SUB', range: '20-60 Hz', lo: 20, hi: 60, tilt: 0 },
  { id: 'bass', label: 'Bass', short: 'BASS', range: '60-250 Hz', lo: 60, hi: 250, tilt: 0 },
  { id: 'lowmid', label: 'Low Mid', short: 'LO MID', range: '250-500 Hz', lo: 250, hi: 500, tilt: 3 },
  { id: 'mid', label: 'Mid', short: 'MID', range: '500 Hz-2 kHz', lo: 500, hi: 2000, tilt: 6 },
  { id: 'highmid', label: 'High Mid', short: 'HI MID', range: '2-4 kHz', lo: 2000, hi: 4000, tilt: 9 },
  { id: 'presence', label: 'Presence', short: 'PRES', range: '4-6 kHz', lo: 4000, hi: 6000, tilt: 12 },
  { id: 'air', label: 'Air', short: 'AIR', range: '6-16 kHz', lo: 6000, hi: 16000, tilt: 14 },
  { id: 'hit', label: 'Bass Hit', short: 'HIT', range: 'kick / transient', transient: true },
];

const clamp01 = v => Math.min(1, Math.max(0, v));

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.levels = Object.fromEntries(BANDS.map(b => [b.id, 0]));
    this.raw = {};
    this.peak = {};
    this.range = 24;       // dB of dynamic range mapped onto 0..1
    this.smoothing = 0.4;  // 0 = snappy, 1 = slow
    this.autoGain = true;
    this.signal = false;
    this.bassAvg = 0;
    this.hitEnv = 0;
    this.sinceHit = 1;
  }

  attach(video) {
    if (this.ctx) return;
    usePlaybackAudioSession();
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    const ctx = this.ctx;
    this.src = ctx.createMediaElementSource(video);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0;
    this.analyser.minDecibels = -110;
    this.analyser.maxDecibels = -5;
    this.freq = new Float32Array(this.analyser.frequencyBinCount);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    this.monitor = ctx.createGain();
    this.recordDest = ctx.createMediaStreamDestination();
    this.src.connect(this.analyser);
    this.analyser.connect(sink);
    sink.connect(ctx.destination);
    this.src.connect(this.monitor);
    this.monitor.connect(ctx.destination);
    this.src.connect(this.recordDest);
  }

  get recordTrack() { return this.recordDest ? this.recordDest.stream.getAudioTracks()[0] : null; }

  async resume() { if (this.ctx && this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch (e) { /* needs a gesture */ } } }

  setVolume(v) { if (this.monitor) this.monitor.gain.value = v; }

  update(dt) {
    if (!this.analyser) return;
    dt = Math.min(0.1, Math.max(0.001, dt));
    this.analyser.getFloatFrequencyData(this.freq);
    const binHz = this.ctx.sampleRate / this.analyser.fftSize;
    const atk = 1 - Math.exp(-dt / (0.008 + this.smoothing * 0.06));
    const rel = 1 - Math.exp(-dt / (0.04 + this.smoothing * 0.6));
    for (const b of BANDS) {
      if (b.transient) continue;
      const i0 = Math.max(1, Math.floor(b.lo / binHz));
      const i1 = Math.min(this.freq.length - 1, Math.ceil(b.hi / binHz));
      let p = 0;
      for (let i = i0; i <= i1; i++) { const d = this.freq[i]; if (d > -200) p += Math.pow(10, d / 10); }
      p /= i1 - i0 + 1;
      const db = 10 * Math.log10(p + 1e-14) + b.tilt;
      if (db > -85) this.signal = true;
      let ref;
      if (this.autoGain) {
        const pk = this.peak[b.id] ?? -60;
        ref = this.peak[b.id] = Math.max(db, pk - dt * 4, -60);
      } else ref = -22;
      const v = clamp01(1 - (ref - db) / this.range);
      this.raw[b.id] = v;
      const cur = this.levels[b.id];
      this.levels[b.id] = cur + (v - cur) * (v > cur ? atk : rel);
    }
    // Transient detector on the bass band.
    const bass = Math.max(this.raw.bass || 0, this.raw.sub || 0);
    this.bassAvg += (bass - this.bassAvg) * (1 - Math.exp(-dt / 0.35));
    this.hitEnv *= Math.exp(-dt / (0.08 + this.smoothing * 0.15));
    this.sinceHit += dt;
    if (bass - this.bassAvg > 0.16 && this.sinceHit > 0.12) { this.hitEnv = 1; this.sinceHit = 0; }
    this.levels.hit = this.hitEnv;
  }

  silence() { for (const k in this.levels) this.levels[k] = 0; this.hitEnv = 0; }
}
