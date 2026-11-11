// Recording helpers for MediaRecorder output.

const MP4 = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1.4d0028,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a',
  'video/mp4',
];
const WEBM = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

export function pickMime(pref = 'auto') {
  const list = pref === 'webm' ? [...WEBM, ...MP4] : [...MP4, ...WEBM];
  return list.find(m => MediaRecorder.isTypeSupported(m)) || '';
}

// Glitch art is noisy, so bitrates run higher than for normal footage.
export function bitrateFor(w, h, quality) {
  const bpp = { high: 0.28, medium: 0.16, low: 0.08 }[quality] || 0.16;
  return Math.round(Math.min(40e6, Math.max(2e6, w * h * 30 * bpp)));
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  return url;
}
