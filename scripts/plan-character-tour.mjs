/**
 * plan-character-tour.mjs
 *
 * Builds a "tour" of building hops for the parkour character. Uses a
 * weighted random walker — not a full A* / TSP solver — because the goal
 * is character believability (varied, alive-feeling motion), not coverage.
 *
 * Output is a sequence of EVENTS along a fixed total duration:
 *
 *   [
 *     { type: 'start', at: building },                          // initial position
 *     { type: 'jump',  from: A, to: B, dur, arcHeight, facing },// arc hop
 *     { type: 'idle',  at: A, dur },                            // stand & look around
 *     …
 *   ]
 *
 * Behavior:
 *   - First event is always 'start' (places character on initial building)
 *   - Mix of 'jump' (~78%) and 'idle' (~22%)
 *   - Jumps prefer NEARBY buildings, penalize repeating last direction,
 *     avoid last 3 visited buildings (no tight loops)
 *   - 5% chance of LONG jump (allowed to exceed default range)
 *   - Never lands on empty cells (level === 0 are filtered out)
 *   - When boxed in (no candidates within range), falls back to a far
 *     building in the OPPOSITE direction (turn-around behavior)
 *   - Tour closes back to starting building so SMIL repeatCount loops cleanly
 */

import { mulberry32, weightedPick, pickRandom } from "./lib/rng.mjs";

const DEFAULTS = {
  durationSec: 20,
  maxJumpDistance: 70,    // px in outer SVG coords
  longJumpProb: 0.05,     // chance of allowing a long jump per choice
  idleProb: 0.22,         // chance of inserting an idle before next jump
  minIdleSec: 1.0,
  maxIdleSec: 2.0,
  minJumpSec: 0.35,
  maxJumpSec: 0.85,
  minArc: 14,
  maxArc: 26,
  recentMemory: 4,        // remember last N buildings to avoid revisits
  preferLevel: 2,         // bias toward landing on level >= this
};

/**
 * Plan a tour given an array of buildings (output of parseBuildings()).
 * @param {Array<{px,py,level,height}>} buildings
 * @param {{ seed?: number, durationSec?: number }} opts
 */
export function planTour(buildings, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const rng = mulberry32(opts.seed ?? Math.floor(Math.random() * 1e9));

  // Filter to only valid landing spots (level >= 1).
  const filled = buildings.filter((b) => b.level >= 1);
  if (filled.length < 2) {
    // Edge case: too few buildings — return a stationary "idle forever" tour.
    if (filled.length === 0) return { events: [], totalDuration: 0 };
    return {
      events: [
        { type: "start", at: filled[0] },
        { type: "idle", at: filled[0], dur: cfg.durationSec },
      ],
      totalDuration: cfg.durationSec,
    };
  }

  // Prefer starting on a TALL building (more dramatic).
  const tall = filled.filter((b) => b.level >= cfg.preferLevel);
  const start = tall.length > 0 ? pickRandom(rng, tall) : pickRandom(rng, filled);

  const events = [{ type: "start", at: start }];
  const recent = [start];

  let current = start;
  let lastDir = { x: 0, y: 0 };
  let timeUsed = 0;

  // Reserve a chunk of time at the END to close the loop back to start.
  const closeLoopReserve = 0.9; // seconds for the final hop home

  while (timeUsed < cfg.durationSec - closeLoopReserve) {
    // Decide: idle or jump?
    const lastEvt = events[events.length - 1];
    const wantIdle =
      rng() < cfg.idleProb &&
      lastEvt &&
      lastEvt.type !== "idle" &&
      // Allow idle only after at least one jump
      events.length >= 2;

    if (wantIdle) {
      const dur = cfg.minIdleSec + rng() * (cfg.maxIdleSec - cfg.minIdleSec);
      events.push({ type: "idle", at: current, dur });
      timeUsed += dur;
      continue;
    }

    // JUMP: build candidate list with scores
    const allowLongJump = rng() < cfg.longJumpProb;
    const range = allowLongJump ? cfg.maxJumpDistance * 2.5 : cfg.maxJumpDistance;

    const candidates = filled
      .filter((b) => b !== current && !recent.includes(b))
      .map((b) => {
        const dx = b.px - current.px;
        const dy = b.py - current.py;
        const dist = Math.hypot(dx, dy);
        if (dist > range) return null;

        const dir = dist > 0 ? { x: dx / dist, y: dy / dist } : { x: 0, y: 0 };
        // Direction similarity with last direction. +1 = same, -1 = opposite.
        const dirSim = dir.x * lastDir.x + dir.y * lastDir.y;

        // Score components:
        //   - distance: closer is preferred (1 at dist=0, 0 at dist=range)
        //   - height bonus: taller buildings more attractive
        //   - direction penalty: avoid going straight in same direction
        //     (subtle — we WANT some forward momentum but not perfect lines)
        const distScore = 1 - dist / range;
        const heightBonus = 0.08 * b.level;
        const dirPenalty = 0.18 * Math.max(0, dirSim);
        const score = distScore + heightBonus - dirPenalty + 0.05;

        return { b, score, dist, dir };
      })
      .filter(Boolean);

    let chosen;
    if (candidates.length === 0) {
      // Boxed in — pick the FARTHEST building in opposite direction
      // (turn-around behavior). Penalize same-direction.
      const farCandidates = filled
        .filter((b) => b !== current)
        .map((b) => {
          const dx = b.px - current.px;
          const dy = b.py - current.py;
          const dist = Math.hypot(dx, dy);
          const dir = dist > 0 ? { x: dx / dist, y: dy / dist } : { x: 0, y: 0 };
          const dirSim = dir.x * lastDir.x + dir.y * lastDir.y;
          // Prefer opposite direction + medium distance
          const score = (1 - dirSim) * 0.6 + Math.min(dist, 200) / 200 * 0.4;
          return { b, score, dist, dir };
        });
      chosen = weightedPick(rng, farCandidates);
    } else {
      chosen = weightedPick(rng, candidates);
    }

    const dist = chosen.dist;
    const dur = Math.min(
      cfg.maxJumpSec,
      Math.max(cfg.minJumpSec, cfg.minJumpSec + dist / 220)
    );
    const arcHeight = cfg.minArc + rng() * (cfg.maxArc - cfg.minArc);
    const facing = chosen.b.px >= current.px ? "right" : "left";

    events.push({
      type: "jump",
      from: current,
      to: chosen.b,
      dur,
      arcHeight,
      facing,
      dist,
    });
    timeUsed += dur;
    lastDir = chosen.dir;
    current = chosen.b;

    recent.push(current);
    if (recent.length > cfg.recentMemory) recent.shift();
  }

  // Close the loop: jump back to the start so the SMIL animation seams.
  if (current !== start) {
    const dx = start.px - current.px;
    const dy = start.py - current.py;
    const dist = Math.hypot(dx, dy);
    const dur = Math.max(cfg.minJumpSec, Math.min(cfg.maxJumpSec * 1.5, dist / 220));
    const arcHeight = cfg.maxArc + 8;
    const facing = start.px >= current.px ? "right" : "left";
    events.push({
      type: "jump",
      from: current,
      to: start,
      dur,
      arcHeight,
      facing,
      dist,
      isClose: true,
    });
    timeUsed += dur;
  }

  return { events, totalDuration: timeUsed };
}
