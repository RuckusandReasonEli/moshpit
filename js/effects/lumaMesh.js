import { BaseFX, FS_IO } from '../gl.js';

const VS = /* glsl */ `
in vec2 aUv;
uniform sampler2D uSrc;
uniform float uHeight, uTiltX, uTiltY, uZoom, uAspect, uBright, uPointSize;
uniform vec2 uShift, uTexel;
out vec3 vColor;
void main() {
  vec3 c = textureLod(uSrc, aUv, 0.0).rgb * 0.4
         + textureLod(uSrc, aUv + vec2(uTexel.x, 0.0), 0.0).rgb * 0.15
         + textureLod(uSrc, aUv - vec2(uTexel.x, 0.0), 0.0).rgb * 0.15
         + textureLod(uSrc, aUv + vec2(0.0, uTexel.y), 0.0).rgb * 0.15
         + textureLod(uSrc, aUv - vec2(0.0, uTexel.y), 0.0).rgb * 0.15;
  float l = luma(c);
  vec3 p = vec3((aUv.x - 0.5) * uAspect, aUv.y - 0.5, l * uHeight);
  float cx = cos(uTiltX), sx = sin(uTiltX);
  p = vec3(p.x, p.y * cx - p.z * sx, p.y * sx + p.z * cx);
  float cy = cos(uTiltY), sy = sin(uTiltY);
  p = vec3(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy);
  p.xy += uShift;
  float camZ = 1.6;
  float z = max(0.05, camZ - p.z);
  float f = 2.0 * camZ * uZoom;
  gl_Position = vec4(p.x * f / uAspect, p.y * f, 0.0, z);
  gl_PointSize = uPointSize;
  vColor = c * uBright * (0.35 + l * 1.3);
}`;

const FS = /* glsl */ `
in vec3 vColor;
out vec4 outColor;
void main() { outColor = vec4(vColor, 1.0); }`;

const BG_FS = FS_IO + /* glsl */ `
uniform sampler2D uSrc; uniform vec3 uBg; uniform float uSrcMix;
void main() { outColor = vec4(uBg + texture(uSrc, vUv).rgb * uSrcMix, 1.0); }`;

const BACKGROUNDS = [[0, 0, 0], [0.02, 0.03, 0.22], [0, 0, 0]];

class LumaMeshFX extends BaseFX {
  constructor(r) {
    super(r);
    this.prog = r.program(FS, VS);
    this.bgProg = r.fx(BG_FS);
    this.buf = r.gl.createBuffer();
    this.vao = r.gl.createVertexArray();
    this.key = '';
    this.count = 0;
  }

  build(rows, mode, aspect) {
    const key = `${rows}|${mode}|${aspect.toFixed(3)}`;
    if (key === this.key) return;
    this.key = key;
    const cols = Math.max(2, Math.round(rows * aspect));
    const out = [];
    if (mode === 2) {
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) out.push((x + 0.5) / cols, (y + 0.5) / rows);
    } else {
      for (let y = 0; y < rows; y++) {
        const v = (y + 0.5) / rows;
        for (let x = 0; x < cols - 1; x++) out.push((x + 0.5) / cols, v, (x + 1.5) / cols, v);
      }
      if (mode === 1) {
        for (let x = 0; x < cols; x++) {
          const u = (x + 0.5) / cols;
          for (let y = 0; y < rows - 1; y++) out.push(u, (y + 0.5) / rows, u, (y + 1.5) / rows);
        }
      }
    }
    const gl = this.r.gl;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(out), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.count = out.length / 2;
    this.mode = mode;
  }

  render(p, ctx, target) {
    const r = this.r, gl = r.gl;
    const aspect = r.w / r.h;
    const mode = Math.round(p.mode);
    this.build(Math.round(p.density), mode, aspect);

    const bg = Math.round(p.background);
    r.pass(this.bgProg, target, { uBg: BACKGROUNDS[bg], uSrcMix: bg === 2 ? 0.18 : 0 }, { uSrc: r.cur });

    const [w, h] = r.bindTarget(target);
    const deg = Math.PI / 180;
    const t = ctx.time * p.speed;
    const tiltX = (p.tilt + Math.sin(t) * p.motion * 0.6) * deg;
    const tiltY = Math.cos(t * 0.73) * p.motion * deg;
    gl.useProgram(this.prog.p);
    r.bindTextures(this.prog, { uSrc: r.cur });
    r.setCommon(this.prog, w, h);
    r.setUniforms(this.prog, {
      uHeight: p.height, uTiltX: tiltX, uTiltY: tiltY, uZoom: p.zoom, uAspect: aspect,
      uBright: p.brightness, uPointSize: Math.max(1, 1.5 * r.h / 540), uTexel: [1.5 / r.w, 1.5 / r.h],
    });
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.bindVertexArray(this.vao);
    const prim = mode === 2 ? gl.POINTS : gl.LINES;
    const split = p.split * 0.012;
    if (split > 0.0005) {
      const passes = [[true, false, false, -split], [false, true, false, 0], [false, false, true, split]];
      for (const [cr, cg, cb, s] of passes) {
        gl.colorMask(cr, cg, cb, false);
        r.setUniforms(this.prog, { uShift: [s, s * 0.35] });
        gl.drawArrays(prim, 0, this.count);
      }
      gl.colorMask(true, true, true, true);
    } else {
      r.setUniforms(this.prog, { uShift: [0, 0] });
      gl.drawArrays(prim, 0, this.count);
    }
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  dispose() { super.dispose(); this.r.gl.deleteBuffer(this.buf); this.r.gl.deleteVertexArray(this.vao); }
}

export default {
  id: 'luma-mesh',
  name: 'Luma Mesh',
  description: '3D luminance depth distortion light grid. Control height, 3D tilt motion.',
  swatch: ['#0b1460', '#ff5fb7'],
  params: [
    { id: 'height', label: 'Height', min: 0, max: 1.2, step: 0.01, value: 0.45, mod: { band: 'bass', depth: 0.35 } },
    { id: 'density', label: 'Density', min: 30, max: 260, step: 1, value: 130 },
    { id: 'tilt', label: 'Tilt', min: -70, max: 70, step: 1, value: 28 },
    { id: 'motion', label: '3D Motion', min: 0, max: 45, step: 0.5, value: 12, mod: { band: 'mid', depth: 0.3 } },
    { id: 'speed', label: 'Motion Speed', min: 0, max: 3, step: 0.01, value: 0.6 },
    { id: 'zoom', label: 'Zoom', min: 0.5, max: 2, step: 0.01, value: 0.95 },
    { id: 'brightness', label: 'Brightness', min: 0.1, max: 3, step: 0.01, value: 1.1, mod: { band: 'highmid', depth: 0.2 } },
    { id: 'split', label: 'RGB Split', min: 0, max: 1, step: 0.01, value: 0.25, mod: { band: 'hit', depth: 0.5 } },
    { id: 'mode', label: 'Mesh', type: 'select', options: ['Scan Lines', 'Grid', 'Points'], value: 0 },
    { id: 'background', label: 'Background', type: 'select', options: ['Black', 'Deep Blue', 'Ghost Source'], value: 1 },
  ],
  create: r => new LumaMeshFX(r),
};
