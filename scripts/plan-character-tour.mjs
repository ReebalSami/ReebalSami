/**
 * plan-character-tour.mjs
 *
 * Builds a "tour" of building hops for the parkour character. Each daily
 * seed picks a randomized PLAYLIST of 2–3 "moves" from a pool of five —
 * sweep, hop, patrol, spiral, zigzag — chains them with brief phase-change
 * idles, and closes the loop. The chibi never freezes for long, and the
 * pattern automatically varies day-to-day regardless of building count.
 *
 * Pipeline:
 *   1. prepareCity(buildings, rng, cfg) — filters, sectorizes, subsamples.
 *   2. Pick a playlist of 2–3 distinct moves (seed-driven shuffle).
 *   3. Run each move from the previous exit; brief idle between moves.
 *   4. Close: jump back to the very first start so SMIL repeats seamlessly.
 *   5. If natural total > target, compress proportionally. Never pad up.
 *
 * Each move returns { events, exit }; the composer threads them.
 *
 * Output:
 *   {
 *     events: [
 *       { type: 'start', at: building },
 *       { type: 'jump',  from, to, dur, arcHeight, facing, dist, isBridge? },
 *       { type: 'idle',  at, dur },
 *       …
 *     ],
 *     totalDuration: number,        // natural; the inject layer uses this
 *                                   // as the SMIL `dur` so no padding/freeze
 *     playlist: string[],           // for debugging/logging
 *   }
 */

import { mulberry32 } from "./lib/rng.mjs";

const DEFAULTS = {
  durationSec: 20,
  sectorCols: 4,
  sectorRows: 2,
  // Cap intra-sector building visits so dense sectors don't blow the budget.
  maxBuildingsPerSector: 4,
  // Hop timing (seconds) — short for intra-sector, longer for bridges.
  minHopSec: 0.32,
  maxHopSec: 0.55,
  bridgeHopSec: 0.65,
  // Arc heights (px in outer SVG coords).
  intraArc: [12, 22],
  bridgeArc: [22, 34],
  // Idle behaviour.
  bridgeIdleProb: 0.55,
  intraIdleProb: 0.06,
  minIdleSec: 0.7,
  maxIdleSec: 1.4,
  // Playlist composition.
  movePool: ["sweep", "hop", "patrol", "spiral", "zigzag"],
  // Brief idle inserted between consecutive moves so the eye registers
  // the phase change ("the chibi looks like it's deciding what to do next").
  phaseIdleSec: [0.6, 1.0],
};

// ===== Helpers ============================================================

function makeJump(from, to, rng, cfg, kind = "intra") {
  const dist = Math.hypot(to.px - from.px, to.py - from.py);
  const dur =
    kind === "bridge"
      ? cfg.bridgeHopSec
      : Math.min(
          cfg.maxHopSec,
          Math.max(cfg.minHopSec, cfg.minHopSec + dist / 280)
        );
  const arcRange = kind === "bridge" ? cfg.bridgeArc : cfg.intraArc;
  const arcHeight = arcRange[0] + rng() * (arcRange[1] - arcRange[0]);
  const facing = to.px >= from.px ? "right" : "left";
  return {
    type: "jump",
    from,
    to,
    dur,
    arcHeight,
    facing,
    dist,
    isBridge: kind === "bridge",
  };
}

