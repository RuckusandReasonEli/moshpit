// WebGL2 rendering core: shader compilation, render targets, ping-pong buffers,
// fullscreen passes and the per-frame source upload shared by every effect.

const FUNCS = /* glsl */ `
uniform vec2 uRes;     // size of the target being drawn, in pixels
uniform float uTime;   // video media time in seconds
uniform float uFrame;  // frame counter
uniform float uScale;  // render height / 720, keeps pixel-sized params resolution independent

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
vec3 hueShift(vec3 c, float h) { vec3 hsv = rgb2hsv(c); hsv.x = fract(hsv.x + h); return hsv2rgb(hsv); }

// Vector storage: half-float targets when available, otherwise packed into RGBA8.
#if FLOAT_TARGETS
vec4 encV(vec2 v) { return vec4(v, 0.0, 1.0); }
vec2 decV(vec4 t) { return t.xy; }
#else
vec4 encV(vec2 v) { return vec4(clamp(v * 4.0 + 0.5, 0.0, 1.0), 0.0, 1.0); }
vec2 decV(vec4 t) { return (t.xy - 0.5) / 4.0; }
#endif
`;

// Lucas-Kanade optical flow over a 3x3 window. Returns displacement in UV units
// (motion from the previous frame to the current one).
export const FLOW_GLSL = /* glsl */ `
vec2 lkFlow(sampler2D cur, sampler2D prev, vec2 uv, vec2 h) {
  float sxx = 0.0, syy = 0.0, sxy = 0.0, sxt = 0.0, syt = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 p = uv + vec2(float(i), float(j)) * h;
      float ix = (luma(texture(cur, p + vec2(h.x, 0.0)).rgb) - luma(texture(cur, p - vec2(h.x, 0.0)).rgb)) * 0.5;
      float iy = (luma(texture(cur, p + vec2(0.0, h.y)).rgb) - luma(texture(cur, p - vec2(0.0, h.y)).rgb)) * 0.5;
      float it = luma(texture(cur, p).rgb) - luma(texture(prev, p).rgb);
      sxx += ix * ix; syy += iy * iy; sxy += ix * iy; sxt += ix * it; syt += iy * it;
    }
  }
  sxx += 0.0025; syy += 0.0025;
  float det = sxx * syy - sxy * sxy;
  vec2 v = vec2(sxy * syt - syy * sxt, sxy * sxt - sxx * syt) / det;
  v = clamp(v, -3.0, 3.0);
  v *= smoothstep(0.04, 0.25, length(v)); // dead zone kills sensor noise
  return v * h;
}
`;

export const FS_IO = `in vec2 vUv;\nout vec4 outColor;\n`;

const FULLSCREEN_VS = /* glsl */ `
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const COPY_FS = FS_IO + `uniform sampler2D uTex; void main() { outColor = vec4(texture(uTex, vUv).rgb, 1.0); }`;

const DOWN_FS = FS_IO + /* glsl */ `
uniform sampler2D uTex;
uniform vec2 uSpan;
uniform float uTaps;
void main() {
  vec3 c = vec3(0.0); float n = 0.0;
  for (int j = 0; j < 4; j++) {
    if (float(j) >= uTaps) break;
    for (int i = 0; i < 4; i++) {
      if (float(i) >= uTaps) break;
      vec2 o = (vec2(float(i), float(j)) + 0.5) / uTaps - 0.5;
      c += texture(uTex, vUv + o * uSpan).rgb; n += 1.0;
    }
  }
  outColor = vec4(c / n, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    console.error(src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n'));
    throw new Error('Shader compile error: ' + log);
  }
  return s;
}

class Program {
  constructor(gl, vs, fs) {
    this.gl = gl;
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aUv');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Program link error: ' + gl.getProgramInfoLog(p));
    this.p = p;
    this.locs = new Map();
    this.types = new Map();
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      this.types.set(info.name.replace(/\[0\]$/, ''), info.type);
    }
  }
  loc(name) {
    if (!this.locs.has(name)) this.locs.set(name, this.gl.getUniformLocation(this.p, name));
    return this.locs.get(name);
  }
}

