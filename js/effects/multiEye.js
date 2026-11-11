import { BaseFX, FS_IO } from '../gl.js';

const MAX = 32;
const FS = FS_IO + /* glsl */ `
uniform sampler2D uSrc;
uniform vec4 uDst[${MAX}];    // dest x, y (px), scale, rotation
uniform vec4 uFeat[${MAX}];   // source x, y (px), half width, half height
uniform vec4 uExtra[${MAX}];  // source angle, alpha, feather, unused
uniform float uCount;
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
void main() {
  vec2 p = vUv * uRes;
  vec3 col = texture(uSrc, vUv).rgb;
  for (int i = 0; i < ${MAX}; i++) {
    if (float(i) >= uCount) break;
    vec4 d = uDst[i], f = uFeat[i], e = uExtra[i];
    vec2 q = rot(-d.w) * (p - d.xy) / d.z;          // into the copy's space
    vec2 en = (rot(-e.x) * q) / f.zw;               // into the feature's ellipse
    float m = 1.0 - smoothstep(1.0 - e.z, 1.0, length(en));
    if (m <= 0.0) continue;
    col = mix(col, texture(uSrc, (f.xy + q) / uRes).rgb, m * e.y);
  }
  outColor = vec4(col, 1.0);
}`;

function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// MediaPipe face-mesh indices
const EYES = [
  { corners: [33, 133], lids: [159, 145] },
  { corners: [362, 263], lids: [386, 374] },
];
const MOUTH = { corners: [61, 291], lips: [0, 17] };

function feature(lm, a, b, c, d, W, H, padW, padH, minRatio) {
  const P = i => [lm[i].x * W, lm[i].y * H];
  const [ax, ay] = P(a), [bx, by] = P(b), [cx, cy] = P(c), [dx, dy] = P(d);
  const w = Math.hypot(bx - ax, by - ay);
  const h = Math.hypot(dx - cx, dy - cy);
  const hw = (w * padW) / 2;
  return {
    x: (ax + bx + cx + dx) / 4, y: (ay + by + cy + dy) / 4,
    hw, hh: Math.max(hw * minRatio, (h * padH) / 2),
    angle: Math.atan2(by - ay, bx - ax),
  };
}

class MultiEyeFX extends BaseFX {
  constructor(r) {
    super(r);
    this.prog = r.fx(FS);
    this.feats = { eye: [], mouth: [] };
    this.seen = -1e9;
    this.copies = [];
    this.key = '';
    this.lastHit = 0;
    this.lastAuto = 0;
    this.rng = mulberry(7);
    this.dst = new Float32Array(MAX * 4);
    this.src = new Float32Array(MAX * 4);
    this.ext = new Float32Array(MAX * 4);
  }
  reset() { super.reset(); this.feats = { eye: [], mouth: [] }; this.seen = -1e9; }

  updateFeatures(track, now) {
    const W = this.r.w, H = this.r.h;
    const faces = (track && track.faces) || [];
    if (!faces.length) return;
    const eyes = [], mouths = [];
    for (const lm of faces.slice(0, 2)) {
      for (const e of EYES) eyes.push(feature(lm, e.corners[0], e.corners[1], e.lids[0], e.lids[1], W, H, 1.45, 2.6, 0.5));
      mouths.push(feature(lm, MOUTH.corners[0], MOUTH.corners[1], MOUTH.lips[0], MOUTH.lips[1], W, H, 1.3, 1.5, 0.42));
    }
    const smooth = (prev, next) => next.map((n, i) => {
      const p = prev[i];
      if (!p) return n;
      const k = 0.55;
      return { x: p.x + (n.x - p.x) * k, y: p.y + (n.y - p.y) * k, hw: p.hw + (n.hw - p.hw) * k, hh: p.hh + (n.hh - p.hh) * k, angle: n.angle };
    });
    this.feats.eye = smooth(this.feats.eye, eyes);
    this.feats.mouth = smooth(this.feats.mouth, mouths);
    this.seen = now;
  }

  layout(p) {
    const mode = Math.round(p.features);
    const nE = mode === 1 ? 0 : Math.round(p.eyes);
    const nM = mode === 0 ? 0 : Math.round(p.mouths);
    const key = `${nE}|${nM}`;
    if (key === this.key) return;
    this.key = key;
    const rng = mulberry(1234 + nE * 31 + nM);
    this.copies = [];
    const total = Math.min(MAX, nE + nM);
    for (let i = 0; i < total; i++) {
      const kind = i < nE ? 'eye' : 'mouth';
      this.copies.push({
        kind, which: kind === 'eye' ? i : i - nE,
        bx: 0.08 + rng() * 0.84, by: 0.08 + rng() * 0.84,
        ph: [rng() * 6.28, rng() * 6.28, rng() * 6.28], sp: 0.6 + rng() * 0.8,
        sv: rng(), rv: rng() - 0.5, pop: 0,
      });
    }
  }

