/**
 * Tiny seeded pseudo-random number generator.
 *
 * Uses mulberry32 — small, fast, good distribution for our use case
 * (deterministic-from-seed tour planning). NOT cryptographic.
 *
 *   const rng = mulberry32(seed);
 *   rng();       // -> float in [0, 1)
 */

export function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Convenience: pick one element from `arr` using rng.
 */
export function pickRandom(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * Weighted pick: arr is [{score, ...}, ...]. Higher score = more likely.
 * Negative or zero scores are clamped to 0.
 */
export function weightedPick(rng, arr) {
  const weights = arr.map((x) => Math.max(0, x.score));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total === 0) return arr[Math.floor(rng() * arr.length)];
  let r = rng() * total;
  for (let i = 0; i < arr.length; i++) {
    r -= weights[i];
    if (r <= 0) return arr[i];
  }
  return arr[arr.length - 1];
}