function setUniform(gl, loc, v, type) {
  if (loc === null || v === undefined) return;
  if (typeof v === 'number' || typeof v === 'boolean') { gl.uniform1f(loc, +v); return; }
  if (type === gl.FLOAT_VEC4) gl.uniform4fv(loc, v);
  else if (type === gl.FLOAT_VEC3) gl.uniform3fv(loc, v);
  else if (type === gl.FLOAT_VEC2) gl.uniform2fv(loc, v);
  else if (type === gl.FLOAT) gl.uniform1fv(loc, v);
  else if (v.length === 2) gl.uniform2fv(loc, v);
  else if (v.length === 3) gl.uniform3fv(loc, v);
  else gl.uniform4fv(loc, v);
}

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.canvas = canvas;
    gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('EXT_color_buffer_half_float');
    this.floatOK = this._probeFloat();
    this.header = `#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\n#define FLOAT_TARGETS ${this.floatOK ? 1 : 0}\n` + FUNCS;
    this.vao = gl.createVertexArray();
    this.cache = new Map();
    this.srcTex = this._makeTex();
    this.frames = [null, null];
    this.fi = 0;
    this.time = 0;
    this.frameIndex = 0;
    this.hasFrame = false;
    this.w = 0; this.h = 0;
    this.copyProg = this.fx(COPY_FS);
    this.downProg = this.fx(DOWN_FS);
  }

  _probeFloat() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 4, 4, 0, gl.RGBA, gl.HALF_FLOAT, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    return ok;
  }

  _makeTex(filter) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    const f = filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** Compile (cached) a program from shader bodies. vs defaults to the fullscreen triangle. */
  program(fsBody, vsBody = FULLSCREEN_VS) {
    const key = vsBody + '\n//--\n' + fsBody;
    if (!this.cache.has(key)) this.cache.set(key, new Program(this.gl, this.header + vsBody, this.header + fsBody));
    return this.cache.get(key);
  }
  fx(fsBody) { return this.program(fsBody); }

  createTarget(w, h, { float = false, filter = 'linear' } = {}) {
    const gl = this.gl;
    const useFloat = float && this.floatOK;
    const tex = this._makeTex(filter);
    gl.texImage2D(gl.TEXTURE_2D, 0, useFloat ? gl.RGBA16F : gl.RGBA8, w, h, 0, gl.RGBA, useFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const clearColor = float && !useFloat ? [0.5, 0.5, 0, 1] : [0, 0, 0, 1];
    const t = {
      tex, fbo, w, h,
      clear: () => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.viewport(0, 0, w, h);
        gl.clearColor(...clearColor);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      },
      dispose: () => { gl.deleteFramebuffer(fbo); gl.deleteTexture(tex); },
    };
    t.clear();
    return t;
  }

  pingpong(w, h, opts) {
    const a = this.createTarget(w, h, opts), b = this.createTarget(w, h, opts);
    const pp = {
      read: a, write: b, w, h,
      swap() { const t = pp.read; pp.read = pp.write; pp.write = t; },
      clear() { a.clear(); b.clear(); },
      dispose() { a.dispose(); b.dispose(); },
    };
    return pp;
  }

  resize(w, h) {
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    this.canvas.width = w; this.canvas.height = h;
    this.frames.forEach(f => f && f.dispose());
    this.frames = [this.createTarget(w, h), this.createTarget(w, h)];
    if (this.raw) this.raw.dispose();
    this.raw = this.createTarget(w, h);
    this.hasFrame = false;
  }

  /** Upload a new video frame and downsample it into the current frame buffer. */
  upload(source, sw, sh) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this.fi ^= 1;
    const taps = Math.min(4, Math.max(1, Math.ceil(sw / this.w / 2)));
    const dest = this.grader ? this.raw : this.frames[this.fi];
    this.pass(this.downProg, dest, { uTaps: taps, uSpan: [1 / this.w, 1 / this.h] }, { uTex: this.srcTex });
    if (this.grader) this.grader.apply(this.raw, this.frames[this.fi], this.gradeParams);
    if (!this.hasFrame) {
      this.blit(this.frames[this.fi], this.frames[this.fi ^ 1]);
      this.hasFrame = true;
    }
  }
  /** Re-run the grading stage on the latest frame (used when paused and a global slider moves). */
  regrade() { if (this.grader && this.hasFrame) this.grader.apply(this.raw, this.frames[this.fi], this.gradeParams); }
  get cur() { return this.frames[this.fi]; }
  get prev() { return this.frames[this.fi ^ 1]; }

  bindTarget(target) {
    const gl = this.gl;
    const w = target ? target.w : this.canvas.width;
    const h = target ? target.h : this.canvas.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, w, h);
    return [w, h];
  }

  setCommon(prog, w, h) {
    const gl = this.gl;
    setUniform(gl, prog.loc('uRes'), [w, h]);
    setUniform(gl, prog.loc('uTime'), this.time);
    setUniform(gl, prog.loc('uFrame'), this.frameIndex);
    setUniform(gl, prog.loc('uScale'), this.h / 720);
  }

  bindTextures(prog, textures) {
    const gl = this.gl;
    let unit = 0;
    for (const name in textures) {
      const t = textures[name];
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t && t.tex ? t.tex : t);
      gl.uniform1i(prog.loc(name), unit);
      unit++;
    }
  }

  setUniforms(prog, uniforms) {
    for (const name in uniforms) setUniform(this.gl, prog.loc(name), uniforms[name], prog.types.get(name));
  }

  /** Draw a fullscreen pass into target (null = canvas). */
  pass(prog, target, uniforms = {}, textures = {}) {
    const gl = this.gl;
    const [w, h] = this.bindTarget(target);
    gl.useProgram(prog.p);
    this.bindTextures(prog, textures);
    this.setCommon(prog, w, h);
    this.setUniforms(prog, uniforms);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  blit(src, target) { this.pass(this.copyProg, target, {}, { uTex: src }); }
}

/** Base class for effects: owns render targets and handles reset/resize/dispose. */
export class BaseFX {
  constructor(r) { this.r = r; this.targets = {}; this.first = true; }
  target(key, w, h, opts) {
    const t = this.targets[key];
    if (t && t.w === w && t.h === h) return t;
    if (t) t.dispose();
    this.first = true;
    return (this.targets[key] = this.r.createTarget(w, h, opts));
  }
  pp(key, w, h, opts) {
    const t = this.targets[key];
    if (t && t.w === w && t.h === h) return t;
    if (t) t.dispose();
    this.first = true;
    return (this.targets[key] = this.r.pingpong(w, h, opts));
  }
  /** Show the newest state. When step is false we re-render without advancing time. */
  present(pp, target, step) {
    if (step) { pp.swap(); this.r.blit(pp.read, target); }
    else this.r.blit(pp.write, target);
  }
  reset() { Object.values(this.targets).forEach(t => t.clear()); this.first = true; }
  dispose() { Object.values(this.targets).forEach(t => t.dispose()); this.targets = {}; }
}