  jump(fraction) {
    for (const c of this.copies) {
      if (this.rng() > fraction) continue;
      c.bx = 0.08 + this.rng() * 0.84;
      c.by = 0.08 + this.rng() * 0.84;
      c.rv = this.rng() - 0.5;
      c.pop = 1;
    }
  }

  render(p, ctx, target) {
    const r = this.r;
    const now = ctx.time;
    if (ctx.step && ctx.track && ctx.track.fresh) this.updateFeatures(ctx.track, performance.now());
    this.layout(p);

    if (ctx.step) {
      const hit = ctx.hit || 0;
      if (hit > 0.7 && this.lastHit <= 0.7 && p.beatJump > 0.001) this.jump(p.beatJump);
      this.lastHit = hit;
      if (p.autoJump > 0.05) {
        if (now < this.lastAuto) this.lastAuto = now;
        if (now - this.lastAuto >= p.autoJump) { this.jump(1); this.lastAuto = now; }
      }
      for (const c of this.copies) c.pop *= 0.82;
    }

    // Fade copies out if the face has been lost for a while.
    const lost = (performance.now() - this.seen) / 1000;
    const presence = Math.max(0, Math.min(1, 1.5 - lost * 2));
    let n = 0;
    if (presence > 0) {
      const W = r.w, H = r.h;
      const amp = p.drift * 0.22, t = now * p.driftSpeed;
      for (const c of this.copies) {
        const list = this.feats[c.kind];
        if (!list.length) continue;
        const f = list[c.which % list.length];
        let x = c.bx + amp * Math.sin(t * 0.37 * c.sp + c.ph[0]) + amp * 0.5 * Math.sin(t * 0.91 * c.sp + c.ph[2]);
        let y = c.by + amp * Math.cos(t * 0.29 * c.sp + c.ph[1]) + amp * 0.5 * Math.sin(t * 0.67 * c.sp + c.ph[0]);
        x = 0.04 + Math.abs(((x - 0.04) % 1.84 + 1.84) % 1.84 - 0.92); // bounce inside the frame
        y = 0.04 + Math.abs(((y - 0.04) % 1.84 + 1.84) % 1.84 - 0.92);
        const scale = p.size * (1 + (c.sv - 0.5) * 1.2 * p.variety) * (1 + c.pop * 0.35);
        const rotation = c.rv * Math.PI * p.spin + Math.sin(t * 0.5 + c.ph[1]) * 0.2 * p.spin;
        this.dst.set([x * W, y * H, scale, rotation], n * 4);
        this.src.set([f.x, f.y, f.hw, f.hh], n * 4);
        this.ext.set([f.angle, p.opacity * presence, p.feather, 0], n * 4);
        n++;
      }
    }
    r.pass(this.prog, target, { uCount: n, uDst: this.dst, uFeat: this.src, uExtra: this.ext }, { uSrc: r.cur });
  }
}

export default {
  id: 'multi-eye',
  name: 'Multi-Eye Multi-Mouth',
  description: 'Finds eyes and mouths and scatters copies of them around the frame. They drift and jump with the beat.',
  swatch: ['#2b1030', '#ffd36a'],
  needs: () => ['face'],
  params: [
    { id: 'features', label: 'Duplicate', type: 'select', options: ['Eyes', 'Mouth', 'Eyes + Mouth'], value: 2 },
    { id: 'eyes', label: 'Eye Copies', min: 1, max: 24, step: 1, value: 8 },
    { id: 'mouths', label: 'Mouth Copies', min: 1, max: 12, step: 1, value: 3 },
    { id: 'size', label: 'Size', min: 0.3, max: 4, step: 0.01, value: 1.3, mod: { band: 'bass', depth: 0.15 } },
    { id: 'variety', label: 'Size Variety', min: 0, max: 1, step: 0.01, value: 0.4 },
    { id: 'drift', label: 'Drift', min: 0, max: 1, step: 0.01, value: 0.35 },
    { id: 'driftSpeed', label: 'Drift Speed', min: 0, max: 3, step: 0.01, value: 0.6, mod: { band: 'mid', depth: 0.2 } },
    { id: 'beatJump', label: 'Jump on Beat', min: 0, max: 1, step: 0.01, value: 0.6 },
    { id: 'autoJump', label: 'Auto Jump Every (s)', min: 0, max: 8, step: 0.1, value: 0 },
    { id: 'spin', label: 'Spin', min: 0, max: 1, step: 0.01, value: 0.15 },
    { id: 'feather', label: 'Feather', min: 0.05, max: 1, step: 0.01, value: 0.4 },
    { id: 'opacity', label: 'Opacity', min: 0, max: 1, step: 0.01, value: 1 },
  ],
  create: r => new MultiEyeFX(r),
};
