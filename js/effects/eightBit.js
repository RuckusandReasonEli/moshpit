import { BaseFX, FS_IO } from '../gl.js';

const FS = FS_IO + /* glsl */ `
uniform sampler2D uSrc;
uniform float uPixel, uDither, uContrast, uBright, uSat, uScan;
uniform vec3 uPal[4];
float bayer4(vec2 p) {
  const float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  int x = int(mod(p.x, 4.0)), y = int(mod(p.y, 4.0));
  return m[x + y * 4] / 16.0;
}
void main() {
  float px = max(1.0, uPixel * uScale);
  vec2 cells = uRes / px;
  vec2 cell = floor(vUv * cells);
  vec3 c = texture(uSrc, (cell + 0.5) / cells).rgb;
  c = mix(vec3(luma(c)), c, uSat);
  c = (c - 0.5) * uContrast + 0.5 + uBright;
  c += (bayer4(cell) - 0.47) * uDither * 0.6;
  float best = 1e9; vec3 o = uPal[0];
  for (int i = 0; i < 4; i++) {
    vec3 d = c - uPal[i];
    float dd = dot(d, d);
    if (dd < best) { best = dd; o = uPal[i]; }
  }
  float row = floor(vUv.y * uRes.y / max(1.0, px * 0.5));
  o *= 1.0 - uScan * 0.35 * mod(row, 2.0);
  outColor = vec4(o, 1.0);
}`;

const h = v => [parseInt(v.slice(1, 3), 16) / 255, parseInt(v.slice(3, 5), 16) / 255, parseInt(v.slice(5, 7), 16) / 255];
const PALETTES = [
  ['#000000', '#55ffff', '#ff55ff', '#ffffff'], // CGA palette 1, high intensity
  ['#000000', '#55ff55', '#ff5555', '#ffff55'], // CGA palette 0, high intensity
  ['#000000', '#55ffff', '#ff5555', '#ffffff'], // CGA mode 5
].map(p => p.flatMap(h));

class EightBitFX extends BaseFX {
  constructor(r) { super(r); this.prog = r.fx(FS); }
  render(p, ctx, target) {
    this.r.pass(this.prog, target, {
      uPixel: p.pixel, uDither: p.dither, uContrast: p.contrast, uBright: p.brightness, uSat: p.saturation, uScan: p.scan,
      uPal: PALETTES[Math.round(p.palette)],
    }, { uSrc: this.r.cur });
  }
}

export default {
  id: 'eight-bit',
  name: '8-Bit',
  description: 'CGA style pixelation for that 1982 old school vibe. 3 preset color schemes.',
  swatch: ['#ff55ff', '#55ffff'],
  params: [
    { id: 'pixel', label: 'Pixel Size', min: 1, max: 24, step: 0.5, value: 4, mod: { band: 'bass', depth: 0.25 } },
    { id: 'dither', label: 'Dither', min: 0, max: 1.5, step: 0.01, value: 0.8 },
    { id: 'contrast', label: 'Contrast', min: 0.3, max: 3, step: 0.01, value: 1.3, mod: { band: 'mid', depth: 0.15 } },
    { id: 'brightness', label: 'Brightness', min: -0.5, max: 0.5, step: 0.01, value: 0.02 },
    { id: 'saturation', label: 'Saturation', min: 0, max: 3, step: 0.01, value: 1.6 },
    { id: 'scan', label: 'Scanlines', min: 0, max: 1, step: 0.01, value: 0 },
    { id: 'palette', label: 'Color Scheme', type: 'select', options: ['Cyan / Magenta', 'Green / Red / Yellow', 'Cyan / Red'], value: 0 },
  ],
  create: r => new EightBitFX(r),
};