function makeIdle(at, rng, cfg) {
  const dur = cfg.minIdleSec + rng() * (cfg.maxIdleSec - cfg.minIdleSec);
  return { type: "idle", at, dur };
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function centroidOf(buildings) {
  let sx = 0, sy = 0;
  for (const b of buildings) {
    sx += b.px;
    sy += b.py;
  }
  return { px: sx / buildings.length, py: sy / buildings.length };
}

function nearestIdx(target, list) {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < list.length; i++) {
    const d = Math.hypot(list[i].px - target.px, list[i].py - target.py);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function jumpKind(from, to) {
  return from._sectorIdx !== to._sectorIdx ? "bridge" : "intra";
}

// ===== City preparation ===================================================
//
// Returns:
//   { buildings, sectors, sectorPath (snake order), bbox, centroid }
// All buildings get a `_sectorIdx` field for fast bridge detection.

function prepareCity(buildings, rng, cfg) {
  const filled = buildings.filter((b) => b.level >= 1);
  if (filled.length === 0) return null;

  // Bounding box.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const b of filled) {
    if (b.px < minX) minX = b.px;
    if (b.px > maxX) maxX = b.px;
    if (b.py < minY) minY = b.py;
    if (b.py > maxY) maxY = b.py;
  }
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const colW = w / cfg.sectorCols;
  const rowH = h / cfg.sectorRows;

  // Sector grid.
  const sectors = Array.from({ length: cfg.sectorRows }, () =>
    Array.from({ length: cfg.sectorCols }, () => [])
  );
  for (const b of filled) {
    const c = Math.min(cfg.sectorCols - 1, Math.floor((b.px - minX) / colW));
    const r = Math.min(cfg.sectorRows - 1, Math.floor((b.py - minY) / rowH));
    b._sectorIdx = r * cfg.sectorCols + c;
    sectors[r][c].push(b);
  }

  // Subsample dense sectors: tallest first + a couple of shuffled randoms,
  // so daily seeds still produce visible variety. Cap = maxBuildingsPerSector.
  for (let r = 0; r < cfg.sectorRows; r++) {
    for (let c = 0; c < cfg.sectorCols; c++) {
      const cell = sectors[r][c];
      if (cell.length <= cfg.maxBuildingsPerSector) continue;
      cell.sort((a, b) => b.level - a.level || rng() - 0.5);
      const topHalf = Math.ceil(cfg.maxBuildingsPerSector / 2);
      const top = cell.slice(0, topHalf);
      const rest = shuffle(cell.slice(topHalf), rng);
      sectors[r][c] = top.concat(
        rest.slice(0, cfg.maxBuildingsPerSector - topHalf)
      );
    }
  }

  // Flat (subsampled) building list.
  const flat = [];
  for (const row of sectors) for (const cell of row) for (const b of cell) flat.push(b);

  return {
    buildings: flat,
    sectors,
    bbox: { minX, maxX, minY, maxY, w, h },
    centroid: centroidOf(flat),
  };
}

// ===== Moves ==============================================================
//
// Each move signature:
//   moveX(city, current, rng, cfg) -> { events, exit }
// where:
//   - `city` is the prepared city
//   - `current` is the building the chibi is on when the move begins
//   - returned `events` are jumps/idles starting FROM `current`
//   - returned `exit` is the building the chibi sits on after the move

/**
 * sweep — sector-snake + nearest-neighbour walk. Full city coverage.
 * This is the original (and only) tour algorithm; preserved verbatim.
 */
function moveSweep(city, current, rng, cfg) {
  const startTopRow = rng() < 0.5;
  const rowOrder = startTopRow
    ? [...Array(cfg.sectorRows).keys()]
    : [...Array(cfg.sectorRows).keys()].reverse();
  const startLTR = rng() < 0.5;

  const sectorPath = [];
  rowOrder.forEach((r, idx) => {
    const colsThisRow = [...Array(cfg.sectorCols).keys()];
    const goLTR = startLTR ? idx % 2 === 0 : idx % 2 === 1;
    if (!goLTR) colsThisRow.reverse();
    for (const c of colsThisRow) {
      const cell = city.sectors[r][c];
      if (cell.length > 0) sectorPath.push(cell);
    }
  });

  const events = [];
  let cur = current;

  for (let s = 0; s < sectorPath.length; s++) {
    const sectorBuildings = sectorPath[s];
    const nextSector = s + 1 < sectorPath.length ? sectorPath[s + 1] : null;
    const nextCentroid = nextSector ? centroidOf(nextSector) : null;
    let remaining = sectorBuildings.filter((b) => b !== cur);

    while (remaining.length > 0) {
      let bestIdx = 0;
      let bestScore = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const b = remaining[i];
        const dCur = Math.hypot(b.px - cur.px, b.py - cur.py);
        let score;
        if (remaining.length === 1) {
          score = 0;
        } else if (nextCentroid && remaining.length <= 2) {
          const dNxt = Math.hypot(
            b.px - nextCentroid.px,
            b.py - nextCentroid.py
          );
          score = dCur + 0.4 * dNxt;
        } else {
          score = dCur;
        }
        if (score < bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }
      const next = remaining.splice(bestIdx, 1)[0];
      const kind = jumpKind(cur, next);
      events.push(makeJump(cur, next, rng, cfg, kind));
      cur = next;
      // Idle after bridge jumps mostly, occasionally after intra hops.
      const wantIdle =
        rng() < (kind === "bridge" ? cfg.bridgeIdleProb : cfg.intraIdleProb);
      if (wantIdle) events.push(makeIdle(cur, rng, cfg));
    }
  }

  return { events, exit: cur };
}

/**
 * patrol — visit only the tallest buildings (level ≥ 3). Big arcs, slower
 * hops, occasional pauses. Feels like a guard tour over the skyline.
 * Falls back to top ~33% by level when fewer than 3 level-3+ buildings exist.
 */
function movePatrol(city, current, rng, cfg) {
  let targets = city.buildings.filter((b) => b.level >= 3);
  if (targets.length < 3) {
    const sorted = city.buildings.slice().sort((a, b) => b.level - a.level);
    targets = sorted.slice(0, Math.max(3, Math.ceil(sorted.length * 0.33)));
  }
  // NN walk through tall buildings, but always with bridge-style arcs.
  const events = [];
  let cur = current;
  let remaining = targets.filter((b) => b !== cur);
  while (remaining.length > 0) {
    const idx = nearestIdx(cur, remaining);
    const next = remaining.splice(idx, 1)[0];
    events.push(makeJump(cur, next, rng, cfg, "bridge"));
    cur = next;
    if (rng() < 0.35) events.push(makeIdle(cur, rng, cfg));
  }
  return { events, exit: cur };
}

/**
 * hop — pick min(7, all) random buildings, NN walk between them with
 * snappy intra hops. NO idles — pure restless motion burst.
 */
function moveHop(city, current, rng, cfg) {
  const pool = shuffle(
    city.buildings.filter((b) => b !== current),
    rng
  );
  const targets = pool.slice(0, Math.min(7, pool.length));
  // NN order through the random pick so jumps feel coherent, not chaotic.
  const events = [];
  let cur = current;
  let remaining = targets.slice();
  while (remaining.length > 0) {
    const idx = nearestIdx(cur, remaining);
    const next = remaining.splice(idx, 1)[0];
    events.push(makeJump(cur, next, rng, cfg, jumpKind(cur, next)));
    cur = next;
  }
  return { events, exit: cur };
}

/**
 * spiral — sort all buildings by distance from city centroid, walk
 * outward-to-inward (or inward-to-outward, 50/50). Looks like winding
 * one's way home through the calendar.
 */
function moveSpiral(city, current, rng, cfg) {
  const outwardFirst = rng() < 0.5;
  const order = city.buildings
    .slice()
    .sort((a, b) => {
      const da = Math.hypot(a.px - city.centroid.px, a.py - city.centroid.py);
      const db = Math.hypot(b.px - city.centroid.px, b.py - city.centroid.py);
      return outwardFirst ? db - da : da - db;
    })
    .filter((b) => b !== current);

  const events = [];
  let cur = current;
  for (const next of order) {
    events.push(makeJump(cur, next, rng, cfg, jumpKind(cur, next)));
    cur = next;
    if (rng() < 0.10) events.push(makeIdle(cur, rng, cfg));
  }
  return { events, exit: cur };
}

/**
 * zigzag — split buildings by median py, then alternate strictly between
 * top-half and bottom-half buildings (nearest available in each side).
 * Produces aggressive vertical motion across the iso-strip.
 */
function moveZigzag(city, current, rng, cfg) {
  const sorted = city.buildings.slice().sort((a, b) => a.py - b.py);
  const mid = Math.floor(sorted.length / 2);
  const top = sorted.slice(0, mid);
  const bot = sorted.slice(mid);
  // If one side is empty (only 1 building), bail out as a hop variant.
  if (top.length === 0 || bot.length === 0) {
    return moveHop(city, current, rng, cfg);
  }
  const events = [];
  let cur = current;
  let preferTop = current.py >= city.centroid.py; // start by jumping to the OPPOSITE side
  let topRem = top.filter((b) => b !== cur);
  let botRem = bot.filter((b) => b !== cur);
  while (topRem.length + botRem.length > 0) {
    const side = preferTop && topRem.length > 0 ? topRem : botRem.length > 0 ? botRem : topRem;
    if (side.length === 0) break;
    const idx = nearestIdx(cur, side);
    const next = side.splice(idx, 1)[0];
    events.push(makeJump(cur, next, rng, cfg, jumpKind(cur, next)));
    cur = next;
    preferTop = !preferTop;
    if (rng() < 0.08) events.push(makeIdle(cur, rng, cfg));
  }
  return { events, exit: cur };
}

const MOVES = {
  sweep: moveSweep,
  patrol: movePatrol,
  hop: moveHop,
  spiral: moveSpiral,
  zigzag: moveZigzag,
};

// ===== Composition (planTour) =============================================

/**
 * Plan a tour given an array of buildings (output of parseBuildings()).
 *
 * @param {Array<{px,py,level,height}>} buildings
 * @param {{ seed?: number, durationSec?: number, sectorCols?: number, sectorRows?: number }} opts
 */
export function planTour(buildings, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const rng = mulberry32(opts.seed ?? Math.floor(Math.random() * 1e9));

  const city = prepareCity(buildings, rng, cfg);

  // Edge cases.
  if (!city || city.buildings.length === 0) {
    return { events: [], totalDuration: 0, playlist: [] };
  }
  if (city.buildings.length === 1) {
    const only = city.buildings[0];
    return {
      events: [
        { type: "start", at: only },
        { type: "idle", at: only, dur: Math.min(cfg.durationSec, 4) },
      ],
      totalDuration: Math.min(cfg.durationSec, 4),
      playlist: ["idle"],
    };
  }

  // Pick playlist: 2 or 3 distinct moves, randomized per seed.
  const N = rng() < 0.5 ? 2 : 3;
  const playlist = shuffle(cfg.movePool, rng).slice(0, Math.min(N, cfg.movePool.length));

  // Pick starting building: prefer the highest-level building in a corner
  // sector so the very first move has somewhere to go. Mirrors original logic.
  const startCandidates = city.buildings
    .slice()
    .sort((a, b) => b.level - a.level || rng() - 0.5);
  const start = startCandidates[0];

  const events = [{ type: "start", at: start }];
  let cur = start;

  for (let i = 0; i < playlist.length; i++) {
    const moveName = playlist[i];
    const moveFn = MOVES[moveName];
    const result = moveFn(city, cur, rng, cfg);
    events.push(...result.events);
    cur = result.exit;
    // Phase-change idle between consecutive moves.
    if (i < playlist.length - 1) {
      const dur =
        cfg.phaseIdleSec[0] +
        rng() * (cfg.phaseIdleSec[1] - cfg.phaseIdleSec[0]);
      events.push({ type: "idle", at: cur, dur });
    }
  }

  // Close the loop: jump back to start so SMIL repeats seamlessly.
  if (cur !== start) {
    const dist = Math.hypot(start.px - cur.px, start.py - cur.py);
    const dur = cfg.bridgeHopSec * 1.2;
    const arcHeight = cfg.bridgeArc[1] + 6;
    const facing = start.px >= cur.px ? "right" : "left";
    events.push({
      type: "jump",
      from: cur,
      to: start,
      dur,
      arcHeight,
      facing,
      dist,
      isClose: true,
      isBridge: true,
    });
  }

  // Compress (only) if the natural total exceeds the target. Never pad up:
  // a sparse calendar should produce a shorter loop, not a freezing one.
  const totalRaw = events.reduce(
    (acc, e) => acc + (e.type === "jump" || e.type === "idle" ? e.dur : 0),
    0
  );
  if (totalRaw > cfg.durationSec) {
    const scale = cfg.durationSec / totalRaw;
    for (const e of events) {
      if (e.type === "jump" || e.type === "idle") e.dur *= scale;
    }
  }

  const totalDuration = events.reduce(
    (acc, e) => acc + (e.type === "jump" || e.type === "idle" ? e.dur : 0),
    0
  );

  return { events, totalDuration, playlist };
}
