import { BaseFX, FS_IO } from '../gl.js';

const FS = FS_IO + /* glsl */ `
uniform sampler2D uSrc, uPrev;
uniform float uAmount, uZoom, uRotate, uWarp, uHue, uMode, uKey, uDriftX, uDriftY;
void main() {
  vec3 src = texture(uSrc, vUv).rgb;
  float aspect = uRes.x / uRes.y;
  vec2 c = vUv - 0.5;
  c.x *= aspect;
  float a = uRotate;
  c = mat2(cos(a), -sin(a), sin(a), cos(a)) * c;
  c /= uZoom;
  c += uWarp * 0.012 * vec2(sin(c.y * 9.0 + uTime * 1.7), cos(c.x * 9.0 - uTime * 1.3));
  c.x /= aspect;
  vec2 fuv = c + 0.5 - vec2(uDriftX, uDriftY) * 0.004;
  vec3 fb = texture(uPrev, fuv).rgb;
  fb *= step(0.0, fuv.x) * step(fuv.x, 1.0) * step(0.0, fuv.y) * step(fuv.y, 1.0);
  fb = hueShift(fb, uHue);
  vec3 o;
  if (uMode < 0.5) o = mix(src, fb, uAmount);
  else if (uMode < 1.5) o = max(src, fb * uAmount);
  else if (uMode < 2.5) { float k = smoothstep(uKey, uKey + 0.1, luma(src)); o = mix(fb * uAmount, src, k); }
  else o = abs(src - fb * uAmount);
  outColor = vec4(clamp(o, 0.0, 1.0), 1.0);
}`;

class FeedbackFX extends BaseFX {
  constructor(r) { super(r); this.prog = r.fx(FS); }
  render(p, ctx, target) {
    const r = this.r;
    const pp = this.pp('fb', r.w, r.h);
    r.pass(this.prog, pp.write, {
      uAmount: p.amount, uZoom: p.zoom, uRotate: p.rotate * Math.PI / 180, uWarp: p.warp,
      uHue: p.hue, uMode: p.mode, uKey: p.key, uDriftX: p.driftX, uDriftY: p.driftY,
    }, { uSrc: r.cur, uPrev: pp.read });
    this.present(pp, target, ctx.step);
  }
}

export default {
  id: 'feedback',
  name: 'Feedback',
  description: 'Temporal feedback. Motion trails. Control scale, rotation, warp and hue shift.',
  swatch: ['#1a2a1a', '#b9ff9c'],
  params: [
    { id: 'amount', label: 'Feedback', min: 0, max: 0.99, step: 0.005, value: 0.86, mod: { band: 'lowmid', depth: 0.12 } },
    { id: 'zoom', label: 'Scale', min: 0.9, max: 1.1, step: 0.001, value: 1.012, mod: { band: 'bass', depth: 0.08 } },
    { id: 'rotate', label: 'Rotation', min: -5, max: 5, step: 0.05, value: 0.4 },
    { id: 'warp', label: 'Warp', min: 0, max: 2, step: 0.01, value: 0.4, mod: { band: 'mid', depth: 0.3 } },
    { id: 'hue', label: 'Hue Shift', min: -0.1, max: 0.1, step: 0.001, value: 0.018, mod: { band: 'highmid', depth: 0.2 } },
    { id: 'driftX', label: 'Drift X', min: -2, max: 2, step: 0.01, value: 0 },
    { id: 'driftY', label: 'Drift Y', min: -2, max: 2, step: 0.01, value: 0 },
    { id: 'key', label: 'Key Level', min: 0, max: 1, step: 0.01, value: 0.45 },
    { id: 'mode', label: 'Blend Mode', type: 'select', options: ['Blend', 'Lighten', 'Luma Key', 'Difference'], value: 0 },
  ],
  create: r => new FeedbackFX(r),
};
