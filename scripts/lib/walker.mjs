/**
 * walker.mjs
 *
 * Plans a parkour tour for the Spider-Man chibi over a list of buildings.
 *
 * Buildings are passed in directly from `svg-render.mjs` (which reads the
 * same `iso-projection.mjs` we do). Each building exposes `roof: {x, y}`
 * — the screen pixel where the chibi's feet plant. No parsing, no
 * coordinate-transform composition. This is what makes off-roof landings
 * impossible by construction.
 *
 * Gaming-AI techniques (named here so future-us remembers what's deliberate):
 *
 *   1. **Lévy walk** — step lengths drawn from a heavy-tailed Pareto
 *      distribution. Models animal foraging; produces clusters of small
 *      hops punctuated by occasional long leaps. Reads as natural, organic
 *      patrol behavior rather than a robotic grid sweep.
 *
 *   2. **Sector planning (1D k-means)** — bucket buildings into 3 west-to-
 *      east neighborhoods. Walker visits each in order, ensuring full
 *      coverage of the calendar instead of getting stuck in the densest
 *      cluster.
 *
 *   3. **Mood FSM** — one mood per sector visit (`prowl` / `hunt` / `dash`)
 *      controls hop cadence and idle frequency. Adds rhythmic variety.
 *
 *   4. **Steering: edge-bounce** — when a candidate landing leaves the
 *      sector bbox, the direction vector reflects inward. Keeps the walker
 *      in the city even with sparse skylines.
 *
 *   5. **Loop closure** — the final regional leap returns to the start so
 *      the SMIL animation loops seamlessly.
 *
 * SPEED_MULTIPLIER:
 *   Single knob that scales every jump duration and idle dwell. 1.40 means
 *   "all moves take 40% longer than baseline" — the spec's 40% slower agent.
 *   Tweak this one constant to adjust the entire animation pace.
 *
 * Output shape (consumed by `animations.mjs`):
 *   {
 *     events: [
 *       { type: 'start', at: building },
 *       { type: 'jump',  from, to, dur, arcHeight, facing, dist, isBridge?, mood },
 *       { type: 'idle',  at, dur, mood },
 *     ],
 *     totalDuration: number,
 *     playlist: string[],   // mood sequence, for logging
 *   }
 */

import { mulberry32 } from "./rng.mjs";

// ===== The single speed knob ============================================
//
// 1.0  = baseline pace (jumps in ~0.3s, idles ~0.5s)
// 1.40 = the spec's "40% slower" agent
// 2.0  = half-speed (very deliberate)

export const SPEED_MULTIPLIER = 1.4;

// ===== Configuration =====================================================

const DEFAULTS = {
  durationSec: 28, // baseline 20s × SPEED_MULTIPLIER
  // How many neighborhoods to split the city into. K-means-1D on roof.x.
  // Capped to floor(N/2) so each cluster has at least 2 buildings.
  sectorTargetCount: 3,
  // Per-mood Lévy parameters within a neighborhood.
  // idleProb is doubled vs. the "feels too rushed" baseline (0.22/0.10/0.02)
  // so the agent now pauses about every 2-3 jumps instead of every 4-6.
  moods: {
    prowl: { alpha: 1.7, idleProb: 0.44, hopRange: [0.34, 0.55] },
    hunt:  { alpha: 1.5, idleProb: 0.20, hopRange: [0.30, 0.50] },
    dash:  { alpha: 1.2, idleProb: 0.04, hopRange: [0.22, 0.42] },
  },
  // Regional-leap timing — the inter-sector jumps. Slightly slower with
  // a tall arc so the eye registers the "BIG jump" between zones.
  regionalLeapSec: 0.85,
  regionalArcPx: [22, 32],
  // Idle dwell sampling. Each range is the previous baseline ×1.2 — pauses
  // hold ~20% longer so the chibi visibly settles before the next jump.
  idleSec: { short: [0.48, 0.96], long: [1.44, 1.92], longProb: 0.15 },
  // Within-sector arc-height shaping.
  arcBasePx: 6,
  arcHeightCoeff: 0.45,
  arcJitterPx: 3,
  arcMinPx: 7,
  arcMaxPx: 22,
  // Step-rhythm "phrases". Each phrase is a list of step-size labels.
  phrases: [
    ["s", "s", "s", "s", "M"],
    ["s", "s", "M", "s", "s"],
    ["s", "s", "s", "B"],
    ["s", "M", "s", "s"],
    ["s", "s", "s", "s", "s", "B"],
    ["s", "s", "s", "M", "s"],
  ],
  // Step-size scales (multipliers on the sector's median nearest-neighbor
  // distance).
  stepScales: { s: [0.8, 1.4], M: [1.6, 2.6], B: [2.6, 4.0] },
  candidatePool: 12,
};

