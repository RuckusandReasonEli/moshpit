import { BaseFX, FS_IO } from '../gl.js';

const FS = FS_IO + /* glsl */ `
uniform sampler2D uSrc;
uniform float uAmount, uSize, uSpeed, uTear, uLens, uWave, uGlow;
void main() {
  vec2 uv = vUv;
  float t = uTime * uSpeed;
  float n = (noise(vec2(uv.y * uSize, t)) - 0.5) + 0.5 * (noise(vec2(uv.y * uSize * 3.7 + 10.0, t * 1.9)) - 0.5);
  float bands = 5.0 + uSize * 1.5;
  float band = floor(uv.y * bands);
  float tq = floor(t * 3.0);
  float tear = step(1.0 - uTear * 0.6, hash12(vec2(band, tq)));
  uv.x += tear * (hash12(vec2(band + 7.0, tq)) - 0.5) * 0.12 * uAmount;
  uv.x += sin(uv.y * 28.0 + t * 4.0) * uWave * 0.008;
  vec2 dir = vec2(n * uAmount * 0.07, n * uAmount * 0.006) + (vUv - 0.5) * uLens * 0.05;
  vec3 acc = vec3(0.0), wsum = vec3(0.0), glow = vec3(0.0);
  for (int i = 0; i < 14; i++) {
    float f = float(i) / 13.0;
    vec3 w = clamp(vec3(1.0 - abs(4.0 * f - 1.0), 1.0 - abs(4.0 * f - 2.0), 1.0 - abs(4.0 * f - 3.0)), 0.0, 1.0) + 0.04;
    vec3 s = texture(uSrc, uv + dir * (f - 0.5) * 2.0).rgb;
    acc += s * w; wsum += w;
    glow += texture(uSrc, uv + dir * (f - 0.5) * 5.0 + vec2(0.0, (f - 0.5) * 0.01)).rgb;
  }
  vec3 col = acc / wsum;
  col = mix(col, max(col, glow / 14.0), uGlow);
  outColor = vec4(col, 1.0);
}`;

class SoftGlitchFX extends BaseFX {
  constructor(r) { super(r); this.prog = r.fx(FS); }
  render(p, ctx, target) {
    this.r.pass(this.prog, target, {
      uAmount: p.amount, uSize: p.size, uSpeed: p.speed, uTear: p.tear, uLens: p.lens, uWave: p.wave, uGlow: p.glow,
    }, { uSrc: this.r.cur });
  }
}

export default {
  id: 'soft-glitch',
  name: 'Soft Glitch',
  description: 'Soft gradient chromatic aberration glitching.',
  swatch: ['#2a1a2a', '#ffcf8a'],
  params: [
    { id: 'amount', label: 'Amount', min: 0, max: 2, step: 0.01, value: 0.6, mod: { band: 'highmid', depth: 0.35 } },
    { id: 'size', label: 'Band Size', min: 0.5, max: 20, step: 0.1, value: 4 },
    { id: 'speed', label: 'Speed', min: 0, max: 6, step: 0.01, value: 1.2, mod: { band: 'mid', depth: 0.2 } },
    { id: 'tear', label: 'Tearing', min: 0, max: 1, step: 0.01, value: 0.2, mod: { band: 'hit', depth: 0.6 } },
    { id: 'lens', label: 'Lens Fringe', min: 0, max: 2, step: 0.01, value: 0.5 },
    { id: 'wave', label: 'Wave', min: 0, max: 2, step: 0.01, value: 0.2 },
    { id: 'glow', label: 'Glow', min: 0, max: 1, step: 0.01, value: 0.3 },
  ],
  create: r => new SoftGlitchFX(r),
};
