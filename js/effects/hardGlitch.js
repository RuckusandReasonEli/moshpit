import { BaseFX, FS_IO } from '../gl.js';

const FS = FS_IO + /* glsl */ `
uniform sampler2D uSrc;
uniform float uAmount, uGrid, uSplit, uSpeed, uCorrupt, uDrift;
void main() {
  vec2 uv = vUv;
  float tq = floor(uTime * uSpeed * 12.0);
  vec2 off = vec2(0.0);
  float hit = 0.0;
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    float s = pow(2.4, fk);
    vec2 grid = vec2(2.0, 7.0) * uGrid * s;
    vec2 cell = floor(uv * grid);
    float h = hash12(cell + vec2(tq * 1.37 + fk * 17.0, fk * 3.1));
    if (h < uAmount * 0.38 / (1.0 + fk * 0.4)) {
      vec2 rnd = hash22(cell + tq + fk * 9.0) - 0.5;
      off += rnd * vec2(0.45, 0.07 * uDrift) / s;
      hit = 1.0;
    }
  }
  vec2 duv = fract(uv + off);
  float sp = uSplit * 0.035 * (0.25 + hit);
  vec3 col;
  col.r = texture(uSrc, fract(duv + vec2(sp, 0.0))).r;
  col.g = texture(uSrc, duv).g;
  col.b = texture(uSrc, fract(duv - vec2(sp, sp * 0.25))).b;
  if (hit > 0.5 && uCorrupt > 0.001) {
    vec2 g = vec2(48.0, 27.0);
    vec2 bc = floor(duv * g);
    float hc = hash12(bc + tq * 0.71);
    if (hc < uCorrupt) {
      col = texture(uSrc, (bc + 0.5) / g).rgb;
      if (hc < uCorrupt * 0.35) col = col.brg;
      if (hc < uCorrupt * 0.12) col = 1.0 - col;
    }
  }
  outColor = vec4(col, 1.0);
}`;

class HardGlitchFX extends BaseFX {
  constructor(r) { super(r); this.prog = r.fx(FS); }
  render(p, ctx, target) {
    this.r.pass(this.prog, target, {
      uAmount: p.amount, uGrid: p.scale, uSplit: p.split, uSpeed: p.speed, uCorrupt: p.corrupt, uDrift: p.drift,
    }, { uSrc: this.r.cur });
  }
}

export default {
  id: 'hard-glitch',
  name: 'Hard Glitch',
  description: 'Chunky hard multi-scale randomized displacement. Control amount, scale, color split and speed.',
  swatch: ['#222a05', '#ff3d6e'],
  params: [
    { id: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, value: 0.45, mod: { band: 'hit', depth: 0.5 } },
    { id: 'scale', label: 'Scale', min: 0.3, max: 6, step: 0.01, value: 1.5 },
    { id: 'split', label: 'Color Split', min: 0, max: 1, step: 0.01, value: 0.45, mod: { band: 'bass', depth: 0.3 } },
    { id: 'speed', label: 'Speed', min: 0, max: 3, step: 0.01, value: 0.8 },
    { id: 'corrupt', label: 'Corruption', min: 0, max: 1, step: 0.01, value: 0.3, mod: { band: 'highmid', depth: 0.3 } },
    { id: 'drift', label: 'Vertical Jolt', min: 0, max: 3, step: 0.01, value: 1 },
  ],
  create: r => new HardGlitchFX(r),
};
