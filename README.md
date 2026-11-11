# Moshpit

In-browser video effects. Upload a clip, watch every effect preview live on a 3 second loop of your footage, link any parameter to the soundtrack's EQ, then render the full video and it downloads automatically. Nothing is uploaded to a server: decoding, effects (WebGL2 shaders) and encoding (MediaRecorder) all happen on the user's machine.

Two tools, switchable from the header:

- **Effects** (`index.html`): one clip through glitch, mosh and feedback effects, with audio-reactive EQ linking.
- **Beat Cut** (`cut.html`): up to 5 clips edited together on the beat.

## Beat Cut

1. Add up to 5 clips. Pick a soundtrack: any clip's audio, a separate song file (MP3, WAV, M4A, or a video), or none.
2. Set the tempo: type a BPM, tap along, or press **Detect beat from soundtrack** (finds the BPM and where the first beat lands). Use ÷2 / ×2 for half or double time and **Beat offset** to nudge the grid. Turn on **Click track** to hear the grid while previewing.
3. **Switch every** 1/4, 1/2, 1, 2, 4 or 8 beats. **Randomize timing** varies individual cut lengths (half, double, dotted and so on) while staying on the quarter-beat grid; **Reshuffle** rolls a new pattern.
4. **Clip order**: in order, random (never the same clip twice in a row) or ping-pong. **On each cut**: keep each clip rolling, or jump to a random spot in it.
5. **Overlap** keeps previous clips bleeding through the new one for up to 4 beats, using the **Overlap blend** mode (Screen, Add, Difference and Multiply get aggressive). Each clip has its own **Opacity**. Optional **Punch zoom** and **Flash** hit on every cut.
6. **Frame**: match the first clip, 16:9, 9:16 for Reels, 1:1 or 4:5. Clips are cropped to fill.
7. Set the **Start / End** section (cuts stay locked to the song's beat grid), then **Process & download**.

## Effects

| Effect | What it does |
| --- | --- |
| Luma Mesh | Brightness becomes depth on a 3D line/grid/point mesh with tilt motion and RGB split |
| Optical Flow | Lucas-Kanade motion estimation drives a liquid displacement field with trails |
| Data Mosh | Codec simulation: each frame is rebuilt from the previous output using block motion vectors, with residuals scaled down so keyframes "drop" |
| Feedback | Temporal feedback with scale, rotation, warp, drift, hue shift and 4 blend modes |
| Soft Glitch | Spectral (rainbow gradient) chromatic aberration, soft tearing and lens fringe |
| Hard Glitch | Multi-scale random block displacement, color split, block corruption |
| Stretch | Smears everything past a line, with wave and jaggies, in 4 directions |
| 8-Bit | Pixelation, Bayer dithering and 3 CGA palettes |

## Audio reactivity

If the video has an audio track, flip on **Audio reactivity**. The soundtrack is split into 8 sources:

Sub (20-60 Hz), Bass (60-250 Hz), Low Mid (250-500 Hz), Mid (500 Hz-2 kHz), High Mid (2-4 kHz), Presence (4-6 kHz), Air (6-16 kHz), and Bass Hit (a kick/transient trigger).

Every slider has a **+EQ** button: pick a band and a depth (negative depth inverts it). A cyan tick on the slider shows the live modulated value. Auto gain adapts each band to the song's loudness; Range and Smoothing tune how jumpy it feels. Each effect ships with sensible default links so it reacts as soon as you turn audio on.

## Rendering

Rendering plays the video once in real time while recording the canvas plus the original audio. A 2 minute video takes about 2 minutes. Keep the tab visible while it renders (browsers throttle background tabs). You can move sliders during a render and the changes are recorded, which works well for "performing" a take.

Output is MP4 where the browser can record it (Chrome 126+, Edge, Safari) and WebM otherwise (Firefox). Choose resolution, quality and whether to render the full video or just the preview window.

## Host it on GitHub Pages

1. Create a new repository on GitHub (for example `moshpit`).
2. Upload the contents of this folder to the repository root (`index.html` must be at the top level).
3. In the repository go to **Settings > Pages**, set **Source** to "Deploy from a branch", branch `main`, folder `/ (root)`, and save.
4. After a minute the site is live at `https://YOUR-USERNAME.github.io/moshpit/`.

Or from a terminal:

```bash
cd moshpit
git init && git add . && git commit -m "Moshpit"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/moshpit.git
git push -u origin main
```

## Run locally

The app uses ES modules, so open it through a local server rather than double-clicking the file:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Project layout

```
index.html          Effects tool
cut.html            Beat Cut tool
css/cut.css         Beat Cut styles
js/cut/main.js      Beat Cut: clips, clock, compositing, timeline, export
js/cut/beat.js      Tempo and beat-phase detection, tap tempo
js/cut/schedule.js  Seeded cut-list generator
css/style.css       Styles
js/main.js          App wiring: upload, playback loop, gallery, params, export
js/gl.js            WebGL2 core: shaders, render targets, ping-pong buffers, shared GLSL
js/audio.js         Web Audio analysis, EQ bands, transient detection
js/export.js        MediaRecorder format picking, bitrates, download
js/effects/*.js     One file per effect
js/effects/index.js Effect registry
```

## Adding an effect

Create `js/effects/myEffect.js`:

```js
import { BaseFX, FS_IO } from '../gl.js';

const FS = FS_IO + `
uniform sampler2D uSrc;
uniform float uAmount;
void main() {
  vec3 c = texture(uSrc, vUv).rgb;
  outColor = vec4(mix(c, 1.0 - c, uAmount), 1.0);
}`;

class MyFX extends BaseFX {
  constructor(r) { super(r); this.prog = r.fx(FS); }
  render(p, ctx, target) {
    this.r.pass(this.prog, target, { uAmount: p.amount }, { uSrc: this.r.cur });
  }
}

export default {
  id: 'invert',
  name: 'Invert',
  description: 'Flips the colors.',
  swatch: ['#111111', '#ffffff'],
  params: [
    { id: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, value: 1, mod: { band: 'bass', depth: 0.5 } },
  ],
  create: r => new MyFX(r),
};
```

Then add it to the array in `js/effects/index.js`. It appears in the gallery with sliders, EQ linking and export automatically.

Useful pieces available to every shader: `uRes`, `uTime` (video time), `uFrame`, `uScale` (render height / 720, for resolution-independent pixel sizes), and helpers `luma`, `hash11`, `hash12`, `hash22`, `noise`, `hueShift`, `rgb2hsv`, `hsv2rgb`. For effects that need the previous frame, use `r.prev`, and use `this.pp(...)` plus `this.present(...)` for feedback buffers (see `feedback.js`). Optical flow is available via `FLOW_GLSL`.

## Browser support

Recent Chrome, Edge, Firefox and Safari (WebGL2 and MediaRecorder required). Very large source files (4K) work but preview more smoothly on a dedicated GPU. Formats the browser cannot decode (some HEVC iPhone clips in Chrome or Firefox) will show an error; re-export those as H.264 first.
