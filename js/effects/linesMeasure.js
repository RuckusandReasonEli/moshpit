import { BaseFX, FS_IO } from '../gl.js';

// Shi-Tomasi corner response on a small copy of the frame ("sharp points").
const CORNER_FS = FS_IO + /* glsl */ `
uniform sampler2D uSrc; uniform vec2 uPx;
float L(vec2 o) { return luma(texture(uSrc, vUv + o * uPx).rgb); }
void main() {
  float sxx = 0.0, syy = 0.0, sxy = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 o = vec2(float(i), float(j));
    float gx = (L(o + vec2(1.0, 0.0)) - L(o - vec2(1.0, 0.0))) * 0.5;
    float gy = (L(o + vec2(0.0, 1.0)) - L(o - vec2(0.0, 1.0))) * 0.5;
    sxx += gx * gx; syy += gy * gy; sxy += gx * gy;
  }
  float tr = sxx + syy, det = sxx * syy - sxy * sxy;
  float lmin = 0.5 * (tr - sqrt(max(tr * tr - 4.0 * det, 0.0)));
  outColor = vec4(clamp(sqrt(max(lmin, 0.0)) * 5.0, 0.0, 1.0), 0.0, 0.0, 1.0);
}`;

const COMP_FS = FS_IO + /* glsl */ `
uniform sampler2D uSrc, uOv; uniform float uBg;
void main() {
  vec3 c = texture(uSrc, vUv).rgb;
  if (uBg > 0.5 && uBg < 1.5) c *= 0.5;
  else if (uBg > 1.5 && uBg < 2.5) c = vec3(luma(c)) * 0.62;
  else if (uBg > 2.5) c = vec3(0.0);
  vec4 o = texture(uOv, vUv);
  outColor = vec4(mix(c, o.rgb, o.a), 1.0);
}`;

const COLORS = ['#39ff88', '#53f0ff', '#ffffff', '#ffb02e', '#ff3b4e', '#ff4fd8'];

// Landmarks used from each MediaPipe model, with names and skeleton edges.
const FACE_PTS = { 468: 'R_EYE', 473: 'L_EYE', 1: 'NOSE', 61: 'MOUTH_R', 291: 'MOUTH_L', 0: 'LIP', 152: 'CHIN', 10: 'BROW' };
const FACE_EDGES = [[468, 473], [468, 1], [473, 1], [1, 0], [61, 0], [291, 0], [61, 152], [291, 152], [468, 10], [473, 10]];
const HAND_PTS = { 0: 'WRIST', 4: 'THUMB', 5: 'MCP_I', 8: 'INDEX', 9: 'MCP_M', 12: 'MIDDLE', 13: 'MCP_R', 16: 'RING', 17: 'MCP_P', 20: 'PINKY' };
const HAND_EDGES = [[0, 4], [0, 5], [0, 17], [5, 9], [9, 13], [13, 17], [5, 8], [9, 12], [13, 16], [17, 20]];
const POSE_PTS = { 0: 'HEAD', 11: 'L_SHLDR', 12: 'R_SHLDR', 13: 'L_ELBOW', 14: 'R_ELBOW', 15: 'L_WRIST', 16: 'R_WRIST', 23: 'L_HIP', 24: 'R_HIP', 25: 'L_KNEE', 26: 'R_KNEE', 27: 'L_ANKLE', 28: 'R_ANKLE' };
const POSE_EDGES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];