// ===== Utilities =========================================================

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickFrom(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

function median(arr) {
  if (arr.length === 0) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function distance(a, b) {
  return Math.hypot(b.roof.x - a.roof.x, b.roof.y - a.roof.y);
}

function sampleIdle(rng, cfg) {
  const long = rng() < cfg.idleSec.longProb;
  const [lo, hi] = long ? cfg.idleSec.long : cfg.idleSec.short;
  return lo + rng() * (hi - lo);
}

function paretoSample(rng, alpha) {
  const u = Math.max(rng(), 1e-9);
  return Math.pow(u, -1 / alpha);
}

function sampleStep(rng, label, baseUnit, alpha, cfg) {
  const [lo, hi] = cfg.stepScales[label] || cfg.stepScales.s;
  const pareto = clamp(paretoSample(rng, alpha) * 0.4, 0.6, 1.4);
  const scale = lo + rng() * (hi - lo);
  return baseUnit * scale * pareto;
}

function medianNearest(items) {
  if (items.length < 2) return 8;
  const dists = [];
  for (let i = 0; i < items.length; i++) {
    let best = Infinity;
    for (let j = 0; j < items.length; j++) {
      if (i === j) continue;
      const d = distance(items[i], items[j]);
      if (d < best) best = d;
    }
    if (Number.isFinite(best)) dists.push(best);
  }
  return median(dists) || 8;
}

function bbox(items) {
  if (!items || items.length === 0) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const b of items) {
    if (b.roof.x < minX) minX = b.roof.x;
    if (b.roof.x > maxX) maxX = b.roof.x;
    if (b.roof.y < minY) minY = b.roof.y;
    if (b.roof.y > maxY) maxY = b.roof.y;
  }
  return { minX, maxX, minY, maxY };
}

// ===== K-means-1D clustering on x ========================================

function kmeans1D(items, k, rng, iters = 12) {
  if (items.length <= k) return items.map((b) => [b]);
  const xs = items.map((b) => b.roof.x);
  const xmin = Math.min(...xs);
  const xmax = Math.max(...xs);
  let centers = Array.from({ length: k }, (_, i) =>
    xmin + ((xmax - xmin) * (i + 0.5)) / k + (rng() - 0.5) * 0.05 * (xmax - xmin)
  );
  let clusters;
  for (let it = 0; it < iters; it++) {
    clusters = Array.from({ length: k }, () => []);
    for (const b of items) {
      let bestI = 0;
      let bestD = Infinity;
      for (let i = 0; i < k; i++) {
        const d = Math.abs(b.roof.x - centers[i]);
        if (d < bestD) { bestD = d; bestI = i; }
      }
      clusters[bestI].push(b);
    }
    let moved = 0;
    for (let i = 0; i < k; i++) {
      if (clusters[i].length === 0) continue;
      const m = clusters[i].reduce((s, b) => s + b.roof.x, 0) / clusters[i].length;
      moved += Math.abs(m - centers[i]);
      centers[i] = m;
    }
    if (moved < 0.5) break;
  }
  const ordered = clusters
    .filter((c) => c.length > 0)
    .map((c) => ({
      buildings: c,
      cx: c.reduce((s, b) => s + b.roof.x, 0) / c.length,
    }))
    .sort((a, b) => a.cx - b.cx);
  return ordered.map((o) => o.buildings);
}

// ===== Direction picker (steering: edge-bounce) ==========================

function sampleDirection(cur, sectorBox, rng, desiredLen) {
  const theta = rng() * 2 * Math.PI;
  let dx = Math.cos(theta);
  let dy = Math.sin(theta);
  const ex = cur.roof.x + dx * desiredLen;
  const ey = cur.roof.y + dy * desiredLen;
  const margin = 6;
  if (ex < sectorBox.minX - margin) dx = Math.abs(dx);
  else if (ex > sectorBox.maxX + margin) dx = -Math.abs(dx);
  if (ey < sectorBox.minY - margin) dy = Math.abs(dy);
  else if (ey > sectorBox.maxY + margin) dy = -Math.abs(dy);
  return { dx, dy };
}

function pickNextInSector(sectorBuildings, cur, desiredLen, dx, dy, rng, cfg) {
  const dirMag = Math.hypot(dx, dy) || 1;
  const ux = dx / dirMag;
  const uy = dy / dirMag;
  const scored = [];
  for (const b of sectorBuildings) {
    if (b === cur) continue;
    const vx = b.roof.x - cur.roof.x;
    const vy = b.roof.y - cur.roof.y;
    const len = Math.hypot(vx, vy);
    if (len < 1e-3) continue;
    const cos = (vx * ux + vy * uy) / len;
    const lenPenalty = Math.abs(len - desiredLen) / Math.max(desiredLen, 1);
    const score = lenPenalty - 0.45 * Math.max(-1, Math.min(1, cos));
    scored.push({ b, score });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => a.score - b.score);
  const pool = scored.slice(0, Math.min(cfg.candidatePool, scored.length));
  const maxScore = pool[pool.length - 1].score;
  const weights = pool.map((s) => Math.exp((maxScore - s.score) * 1.6));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i].b;
  }
  return pool[0].b;
}

