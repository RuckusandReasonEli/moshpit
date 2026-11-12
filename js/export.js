// Recording helpers for MediaRecorder output, and handing the result to the user.
import { IS_IOS } from './mobile.js';

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

/**
 * Show the finished video. Desktop downloads automatically. Phones get a
 * "Save video" button (share sheet, which on iPhone includes Save to Photos),
 * because iOS ignores downloads that don't come straight from a tap.
 * Returns the object URL so the caller can revoke it later.
 */
export function presentResult(blob, name, container) {
  const url = URL.createObjectURL(blob);
  const file = new File([blob], name, { type: blob.type });
  const mb = (blob.size / 1e6).toFixed(1);
  container.innerHTML = '';
  let canShare = false;
  try { canShare = !!(navigator.canShare && navigator.canShare({ files: [file] })); } catch (e) { canShare = false; }
  if (canShare) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary btn-block';
    btn.textContent = IS_IOS ? 'Save video (Photos, Files, AirDrop)' : 'Share or save video';
    btn.onclick = () => navigator.share({ files: [file], title: name }).catch(() => {});
    container.appendChild(btn);
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.className = 'btn btn-ghost btn-block';
  a.textContent = `Download ${name.split('.').pop().toUpperCase()} (${mb} MB)`;
  container.appendChild(a);
  container.hidden = false;
  if (!IS_IOS) a.click();
  return url;
}
