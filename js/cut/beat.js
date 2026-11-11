// Offline tempo + beat-phase detection, and a tap-tempo helper.
// Pipeline: decode audio -> mono -> spectral-flux onset envelope ->
// autocorrelation for tempo -> comb filter for the first beat.

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

export async function decodeFile(file) {
  const buf = await file.arrayBuffer();
  const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new AC(1, 44100, 44100);
  return await ctx.decodeAudioData(buf);
}

function detrend(env, w) {
  const frames = env.length, out = new Float32Array(frames);
  let acc = 0;
  for (let i = 0; i < frames + w; i++) {
    if (i < frames) acc += env[i];
    if (i - 2 * w - 1 >= 0) acc -= env[i - 2 * w - 1];
    const c = i - w;
    if (c >= 0 && c < frames) {
      const n = Math.min(frames, c + w + 1) - Math.max(0, c - w);
      out[c] = Math.max(0, env[c] - acc / n);
    }
  }
  return out;
}

export function onsetEnvelope(audioBuffer, N = 1024, hop = 512) {
  const sr = audioBuffer.sampleRate;
  const len = audioBuffer.length;
  const mono = new Float32Array(len);
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    const d = audioBuffer.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += d[i] / audioBuffer.numberOfChannels;
  }
  const frames = Math.max(0, Math.floor((len - N) / hop));
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const maxBin = Math.min(N / 2, Math.round((8000 / sr) * N));
  const re = new Float32Array(N), im = new Float32Array(N);
  let prev = new Float32Array(maxBin), cur = new Float32Array(maxBin);
  const env = new Float32Array(frames);
  const lowEnv = new Float32Array(frames);
  const lowBin = Math.max(2, Math.round((160 / sr) * N));
  for (let f = 0; f < frames; f++) {
    const o = f * hop;
    for (let i = 0; i < N; i++) { re[i] = mono[o + i] * win[i]; im[i] = 0; }
    fft(re, im);
    let flux = 0, low = 0;
    for (let k = 1; k < maxBin; k++) {
      const m = Math.log1p(10 * Math.hypot(re[k], im[k]));
      cur[k] = m;
      const d = m - prev[k];
      if (d > 0) { flux += d; if (k <= lowBin) low += d; }
    }
    env[f] = flux;
    lowEnv[f] = low;
    [prev, cur] = [cur, prev];
  }
  const fps = sr / hop;
  const out = detrend(env, Math.round(fps * 0.4));
  const lowOut = detrend(lowEnv, Math.round(fps * 0.4));
  // Phase envelope leans on low-end hits so the grid lands on kicks, not off-beat hats.
  const mean = a => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length) || 1;
  const mf = mean(out), ml = mean(lowOut);
  const phaseEnv = out.map((v, i) => v / mf + 2.5 * lowOut[i] / ml);
  return { env: out, phaseEnv, fps, offset: N / 2 / sr };
}

export function estimateTempo({ env, phaseEnv, fps, offset }, minBpm = 60, maxBpm = 200) {
  const minLag = Math.floor((fps * 60) / maxBpm), maxLag = Math.ceil((fps * 60) / minBpm);
  const n = env.length;
  if (n < maxLag * 4) throw new Error('Soundtrack is too short to detect a tempo.');
  const ac = new Float32Array(maxLag + 2);
  for (let L = minLag - 1; L <= maxLag + 1; L++) {
    let s = 0;
    for (let i = 0; i + L < n; i++) s += env[i] * env[i + L];
    ac[L] = s / (n - L);
  }
  let best = minLag, bestScore = -Infinity;
  for (let L = minLag; L <= maxLag; L++) {
    const bpm = (60 * fps) / L;
    const weight = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    // Reward lags whose double also lines up (beats, not off-beats).
    const score = (ac[L] + 0.5 * (ac[2 * L] || 0)) * weight;
    if (score > bestScore) { bestScore = score; best = L; }
  }
  const a = ac[best - 1], b = ac[best], c = ac[best + 1];
  const denom = a - 2 * b + c;
  const coarseLag = best + (denom !== 0 ? (0.5 * (a - c)) / denom : 0);
  const coarseBpm = (60 * fps) / coarseLag;

  // Fine pass: try tempos near the estimate and keep the one whose beat grid
  // lines up best with onsets across the WHOLE track (removes slow drift).
  const interp = arr => x => { const i = Math.floor(x), f = x - i; return (arr[i] || 0) * (1 - f) + (arr[i + 1] || 0) * f; };
  let at = interp(env);
  const comb = (lag, step) => {
    let bestS = -Infinity, bestO = 0;
    for (let o = 0; o < lag; o += step) {
      let sum = 0;
      for (let t = o; t < n - 1; t += lag) sum += at(t);
      if (sum > bestS) { bestS = sum; bestO = o; }
    }
    return { score: bestS, phase: bestO };
  };
  let fine = { bpm: coarseBpm, score: -Infinity };
  for (let bpm = coarseBpm - 2; bpm <= coarseBpm + 2; bpm += 0.02) {
    const r = comb((60 * fps) / bpm, 0.5);
    if (r.score > fine.score) fine = { bpm, score: r.score };
  }
  const lag = (60 * fps) / fine.bpm;
  at = interp(phaseEnv || env);
  const { phase } = comb(lag, 0.1);
  const beat = 60 / fine.bpm;
  let first = phase / fps + offset;
  first = ((first % beat) + beat) % beat;
  return { bpm: Math.round(fine.bpm * 10) / 10, offset: first };
}

export async function detectBeats(file) {
  const buf = await decodeFile(file);
  return estimateTempo(onsetEnvelope(buf));
}

export class TapTempo {
  constructor() { this.taps = []; }
  tap(now = performance.now()) {
    if (this.taps.length && now - this.taps[this.taps.length - 1] > 2000) this.taps = [];
    this.taps.push(now);
    if (this.taps.length > 8) this.taps.shift();
    if (this.taps.length < 2) return null;
    const span = this.taps[this.taps.length - 1] - this.taps[0];
    return 60000 / (span / (this.taps.length - 1));
  }
}
