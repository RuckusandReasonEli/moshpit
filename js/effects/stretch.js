import { BaseFX, FS_IO } from '../gl.js';

const FS = FS_IO + /* glsl */ `
uniform sampler2D uSrc;
uniform float uPos, uDir, uWave, uWaveFreq, uJag, uJagSize, uAnim, uAnimSpeed, uFade;
// Local space: x runs across the stretch, y runs along it; everything past uPos is smeared.
vec2 toLocal(vec2 uv) {
  if (uDir < 0.5) return vec2(uv.x, 1.0 - uv.y);
  if (uDir < 1.5) return uv;
  if (uDir < 2.5) return vec2(uv.y, uv.x);
  return vec2(uv.y, 1.0 - uv.x);
}
vec2 fromLocal(vec2 l) {
  if (uDir < 0.5) return vec2(l.x, 1.0 - l.y);
  if (uDir < 1.5) return l;
  if (uDir < 2.5) return vec2(l.y, l.x);
  return vec2(1.0 - l.y, l.x);
}
void main() {
  vec2 l = toLocal(vUv);
  float pos = clamp(uPos + sin(uTime * uAnimSpeed) * uAnim * 0.3, 0.0, 1.0);
  float shade = 1.0;
  if (l.y > pos) {
    float dist = l.y - pos;
    float s = l.x;
    s += sin(dist * uWaveFreq * 25.0 - uTime * 3.0) * uWave * 0.05 * smoothstep(0.0, 0.15, dist);
    float stepN = floor(dist * 60.0 / max(uJagSize, 0.05));
    s += (hash11(stepN * 1.37 + floor(uTime * 6.0) * 0.13) - 0.5) * uJag * 0.07;
    l = vec2(s, pos);
    shade = 1.0 - uFade * smoothstep(0.0, 1.0, dist);
  }
  outColor = vec4(texture(uSrc, fromLocal(l)).rgb * shade, 1.0);
}`;

class StretchFX extends BaseFX {
  constructor(r) { super(r); this.prog = r.fx(FS); }
  render(p, ctx, target) {
    this.r.pass(this.prog, target, {
      uPos: p.position, uDir: p.direction, uWave: p.wave, uWaveFreq: p.waveFreq, uJag: p.jaggies,
      uJagSize: p.jagSize, uAnim: p.anim, uAnimSpeed: p.animSpeed, uFade: p.fade,
    }, { uSrc: this.r.cur });
  }
}

export default {
  id: 'stretch',
  name: 'Stretch',
  description: 'Stretch out area of input with optional wave and jaggies.',
  swatch: ['#0a2260', '#ff5d7a'],
  params: [
    { id: 'position', label: 'Position', min: 0, max: 1, step: 0.001, value: 0.45, mod: { band: 'bass', depth: 0.15 } },
    { id: 'wave', label: 'Wave', min: 0, max: 2, step: 0.01, value: 0.6, mod: { band: 'mid', depth: 0.4 } },
    { id: 'waveFreq', label: 'Wave Frequency', min: 0.1, max: 4, step: 0.01, value: 1.2 },
    { id: 'jaggies', label: 'Jaggies', min: 0, max: 2, step: 0.01, value: 0.4, mod: { band: 'hit', depth: 0.4 } },
    { id: 'jagSize', label: 'Jag Size', min: 0.1, max: 4, step: 0.01, value: 0.8 },
    { id: 'anim', label: 'Animate', min: 0, max: 1, step: 0.01, value: 0 },
    { id: 'animSpeed', label: 'Animate Speed', min: 0, max: 4, step: 0.01, value: 1 },
    { id: 'fade', label: 'Fade', min: 0, max: 1, step: 0.01, value: 0 },
    { id: 'direction', label: 'Direction', type: 'select', options: ['Down', 'Up', 'Right', 'Left'], value: 0 },
  ],
  create: r => new StretchFX(r),
};
