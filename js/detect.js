// Shared face / hand / body tracking (MediaPipe Tasks Vision, runs on-device).
// The library is served from /vendor; the models download once from Google's
// model host the first time an effect that needs them is used.

const BASE = new URL('../vendor/mediapipe/', import.meta.url).href;
export const MODEL_URLS = {
  face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  hands: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  pose: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
};
const LABELS = { face: 'face', hands: 'hand', pose: 'body' };

export class Tracker {
  constructor() {
    this.tasks = {};
    this.loading = {};
    this.state = {};      // kind -> 'loading' | 'ready' | 'error'
    this.errors = {};
    this.ts = 0;
    this.cost = {};       // kind -> smoothed ms per frame
    this.onChange = () => {};
  }

  ensure(kinds) {
    for (const k of kinds) if (!this.loading[k]) this.loading[k] = this._load(k);
  }

  ready(kinds) { return kinds.some(k => this.state[k] === 'ready'); }

  statusText(kinds) {
    if (!kinds.length) return '';
    const parts = kinds.map(k => `${LABELS[k]} ${this.state[k] === 'ready' ? 'ready' : this.state[k] === 'error' ? 'unavailable' : 'loading'}`);
    return 'Tracking: ' + parts.join(', ');
  }

  _fileset() {
    if (!this.fs) {
      this.fs = import(BASE + 'vision_bundle.mjs').then(mod => {
        this.mod = mod;
        return mod.FilesetResolver.forVisionTasks(BASE + 'wasm');
      });
    }
    return this.fs;
  }

  async _load(kind) {
    this.state[kind] = 'loading';
    this.onChange();
    try {
      const fs = await this._fileset();
      const { FaceLandmarker, HandLandmarker, PoseLandmarker } = this.mod;
      const make = delegate => {
        const baseOptions = { modelAssetPath: MODEL_URLS[kind], delegate };
        if (kind === 'face') return FaceLandmarker.createFromOptions(fs, { baseOptions, runningMode: 'VIDEO', numFaces: 2 });
        if (kind === 'hands') return HandLandmarker.createFromOptions(fs, { baseOptions, runningMode: 'VIDEO', numHands: 2 });
        return PoseLandmarker.createFromOptions(fs, { baseOptions, runningMode: 'VIDEO', numPoses: 2 });
      };
      let task;
      try { task = await make('GPU'); } catch (e) { console.warn(`GPU ${kind} tracking unavailable, using CPU`, e); task = await make('CPU'); }
      this.tasks[kind] = task;
      this.state[kind] = 'ready';
    } catch (e) {
      console.error(`Could not load ${kind} tracking`, e);
      this.state[kind] = 'error';
      this.errors[kind] = e.message || String(e);
    }
    this.onChange();
  }

  /** Run every requested, loaded model on the current video frame. Coordinates are normalized, y down. */
  detect(video, kinds, out = { faces: [], hands: [], poses: [] }) {
    if (video.readyState < 2) return out;
    for (const k of kinds) {
      const task = this.tasks[k];
      if (!task) continue;
      this.ts = Math.max(this.ts + 1, performance.now());
      const t0 = performance.now();
      try {
        const r = task.detectForVideo(video, this.ts);
        if (k === 'face') out.faces = r.faceLandmarks || [];
        else if (k === 'hands') out.hands = r.landmarks || [];
        else out.poses = r.landmarks || [];
      } catch (e) {
        console.warn(`${k} tracking failed on a frame`, e);
      }
      const ms = performance.now() - t0;
      this.cost[k] = this.cost[k] === undefined ? ms : this.cost[k] * 0.8 + ms * 0.2;
    }
    return out;
  }

  /** Pick which models to run this frame so tracking fits in a time budget. */
  schedule(kinds, budgetMs, frame) {
    const ready = kinds.filter(k => this.tasks[k]);
    const total = ready.reduce((s, k) => s + (this.cost[k] ?? 0), 0);
    if (total <= budgetMs || ready.length < 2) return ready;
    return [ready[frame % ready.length]]; // over budget: rotate one model per frame
  }
}
