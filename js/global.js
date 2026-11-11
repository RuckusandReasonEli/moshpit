// Global Effects: a standard grading/editing stage applied to every frame
// BEFORE the selected effect (so motion-based effects see the graded image too).
import { FS_IO } from './gl.js';

const BLUR_FS = FS_IO + /* glsl */ `
uniform sampler2D uTex; uniform vec2 uDir;
void main() {
  vec3 c = vec3(0.0); float ws = 0.0;
  for (int i = -7; i <= 7; i++) {
    float f = float(i) / 7.0;
    float w = exp(-f * f * 4.0);
    c += texture(uTex, vUv + uDir * f).rgb * w; ws += w;
  }
  outColor = vec4(c / ws, 1.0);
}`;

const GRADE_FS = FS_IO + /* glsl */ `
uniform sampler2D uBase, uSoft;
uniform float uExposure, uContrast, uBrightness, uHighlights, uShadows, uGamma, uFade;
uniform float uSat, uVibrance, uTemp, uTint, uHue;
uniform float uSoftness, uSharpen, uGrain, uUseSoft;
uniform vec3 uOverlay; uniform float uOverlayAmt, uOverlayMode;
uniform float uVignette, uVigSize, uZoom, uFlip;

vec3 overlayBlend(vec3 b, vec3 o, float mode) {
  if (mode < 0.5) return o;                                            // normal
  if (mode < 1.5) return b * o;                                        // multiply
  if (mode < 2.5) return 1.0 - (1.0 - b) * (1.0 - o);                  // screen
  if (mode < 3.5) return mix(2.0 * b * o, 1.0 - 2.0 * (1.0 - b) * (1.0 - o), step(0.5, b)); // overlay
  if (mode < 4.5) return (1.0 - 2.0 * o) * b * b + 2.0 * o * b;        // soft light
  if (mode < 5.5) { float lo = max(luma(o), 0.02); return clamp(o * (luma(b) / lo), 0.0, 1.0); } // color
  return b + o;                                                        // add
}

void main() {
  vec2 uv = vUv;
  if (uFlip > 0.5 && uFlip < 1.5) uv.x = 1.0 - uv.x;
  else if (uFlip > 1.5 && uFlip < 2.5) uv.y = 1.0 - uv.y;
  else if (uFlip > 2.5) uv = 1.0 - uv;
  uv = (uv - 0.5) / uZoom + 0.5;

  vec3 c = texture(uBase, uv).rgb;
  if (uSharpen > 0.001) {
    vec2 px = 1.0 / uRes;
    vec3 n = texture(uBase, uv + vec2(px.x, 0.0)).rgb + texture(uBase, uv - vec2(px.x, 0.0)).rgb
           + texture(uBase, uv + vec2(0.0, px.y)).rgb + texture(uBase, uv - vec2(0.0, px.y)).rgb;
    c += (c - n * 0.25) * uSharpen;
  }
  if (uUseSoft > 0.5) {
    vec3 s = texture(uSoft, uv).rgb;
    c = mix(c, 1.0 - (1.0 - c) * (1.0 - s), uSoftness * 0.55);   // diffusion glow
    c = mix(c, s, uSoftness * 0.3);                               // and a touch of haze
  }

  // Light
  c *= exp2(uExposure);
  c *= vec3(1.0 + uTemp * 0.18 + uTint * 0.08, 1.0 - uTint * 0.16, 1.0 - uTemp * 0.18 + uTint * 0.08);
  float L = luma(c);
  c += uShadows * 0.35 * pow(clamp(1.0 - L, 0.0, 1.0), 3.0);
  c += uHighlights * 0.35 * pow(clamp(L, 0.0, 1.0), 3.0);
  c = (c - 0.5) * uContrast + 0.5 + uBrightness;
  c = pow(max(c, 0.0), vec3(1.0 / uGamma));

  // Color
  L = luma(c);
  c = mix(vec3(L), c, uSat);
  float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  c = mix(vec3(luma(c)), c, 1.0 + uVibrance * (1.0 - clamp(sat, 0.0, 1.0)));
  if (abs(uHue) > 0.01) c = hueShift(clamp(c, 0.0, 1.0), uHue / 360.0);
  c = c * (1.0 - uFade * 0.28) + uFade * 0.14;

  // Color overlay
  if (uOverlayAmt > 0.001) c = mix(c, overlayBlend(clamp(c, 0.0, 1.0), uOverlay, uOverlayMode), uOverlayAmt);

  // Lens
  if (uVignette > 0.001) {
    vec2 d = vUv - 0.5; d.x *= uRes.x / uRes.y;
    float v = 1.0 - smoothstep(uVigSize * 0.55, uVigSize * 0.55 + 0.55, length(d));
    c *= mix(1.0, v, uVignette);
  }
  if (uGrain > 0.001) c += (hash12(floor(vUv * uRes) + fract(uTime * 7.31) * 517.0) - 0.5) * uGrain * 0.22;
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

const hex3 = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);

export const GLOBAL = {
  id: 'global',
  name: 'Global Effects',
  params: [
    { group: 'Light', id: 'exposure', label: 'Exposure', min: -3, max: 3, step: 0.01, value: 0 },
    { group: 'Light', id: 'contrast', label: 'Contrast', min: 0, max: 2.5, step: 0.01, value: 1 },
    { group: 'Light', id: 'brightness', label: 'Brightness', min: -0.5, max: 0.5, step: 0.01, value: 0 },
    { group: 'Light', id: 'highlights', label: 'Highlights', min: -1, max: 1, step: 0.01, value: 0 },
    { group: 'Light', id: 'shadows', label: 'Shadows', min: -1, max: 1, step: 0.01, value: 0 },
    { group: 'Light', id: 'gamma', label: 'Gamma', min: 0.3, max: 3, step: 0.01, value: 1 },
    { group: 'Light', id: 'fade', label: 'Fade (matte blacks)', min: 0, max: 1, step: 0.01, value: 0 },
    { group: 'Color', id: 'saturation', label: 'Saturation', min: 0, max: 3, step: 0.01, value: 1 },
    { group: 'Color', id: 'vibrance', label: 'Vibrance', min: -1, max: 1, step: 0.01, value: 0 },
    { group: 'Color', id: 'temperature', label: 'Temperature', min: -1, max: 1, step: 0.01, value: 0 },
    { group: 'Color', id: 'tint', label: 'Tint', min: -1, max: 1, step: 0.01, value: 0 },
    { group: 'Color', id: 'hue', label: 'Hue Rotate', min: -180, max: 180, step: 1, value: 0 },
    { group: 'Detail', id: 'blur', label: 'Blur', min: 0, max: 40, step: 0.1, value: 0 },
    { group: 'Detail', id: 'softness', label: 'Softness (glow)', min: 0, max: 1, step: 0.01, value: 0 },
    { group: 'Detail', id: 'sharpen', label: 'Sharpen', min: 0, max: 3, step: 0.01, value: 0 },
    { group: 'Detail', id: 'grain', label: 'Film Grain', min: 0, max: 1, step: 0.01, value: 0 },
    { group: 'Color Overlay', id: 'overlayColor', label: 'Overlay Color', type: 'color', value: '#ff4fa3' },
    { group: 'Color Overlay', id: 'overlayAmt', label: 'Overlay Amount', min: 0, max: 1, step: 0.01, value: 0 },
    { group: 'Color Overlay', id: 'overlayMode', label: 'Overlay Blend', type: 'select', options: ['Normal', 'Multiply', 'Screen', 'Overlay', 'Soft Light', 'Color', 'Add'], value: 3 },
    { group: 'Lens & Frame', id: 'vignette', label: 'Vignette', min: 0, max: 1, step: 0.01, value: 0 },
    { group: 'Lens & Frame', id: 'vigSize', label: 'Vignette Size', min: 0.2, max: 1.5, step: 0.01, value: 0.8 },
    { group: 'Lens & Frame', id: 'zoom', label: 'Zoom (crop)', min: 1, max: 3, step: 0.01, value: 1 },
    { group: 'Lens & Frame', id: 'flip', label: 'Flip', type: 'select', options: ['None', 'Horizontal', 'Vertical', 'Both'], value: 0 },
  ],
};

const DEFAULTS = Object.fromEntries(GLOBAL.params.map(p => [p.id, p.value]));
const NEUTRAL_IGNORED = new Set(['overlayColor', 'overlayMode', 'vigSize']); // only matter when their amount is on

export function isNeutral(p) {
  for (const k in DEFAULTS) {
    if (NEUTRAL_IGNORED.has(k)) continue;
    if (Math.abs((p[k] ?? DEFAULTS[k]) - DEFAULTS[k]) > 1e-4) return false;
  }
  return true;
}

export class Grader {
  constructor(r) {
    this.r = r;
    this.blurProg = r.fx(BLUR_FS);
    this.gradeProg = r.fx(GRADE_FS);
    this.targets = {};
  }
  t(key, w, h) {
    const t = this.targets[key];
    if (t && t.w === w && t.h === h) return t;
    if (t) t.dispose();
    return (this.targets[key] = this.r.createTarget(w, h));
  }
  apply(raw, out, p) {
    const r = this.r;
    if (!p || isNeutral(p)) { r.blit(raw, out); return; }
    const sc = r.h / 720;
    let base = raw;
    if (p.blur > 0.05) {
      const a = this.t('ba', r.w, r.h), b = this.t('bb', r.w, r.h);
      const rad = p.blur * sc;
      r.pass(this.blurProg, a, { uDir: [rad / r.w, 0] }, { uTex: raw });
      r.pass(this.blurProg, b, { uDir: [0, rad / r.h] }, { uTex: a });
      base = b;
    }
    let soft = base, useSoft = 0;
    if (p.softness > 0.001) {
      const hw = Math.max(2, Math.ceil(r.w / 2)), hh = Math.max(2, Math.ceil(r.h / 2));
      const a = this.t('sa', hw, hh), b = this.t('sb', hw, hh);
      const rad = 14 * sc;
      r.pass(this.blurProg, a, { uDir: [rad / r.w, 0] }, { uTex: base });
      r.pass(this.blurProg, b, { uDir: [0, rad / r.h] }, { uTex: a });
      soft = b; useSoft = 1;
    }
    r.pass(this.gradeProg, out, {
      uExposure: p.exposure, uContrast: p.contrast, uBrightness: p.brightness, uHighlights: p.highlights,
      uShadows: p.shadows, uGamma: p.gamma, uFade: p.fade, uSat: p.saturation, uVibrance: p.vibrance,
      uTemp: p.temperature, uTint: p.tint, uHue: p.hue, uSoftness: p.softness, uSharpen: p.sharpen,
      uGrain: p.grain, uUseSoft: useSoft, uOverlay: hex3(p.overlayColor || '#000000'), uOverlayAmt: p.overlayAmt,
      uOverlayMode: p.overlayMode, uVignette: p.vignette, uVigSize: p.vigSize, uZoom: p.zoom, uFlip: p.flip,
    }, { uBase: base, uSoft: soft });
  }
}
