import { BaseFX, FS_IO, FLOW_GLSL } from '../gl.js';

// Per-block motion vectors, like a codec's P-frame motion search.
const MV_FS = FS_IO + FLOW_GLSL + /* glsl */ `
uniform sampler2D uCur, uPrev; uniform vec2 uStep;
void main() { outColor = encV(lkFlow(uCur, uPrev, vUv, uStep)); }`;

// Reconstruct each frame from the PREVIOUS OUTPUT plus motion vectors and a
// (scaled) residual. Dropping keyframes means errors pile up: that's the mosh.
const MOSH_FS = FS_IO + /* glsl */ `
uniform sampler2D uSrc, uPrevSrc, uPrevOut, uMV;
uniform vec2 uBlocks;
uniform float uMosh, uGain, uResidual, uRefresh, uForce, uCrunch, uSeed, uBleed;
void main() {
  vec2 cell = floor(vUv * uBlocks);
  vec2 cuv = (cell + 0.5) / uBlocks;
  vec2 mv = decV(texture(uMV, cuv)) * uGain;
  vec3 src = texture(uSrc, vUv).rgb;
  vec3 pred = texture(uPrevOut, vUv - mv).rgb;
  vec3 res = src - texture(uPrevSrc, vUv - mv).rgb;
  if (uCrunch > 0.001) {
    float q = mix(48.0, 3.0, uCrunch);
    vec3 blockRes = src - texture(uPrevSrc, cuv - mv).rgb;   // coarse, blocky residual
    res = mix(res, blockRes, uCrunch * 0.6);
    res = floor(res * q + 0.5) / q;
  }
  vec3 mosh = pred + res * uResidual;
  mosh = mix(mosh, mosh.gbr, uBleed * 0.02 * step(0.5, hash12(cell + uSeed * 1.7)));
  float iblock = step(hash12(cell + vec2(uSeed, uSeed * 0.37)), uRefresh);
  vec3 o = mix(mosh, src, max(iblock, uForce));
  o = mix(src, o, uMosh);
  outColor = vec4(clamp(o, 0.0, 1.0), 1.0);
}`;

class DataMoshFX extends BaseFX {
  constructor(r) {
    super(r);
    this.mvProg = r.fx(MV_FS);
    this.moshProg = r.fx(MOSH_FS);
    this.lastKey = 0;
  }
  reset() { super.reset(); this.lastKey = 0; }
  render(p, ctx, target) {
    const r = this.r;
    const bpx = Math.max(2, p.block * r.h / 720);
    const bw = Math.max(2, Math.round(r.w / bpx)), bh = Math.max(2, Math.round(r.h / bpx));
    const mv = this.target('mv', bw, bh, { float: true, filter: 'nearest' });
    const out = this.pp('out', r.w, r.h);
    let force = this.first ? 1 : 0;
    if (ctx.step) {
      const step = bpx * 0.6;
      r.pass(this.mvProg, mv, { uStep: [step / r.w, step / r.h] }, { uCur: r.cur, uPrev: r.prev });
      if (ctx.time < this.lastKey) this.lastKey = ctx.time;
      if (p.keyframe > 0.05 && ctx.time - this.lastKey >= p.keyframe) { force = 1; this.lastKey = ctx.time; }
      this.first = false;
    }
    r.pass(this.moshProg, out.write, {
      uBlocks: [bw, bh], uMosh: p.mosh, uGain: p.gain, uResidual: p.residual,
      uRefresh: p.refresh * 0.05, uForce: force, uCrunch: p.crunch, uSeed: (ctx.frame % 997) * 1.618, uBleed: p.bleed,
    }, { uSrc: r.cur, uPrevSrc: r.prev, uPrevOut: out.read, uMV: mv });
    this.present(out, target, ctx.step);
  }
}

export default {
  id: 'data-mosh',
  name: 'Data Mosh',
  description: 'Motion reactive glitching simulating video p-frame dropping.',
  swatch: ['#0c0c0c', '#9fae5a'],
  params: [
    { id: 'mosh', label: 'Mosh', min: 0, max: 1, step: 0.01, value: 1 },
    { id: 'gain', label: 'Motion Gain', min: 0, max: 4, step: 0.01, value: 1.6, mod: { band: 'bass', depth: 0.25 } },
    { id: 'residual', label: 'Residual', min: 0, max: 1, step: 0.01, value: 0.12 },
    { id: 'block', label: 'Block Size', min: 4, max: 64, step: 1, value: 16 },
    { id: 'refresh', label: 'Block Refresh', min: 0, max: 1, step: 0.01, value: 0.04, mod: { band: 'hit', depth: 0.4 } },
    { id: 'keyframe', label: 'Keyframe Every (s)', min: 0, max: 10, step: 0.1, value: 0 },
    { id: 'crunch', label: 'Crunch', min: 0, max: 1, step: 0.01, value: 0.3, mod: { band: 'highmid', depth: 0.3 } },
    { id: 'bleed', label: 'Color Bleed', min: 0, max: 1, step: 0.01, value: 0.1 },
  ],
  create: r => new DataMoshFX(r),
};