// ===== Event constructors =================================================

function makeJump({ from, to, kind, mood, rng, cfg }) {
  const dist = distance(from, to);
  let dur;
  if (kind === "regional") {
    dur = cfg.regionalLeapSec;
  } else {
    const moodCfg = cfg.moods[mood];
    const [lo, hi] = moodCfg.hopRange;
    dur = clamp(lo + dist / 320, lo, hi);
  }
  // Apply the global slowdown.
  dur *= SPEED_MULTIPLIER;

  // Arc height blends a base, the average roof height (so jumps between
  // tall buildings arc taller), and a small jitter.
  const hAvg = ((from.h ?? 0) + (to.h ?? 0)) * 0.5;
  let arcHeight;
  if (kind === "regional") {
    const [lo, hi] = cfg.regionalArcPx;
    arcHeight = lo + rng() * (hi - lo) + 0.3 * hAvg;
  } else {
    arcHeight =
      cfg.arcBasePx +
      cfg.arcHeightCoeff * hAvg +
      (rng() - 0.5) * 2 * cfg.arcJitterPx;
  }
  arcHeight = clamp(arcHeight, cfg.arcMinPx, cfg.arcMaxPx + 6);

  const facing = to.roof.x >= from.roof.x ? "right" : "left";
  return {
    type: "jump",
    from, to,
    dur, arcHeight, facing, dist,
    isBridge: kind === "regional",
    mood,
  };
}

function makeIdle({ at, rng, cfg, mood }) {
  return {
    type: "idle",
    at,
    dur: sampleIdle(rng, cfg) * SPEED_MULTIPLIER,
    mood,
  };
}

// ===== Sector visit =======================================================

function visitSector({ sector, sectorBox, baseUnit, cur, budgetSec, mood, rng, cfg }) {
  const events = [];
  const moodCfg = cfg.moods[mood];
  let elapsed = 0;
  while (elapsed < budgetSec && events.length < 80) {
    const phrase = pickFrom(rng, cfg.phrases);
    for (const label of phrase) {
      if (elapsed >= budgetSec) break;
      const desired = sampleStep(rng, label, baseUnit, moodCfg.alpha, cfg);
      const { dx, dy } = sampleDirection(cur, sectorBox, rng, desired);
      const next = pickNextInSector(sector, cur, desired, dx, dy, rng, cfg);
      if (!next) break;
      const jump = makeJump({ from: cur, to: next, kind: "intra", mood, rng, cfg });
      events.push(jump);
      elapsed += jump.dur;
      cur = next;
      // Per-step micro-pause: fires after every jump at the per-mood
      // idleProb. With prowl=0.44 this means ~2 idles per 5-jump phrase —
      // the chibi visibly settles on roofs instead of bouncing through
      // the whole phrase robotically. Hunt/dash moods naturally pause less.
      if (elapsed < budgetSec && rng() < moodCfg.idleProb) {
        const idle = makeIdle({ at: cur, rng, cfg, mood });
        events.push(idle);
        elapsed += idle.dur;
      }
    }
    // End-of-phrase pause — guaranteed-ish breath before picking a new
    // phrase. Probability is unbiased now (we removed the +0.2 fudge)
    // because the per-step check above already catches the "needs to
    // catch breath" case far more naturally.
    if (elapsed < budgetSec && rng() < moodCfg.idleProb) {
      const idle = makeIdle({ at: cur, rng, cfg, mood });
      events.push(idle);
      elapsed += idle.dur;
    }
  }
  return { events, exit: cur, elapsed };
}