function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
function rnd(seed) { let t = (seed + 0x6d2b79f5) >>> 0; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const HEX = '0123456789ABCDEF', ALPHA = 'ABCDEFGHJKLMNPRSTUVWXYZ';

function code(id, tick) {
  const h = hashStr(id);
  const r = k => rnd(h + k * 977 + tick * 131);
  const fixed = k => rnd(h + k * 977);
  const d = (n, k) => String(Math.floor(r(k) * 10 ** n)).padStart(n, '0');
  const pick = (set, k) => set[Math.floor(fixed(k) * set.length)];
  switch (h % 7) {
    case 0: return `TRK-${pick(HEX, 1)}${pick(HEX, 2)}${pick(HEX, 3)} ${(r(4) * 9.99).toFixed(2)}`;
    case 1: return `${pick(ALPHA, 1)}${pick(ALPHA, 2)}_${d(3, 3)}`;
    case 2: return `ID ${String(Math.floor(fixed(5) * 9999)).padStart(4, '0')} / ${r(6).toFixed(3)}`;
    case 3: return `Δ${(r(7) * 99).toFixed(2)} ${pick(ALPHA, 8)}`;
    case 4: return `0x${pick(HEX, 9)}${pick(HEX, 10)}${d(2, 11)}`;
    case 5: return `${pick(ALPHA, 12)}${d(2, 13)}.${d(2, 14)}`;
    default: return `LOCK ${(80 + r(15) * 19.9).toFixed(1)}%`;
  }
}

class LinesFX extends BaseFX {
  constructor(r) {
    super(r);
    this.cornerProg = r.fx(CORNER_FS);
    this.compProg = r.fx(COMP_FS);
    this.canvas = document.createElement('canvas');
    this.g = this.canvas.getContext('2d');
    this.ovTex = r.gl.createTexture();
    const gl = r.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.ovTex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    this.people = new Map();   // id -> {x, y, name, ttl}
    this.corners = [];         // {id, x, y, ttl}
    this.edges = [];
    this.nextCorner = 1;
    this.frame = 0;
  }
  reset() { super.reset(); this.people.clear(); this.corners = []; }

  /* ----- point gathering ----- */
  gatherPeople(track, mode) {
    const seen = new Set();
    const edges = [];
    const add = (id, lm, name) => {
      if (!lm || (lm.v !== undefined && lm.v < 0.5)) return false;
      const p = this.people.get(id);
      if (p) { p.x += (lm.x - p.x) * 0.6; p.y += (lm.y - p.y) * 0.6; p.ttl = 6; }
      else this.people.set(id, { x: lm.x, y: lm.y, name, ttl: 6 });
      seen.add(id);
      return true;
    };
    const group = (list, pts, edgeList, prefix) => list.forEach((lms, gi) => {
      for (const k in pts) add(`${prefix}${gi}_${k}`, lms[k], pts[k]);
      for (const [a, b] of edgeList) edges.push([`${prefix}${gi}_${a}`, `${prefix}${gi}_${b}`]);
    });
    if (mode !== 2 && track) {
      group(track.faces || [], FACE_PTS, FACE_EDGES, 'f');
      group(track.hands || [], HAND_PTS, HAND_EDGES, 'h');
      group(track.poses || [], POSE_PTS, POSE_EDGES, 'p');
    }
    for (const [id, p] of this.people) if (!seen.has(id) && --p.ttl <= 0) this.people.delete(id);
    this.skeleton = edges;
  }

  gatherCorners(p) {
    const r = this.r, gl = r.gl;
    const lw = 192, lh = Math.max(16, Math.round(192 * r.h / r.w));
    const t = this.target('corner', lw, lh);
    r.pass(this.cornerProg, t, { uPx: [1 / lw, 1 / lh] }, { uSrc: r.cur });
    if (!this.buf || this.buf.length !== lw * lh * 4) this.buf = new Uint8Array(lw * lh * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.readPixels(0, 0, lw, lh, gl.RGBA, gl.UNSIGNED_BYTE, this.buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const v = (x, y) => this.buf[(y * lw + x) * 4];
    let max = 0;
    for (let i = 0; i < lw * lh; i++) max = Math.max(max, this.buf[i * 4]);
    const thr = Math.max(10, max * (0.75 - p.sensitivity * 0.6));
    const cand = [];
    for (let y = 3; y < lh - 3; y++) for (let x = 3; x < lw - 3; x++) {
      const c = v(x, y);
      if (c < thr) continue;
      let isMax = true;
      for (let j = -2; j <= 2 && isMax; j++) for (let i = -2; i <= 2; i++) if ((i || j) && v(x + i, y + j) > c) { isMax = false; break; }
      if (isMax) cand.push([c, (x + 0.5) / lw, (y + 0.5) / lh]);
    }
    // Spread points over the frame: bucket into a grid, then take the strongest
    // remaining point from each cell in turn (so one busy area can't hog them all).
    const want = Math.round(p.corners), pts = [], minD = 0.06;
    const gx = 5, gy = Math.max(2, Math.round(5 * r.h / r.w));
    const cells = Array.from({ length: gx * gy }, () => []);
    for (const c of cand) cells[Math.min(gy - 1, Math.floor(c[2] * gy)) * gx + Math.min(gx - 1, Math.floor(c[1] * gx))].push(c);
    cells.forEach(b => b.sort((a, b2) => b2[0] - a[0]));
    const order = cells.filter(b => b.length).sort((a, b) => b[0][0] - a[0][0]);
    const far = (x, y) => pts.every(q => Math.hypot(q[0] - x, (q[1] - y) * r.h / r.w) > minD);
    for (let round = 0; pts.length < want && round < 12; round++) {
      let added = false;
      for (const b of order) {
        if (pts.length >= want) break;
        while (b.length) { const [, x, y] = b.shift(); if (far(x, y)) { pts.push([x, y]); added = true; break; } }
      }
      if (!added) break;
    }
    // Match to existing corners so IDs (and labels) stay stable while points move.
    const used = new Set();
    for (const c of this.corners) {
      let best = -1, bd = 0.05;
      pts.forEach((q, i) => { if (!used.has(i)) { const d = Math.hypot(q[0] - c.x, q[1] - c.y); if (d < bd) { bd = d; best = i; } } });
      if (best >= 0) { used.add(best); c.x += (pts[best][0] - c.x) * 0.55; c.y += (pts[best][1] - c.y) * 0.55; c.ttl = 5; }
      else c.ttl--;
    }
    this.corners = this.corners.filter(c => c.ttl > 0);
    pts.forEach((q, i) => { if (!used.has(i) && this.corners.length < want + 8) this.corners.push({ id: 'c' + this.nextCorner++, x: q[0], y: q[1], ttl: 5, name: 'PT' }); });
  }

  /* ----- drawing ----- */
  draw(p, ctx) {
    const r = this.r, g = this.g, W = r.w, H = r.h;
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    g.clearRect(0, 0, W, H);
    const s = H / 720;
    const color = COLORS[Math.round(p.color)];
    const sx = (ctx.srcW || W) / W;      // measure in source-video pixels
    const pts = [];
    for (const [id, q] of this.people) pts.push({ id, x: q.x * W, y: (1 - q.y) * H, name: q.name, person: true });
    for (const c of this.corners) pts.push({ id: c.id, x: c.x * W, y: (1 - c.y) * H, name: c.name, person: false });
    const byId = new Map(pts.map(q => [q.id, q]));

    // Connections
    const mode = Math.round(p.connect);
    const edges = [];
    const k = Math.round(p.neighbors);
    const nearest = (list) => {
      for (const a of list) {
        const near = pts.filter(b => b !== a).map(b => [Math.hypot(a.x - b.x, a.y - b.y), b]).sort((x, y) => x[0] - y[0]).slice(0, k);
        for (const [, b] of near) if (a.id < b.id || !near.length) edges.push([a, b]); else edges.push([b, a]);
      }
    };
    if (mode === 0) {
      for (const [a, b] of this.skeleton || []) if (byId.has(a) && byId.has(b)) edges.push([byId.get(a), byId.get(b)]);
      nearest(pts.filter(q => !q.person));
    } else if (mode === 1) nearest(pts);
    else if (mode === 2) {
      const maxD = p.webRange * Math.max(W, H);
      for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) < maxD) edges.push([pts[i], pts[j]]);
    } else {
      const sorted = [...pts].sort((a, b) => a.x - b.x);
      for (let i = 1; i < sorted.length; i++) edges.push([sorted[i - 1], sorted[i]]);
    }
    const uniq = new Map();
    for (const [a, b] of edges) { const key = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id; if (!uniq.has(key)) uniq.set(key, [a, b, key]); }

    g.save();
    g.lineWidth = Math.max(1, p.lineWidth * s);
    g.strokeStyle = color;
    g.fillStyle = color;
    if (p.glow > 0.01) { g.shadowColor = color; g.shadowBlur = p.glow * 14 * s; }
    if (Math.round(p.lineStyle) === 1) g.setLineDash([6 * s, 5 * s]);
    g.globalAlpha = p.lineAlpha;
    g.beginPath();
    for (const [a, b] of uniq.values()) { g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); }
    g.stroke();
    g.setLineDash([]);
    g.globalAlpha = 1;

    // Markers
    const ms = p.markerSize * s;
    const marker = Math.round(p.marker);
    g.lineWidth = Math.max(1, 1.4 * s);
    for (const q of pts) {
      g.beginPath();
      if (marker === 0) { // tracker brackets
        const m = ms, c = ms * 0.45;
        for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          g.moveTo(q.x + dx * m, q.y + dy * m - dy * c); g.lineTo(q.x + dx * m, q.y + dy * m); g.lineTo(q.x + dx * m - dx * c, q.y + dy * m);
        }
        g.stroke();
        g.fillRect(q.x - 1.5 * s, q.y - 1.5 * s, 3 * s, 3 * s);
      } else if (marker === 1) { g.moveTo(q.x - ms, q.y); g.lineTo(q.x + ms, q.y); g.moveTo(q.x, q.y - ms); g.lineTo(q.x, q.y + ms); g.stroke(); }
      else if (marker === 2) { g.arc(q.x, q.y, ms * 0.8, 0, Math.PI * 2); g.stroke(); }
      else { g.arc(q.x, q.y, ms * 0.35, 0, Math.PI * 2); g.fill(); }
    }

    // Labels
    const textMode = Math.round(p.text);
    g.shadowBlur = 0;
    if (textMode !== 4) {
      const fs = Math.max(8, p.fontSize * s);
      g.font = `600 ${fs}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
      g.textBaseline = 'middle';
      const tick = Math.floor(ctx.time * 3);
      const show = id => rnd(hashStr(id) + 17) < p.density;
      const pick = id => (textMode === 3 ? Math.floor(rnd(hashStr(id) + 99) * 3) : textMode);
      const placed = [];
      const label = (txt, x, y) => {
        const w = g.measureText(txt).width + fs * 0.6;
        const box = [x, y - fs * 0.7, x + w, y + fs * 0.7];
        if (placed.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) return; // keep readouts legible
        placed.push(box);
        g.globalAlpha = 0.55; g.fillStyle = '#000'; g.fillRect(x, y - fs * 0.65, w, fs * 1.3);
        g.globalAlpha = 1; g.fillStyle = color; g.fillText(txt, x + fs * 0.3, y);
      };
      for (const q of [...pts].sort((a, b) => b.person - a.person)) {
        if (!q.person && !show(q.id + 'p')) continue;
        const m = pick(q.id + 'p');
        const txt = m === 0 || m === 1 ? `${q.person ? q.name + ' ' : ''}X${Math.round(q.x * sx)} Y${Math.round(q.y * sx)}` : code(q.id, tick);
        label(txt, q.x + ms + 4 * s, q.y - ms);
      }
      for (const [a, b, key] of uniq.values()) {
        if (!show(key)) continue;
        const m = pick(key);
        const d = Math.hypot(a.x - b.x, a.y - b.y) * sx;
        if (d < 30 * s) continue;
        const txt = m === 0 ? `${Math.round(d)}px` : m === 1 ? `${Math.round((a.x + b.x) / 2 * sx)},${Math.round((a.y + b.y) / 2 * sx)}` : code(key, tick);
        label(txt, (a.x + b.x) / 2 + 4 * s, (a.y + b.y) / 2);
      }
    }

    // HUD
    if (Math.round(p.hud) === 0) {
      const fs = 13 * s;
      g.font = `700 ${fs}px ui-monospace, Menlo, Consolas, monospace`;
      g.fillStyle = color; g.textBaseline = 'top';
      const t = ctx.time, fr = Math.floor((t % 1) * 30);
      const tc = `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(Math.floor(t) % 60).padStart(2, '0')}:${String(fr).padStart(2, '0')}`;
      g.fillText(`TRACKING  ${String(pts.length).padStart(2, '0')} PTS  ${String(uniq.size).padStart(3, '0')} LINKS`, 16 * s, 14 * s);
      g.fillText(`TC ${tc}`, 16 * s, 14 * s + fs * 1.4);
      g.textAlign = 'right';
      g.fillText(`${Math.round((ctx.srcW || W))}x${Math.round((ctx.srcH || H))}  SOLVE ${(0.18 + rnd(Math.floor(t * 2)) * 0.3).toFixed(3)}px`, W - 16 * s, 14 * s);
      g.textAlign = 'left';
      g.lineWidth = Math.max(1, 1.2 * s); g.strokeStyle = color; g.globalAlpha = 0.7;
      const c = 26 * s, m = 10 * s;
      g.beginPath();
      for (const [x, y, dx, dy] of [[m, m, 1, 1], [W - m, m, -1, 1], [W - m, H - m, -1, -1], [m, H - m, 1, -1]]) { g.moveTo(x + dx * c, y); g.lineTo(x, y); g.lineTo(x, y + dy * c); }
      g.stroke();
      g.globalAlpha = 1;
    }
    g.restore();
  }

  render(p, ctx, target) {
    const r = this.r, gl = r.gl;
    if (ctx.step) {
      const track = Math.round(p.track);
      if (ctx.track && ctx.track.fresh) this.gatherPeople(ctx.track, track);
      if (track !== 1 && p.corners >= 1) this.gatherCorners(p); else this.corners = [];
      if (track === 2) this.people.clear();
    }
    this.draw(p, ctx);
    gl.bindTexture(gl.TEXTURE_2D, this.ovTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    r.pass(this.compProg, target, { uBg: p.background }, { uSrc: r.cur, uOv: this.ovTex });
  }
  dispose() { super.dispose(); this.r.gl.deleteTexture(this.ovTex); }
}

export default {
  id: 'lines',
  name: 'Lines & Measurements',
  description: 'Motion-tracking overlay: finds eyes, mouth, fingertips, elbows and sharp points, then links them with live lines and readouts.',
  swatch: ['#06140c', '#39ff88'],
  needs: p => (Math.round(p.track) === 2 ? [] : ['face', 'hands', 'pose']),
  params: [
    { id: 'track', label: 'Track', type: 'select', options: ['People + sharp points', 'People only', 'Sharp points only'], value: 0 },
    { id: 'corners', label: 'Sharp Points', min: 0, max: 80, step: 1, value: 18 },
    { id: 'sensitivity', label: 'Point Sensitivity', min: 0, max: 1, step: 0.01, value: 0.5 },
    { id: 'connect', label: 'Connections', type: 'select', options: ['Skeleton + nearest', 'Nearest neighbors', 'Web', 'Chain'], value: 0 },
    { id: 'neighbors', label: 'Links per Point', min: 1, max: 5, step: 1, value: 2 },
    { id: 'webRange', label: 'Web Range', min: 0.05, max: 0.6, step: 0.01, value: 0.22 },
    { id: 'text', label: 'Readouts', type: 'select', options: ['Distances (px)', 'Coordinates (px)', 'Random codes', 'Mixed', 'None'], value: 3 },
    { id: 'density', label: 'Readout Density', min: 0, max: 1, step: 0.01, value: 0.5 },
    { id: 'fontSize', label: 'Text Size', min: 6, max: 28, step: 0.5, value: 12 },
    { id: 'color', label: 'Color', type: 'select', options: ['Tracker Green', 'Cyan', 'White', 'Amber', 'Red', 'Magenta'], value: 0 },
    { id: 'lineWidth', label: 'Line Width', min: 0.5, max: 6, step: 0.1, value: 1.2 },
    { id: 'lineAlpha', label: 'Line Opacity', min: 0.1, max: 1, step: 0.01, value: 0.85, mod: { band: 'hit', depth: 0.15 } },
    { id: 'lineStyle', label: 'Line Style', type: 'select', options: ['Solid', 'Dashed'], value: 0 },
    { id: 'marker', label: 'Markers', type: 'select', options: ['Tracker brackets', 'Crosshair', 'Circle', 'Dot'], value: 0 },
    { id: 'markerSize', label: 'Marker Size', min: 2, max: 30, step: 0.5, value: 9, mod: { band: 'bass', depth: 0.2 } },
    { id: 'glow', label: 'Glow', min: 0, max: 1, step: 0.01, value: 0.3 },
    { id: 'background', label: 'Footage', type: 'select', options: ['Original', 'Darkened', 'Mono', 'Black'], value: 1 },
    { id: 'hud', label: 'HUD Readout', type: 'select', options: ['On', 'Off'], value: 0 },
  ],
  create: r => new LinesFX(r),
};
