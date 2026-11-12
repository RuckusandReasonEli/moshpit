// Phone/tablet helpers, mostly for iOS Safari's media rules.

export const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const IS_MOBILE = IS_IOS || /Android|Mobi/i.test(navigator.userAgent) || matchMedia('(pointer: coarse)').matches;

/** Let audio play even with the iPhone's ring/silent switch on (Safari 16.4+). */
export function usePlaybackAudioSession() {
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* not supported */ }
}

/** Keep the screen awake during a render; locking the phone would stop it. */
export async function keepAwake() {
  try { return navigator.wakeLock ? await navigator.wakeLock.request('screen') : null; } catch (e) { return null; }
}

/** Wait for metadata only: iOS doesn't load frames (loadeddata) until playback starts. */
export function waitForMetadata(media) {
  return new Promise((res, rej) => {
    if (media.readyState >= 1) { res(); return; }
    media.addEventListener('loadedmetadata', res, { once: true });
    media.addEventListener('error', () => rej(new Error('decode')), { once: true });
  });
}
