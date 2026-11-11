// Builds the cut list: segments that start on the beat grid, each assigned a clip.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Multipliers used when a cut is randomized (all land on the quarter-beat grid).
const RANDOM_MULTS = [0.5, 2, 0.25, 1.5, 3, 0.75];

/**
 * @param {object} o
 * @param {number} o.duration   timeline length in seconds
 * @param {number} o.bpm
 * @param {number} o.offset     time of the first beat in seconds (0..beat)
 * @param {number} o.every      beats per cut (0.25, 0.5, 1, 2 ...)
 * @param {number} o.randomness 0..1 chance that a cut length is varied
 * @param {string} o.order      'sequential' | 'random' | 'pingpong'
 * @param {number[]} o.clips    indexes of clips in rotation
 * @param {number} o.seed
 */
export function buildSchedule(o) {
  const rng = mulberry32(o.seed);
  const beat = 60 / o.bpm;
  const segs = [];
  if (!o.clips.length || !(o.duration > 0)) return segs;
  let t = o.offset - Math.ceil(o.offset / beat) * beat; // grid point at or before 0
  let n = 0, last = -1, dir = 1, pos = 0;
  while (t < o.duration && segs.length < 20000) {
    let beats = o.every;
    if (rng() < o.randomness) {
      const pool = RANDOM_MULTS.slice(0, 2 + Math.round(o.randomness * 4));
      beats = o.every * pool[Math.floor(rng() * pool.length)];
    }
    beats = Math.max(0.25, Math.round(beats * 4) / 4);
    let clip;
    if (o.order === 'random') {
      if (o.clips.length === 1) clip = o.clips[0];
      else do { clip = o.clips[Math.floor(rng() * o.clips.length)]; } while (clip === last);
    } else if (o.order === 'pingpong' && o.clips.length > 1) {
      clip = o.clips[pos];
      if (pos + dir < 0 || pos + dir >= o.clips.length) dir = -dir;
      pos += dir;
    } else clip = o.clips[n % o.clips.length];
    segs.push({ start: t, end: t + beats * beat, beats, clip, jump: rng() });
    last = clip;
    t += beats * beat;
    n++;
  }
  return segs;
}

export function findSegment(segs, t) {
  let lo = 0, hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].start <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}