function buildMoodSequence(sectorCount, rng) {
  const baseMoods = ["prowl", "hunt", "dash"];
  if (sectorCount === 1) return [pickFrom(rng, baseMoods)];
  if (sectorCount === 2) return shuffle(baseMoods, rng).slice(0, 2);
  const seq = shuffle(baseMoods, rng);
  for (let i = 3; i < sectorCount; i++) seq.push(pickFrom(rng, baseMoods));
  return seq;
}

// ===== Main planner =======================================================

/**
 * Plan a tour over an array of buildings.
 *
 * @param {Array<{gx:number, gy:number, level:number, h:number, roof:{x:number,y:number}}>} buildings
 * @param {{seed?:number, durationSec?:number}} opts
 * @returns {{events: any[], totalDuration: number, playlist: string[]}}
 */
export function planTour(buildings, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const rng = mulberry32(opts.seed ?? Math.floor(Math.random() * 1e9));

  if (!buildings || buildings.length === 0) {
    return { events: [], totalDuration: 0, playlist: [] };
  }
  if (buildings.length === 1) {
    const only = buildings[0];
    const dur = Math.min(cfg.durationSec, 4 * SPEED_MULTIPLIER);
    return {
      events: [
        { type: "start", at: only },
        { type: "idle", at: only, dur, mood: "prowl" },
      ],
      totalDuration: dur,
      playlist: ["prowl"],
    };
  }

  // Sectorize.
  const desiredK = Math.min(cfg.sectorTargetCount, Math.floor(buildings.length / 2));
  const k = Math.max(1, desiredK);
  const sectors = kmeans1D(buildings, k, rng);
  const sectorBoxes = sectors.map((s) => bbox(s));
  const moodSequence = buildMoodSequence(sectors.length, rng);

  // Time budget per sector.
  const reserveSec = cfg.durationSec * 0.15;
  const sectorBudget = (cfg.durationSec - reserveSec) / sectors.length;

  const events = [];

  // Start: tallest building in the FIRST (left-most) sector.
  const start = sectors[0]
    .slice()
    .sort((a, b) => (b.level || 0) - (a.level || 0))[0];
  events.push({ type: "start", at: start });

  let cur = start;
  let totalElapsed = 0;

  for (let i = 0; i < sectors.length; i++) {
    const sector = sectors[i];
    const sectorBox = sectorBoxes[i];
    const mood = moodSequence[i];

    if (i > 0) {
      const entry = sector
        .slice()
        .sort((a, b) => distance(cur, a) - distance(cur, b))[0];
      if (entry !== cur) {
        const leap = makeJump({ from: cur, to: entry, kind: "regional", mood, rng, cfg });
        events.push(leap);
        totalElapsed += leap.dur;
        cur = entry;
      }
    }

    const baseUnit = medianNearest(sector);
    const { events: sectorEvents, exit, elapsed } = visitSector({
      sector, sectorBox, baseUnit, cur, budgetSec: sectorBudget, mood, rng, cfg,
    });
    events.push(...sectorEvents);
    totalElapsed += elapsed;
    cur = exit;
  }

  // Loop closure: return to start so SMIL repeats seamlessly.
  if (cur !== start) {
    const close = makeJump({
      from: cur, to: start, kind: "regional",
      mood: moodSequence[moodSequence.length - 1], rng, cfg,
    });
    close.isClose = true;
    events.push(close);
    totalElapsed += close.dur;
  }

  // Compress only if natural total exceeds target.
  if (totalElapsed > cfg.durationSec) {
    const scale = cfg.durationSec / totalElapsed;
    for (const e of events) {
      if (e.type === "jump" || e.type === "idle") e.dur *= scale;
    }
  }

  const totalDuration = events.reduce(
    (acc, e) => acc + (e.type === "jump" || e.type === "idle" ? e.dur : 0),
    0
  );
  return { events, totalDuration, playlist: moodSequence };
}

// Backwards-compat alias.
export const planLevyTour = planTour;
