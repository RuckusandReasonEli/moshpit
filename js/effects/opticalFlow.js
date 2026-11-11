import { BaseFX, FS_IO, FLOW_GLSL } from '../gl.js';

const FLOW_FS = FS_IO + FLOW_GLSL + /* glsl */ `
uniform sampler2D uCur, uPrev; uniform vec2 uStep;
void main() { outColor = encV(lkFlow(uCur, uPrev, vUv, uStep)); }`;

const DISP_FS = FS_IO + /* glsl */ `
uniform sampler2D uDisp, uFlow; uniform float uDecay, uGain, uMax;
void main() {
  vec2 f = decV(texture(uFlow, vUv));
  vec2 d = decV(texture(uDisp, vUv - f * 0.5));
  d = d * uDecay + f * uGain;
  float L = length(d);
  if (L > uMax) d *= uMax / L;
  outColor = encV(d);
}`;

const OUT_FS = FS_IO + /* glsl */ `
uniform sampler2D uSrc, uPrevOut, uDisp, uFlow;
uniform float uWarp, uTrails, uChroma, uShine;
void main() {
  vec2 d = decV(texture(uDisp, vUv)) * uWarp;
  vec3 w;
  w.r = texture(uSrc, vUv - d * (1.0 + uChroma)).r;
  w.g = texture(uSrc, vUv - d).g;
  w.b = texture(uSrc, vUv - d * (1.0 - uChroma)).b;
  vec2 f = decV(texture(uFlow, vUv));
  vec3 trail = texture(uPrevOut, vUv - f * 1.5 - d * 0.05).rgb;
  float motion = clamp(length(d) * 30.0, 0.0, 1.0);
  vec3 o = mix(w, trail, uTrails * motion);
  o += uShine * motion * 0.25 * vec3(0.6, 0.8, 1.0) * luma(o);
  outColor = vec4(o, 1.0);
}`;

class OpticalFlowFX extends BaseFX {
  constructor(r) {
    super(r);
    this.flowProg = r.fx(FLOW_FS);
    this.dispProg = r.fx(DISP_FS);
    this.outProg = r.fx(OUT_FS);
  }
  render(p, ctx, target) {
    const r = this.r;
    const fw = Math.max(8, Math.round(r.w / 4)), fh = Math.max(8, Math.round(r.h / 4));
    const flow = this.target('flow', fw, fh, { float: true });
    const disp = this.pp('disp', fw, fh, { float: true });
    const out = this.pp('out', r.w, r.h);
    if (ctx.step) {
      const rad = p.smooth * r.h / 720;
      r.pass(this.flowProg, flow, { uStep: [rad / r.w, rad / r.h] }, { uCur: r.cur, uPrev: r.prev });
      r.pass(this.dispProg, disp.write, { uDecay: p.decay, uGain: p.gain, uMax: 0.12 }, { uDisp: disp.read, uFlow: flow });
      disp.swap();
    }
    r.pass(this.outProg, out.write, { uWarp: p.warp, uTrails: p.trails, uChroma: p.chroma, uShine: p.shine },
      { uSrc: r.cur, uPrevOut: out.read, uDisp: disp.read, uFlow: flow });
    this.present(out, target, ctx.step);
  }
}

export default {
  id: 'optical-flow',
  name: 'Optical Flow',
  description: 'Motion reactive liquid optical flow. Great for high motion input.',
  swatch: ['#3a2f2a', '#e8ddd0'],
  params: [
    { id: 'warp', label: 'Liquid Warp', min: 0, max: 3, step: 0.01, value: 1.2, mod: { band: 'mid', depth: 0.3 } },
    { id: 'gain', label: 'Motion Gain', min: 0, max: 3, step: 0.01, value: 0.8, mod: { band: 'bass', depth: 0.3 } },
    { id: 'decay', label: 'Viscosity', min: 0.5, max: 0.99, step: 0.005, value: 0.93 },
    { id: 'trails', label: 'Trails', min: 0, max: 0.98, step: 0.01, value: 0.55 },
    { id: 'smooth', label: 'Flow Window', min: 2, max: 24, step: 0.5, value: 8 },
    { id: 'chroma', label: 'Chroma Drift', min: 0, max: 1, step: 0.01, value: 0.25, mod: { band: 'highmid', depth: 0.4 } },
    { id: 'shine', label: 'Sheen', min: 0, max: 1, step: 0.01, value: 0.2 },
  ],
  create: r => new OpticalFlowFX(r),
};
