/**
 * plan-character-tour.mjs
 *
 * Builds a "tour" of building hops for the parkour character. Uses a
 * sector-sweep + nearest-neighbour walk so the character visits EVERY
 * populated region of the calendar instead of clustering near its
 * starting building.
 *
 * Algorithm:
 *   1. Filter buildings to filled (level >= 1) only.
 *   2. Bucket them into a SECTOR_COLS x SECTOR_ROWS grid over the bounding box.
 *   3. Build a snake-order traversal of NON-EMPTY sectors.
 *   4. Within each sector: nearest-neighbour walk through its buildings,
 *      starting near the entry point (last building of previous sector or
 *      the configured start) and ending near the next sector's centroid.
 *   5. Insert idle pauses after bridge jumps between sectors.
 *   6. Time-budget: trim or pad to fit `durationSec`.
 *   7. Close the loop: final jump back to start so SMIL repeats seamlessly.
 *
 * Output is a sequence of EVENTS along a fixed total duration:
 *
 *   [
 *     { type: 'start', at: building },
 *     { type: 'jump',  from: A, to: B, dur, arcHeight, facing, dist, isBridge? },
 *     { type: 'idle',  at: A, dur },
 *     …
 *   ]
 */

import { mulberry32, pickRandom } from "./lib/rng.mjs";

const DEFAULTS = {
  durationSec: 20,
  sectorCols: 4,
  sectorRows: 2,
  // Cap intra-sector building visits so dense sectors don't blow the budget.
  // Picked to keep total jumps in the 20–35 range across typical calendars.
  maxBuildingsPerSector: 4,
  // Hop timing (seconds) — short for intra-sector, longer for bridges.
  minHopSec: 0.32,
  maxHopSec: 0.55,
  bridgeHopSec: 0.65,
  // Arc heights (px in outer SVG coords).
  intraArc: [12, 22],
  bridgeArc: [22, 34],
  // Idle behaviour.
  bridgeIdleProb: 0.65,
  intraIdleProb: 0.06,
  minIdleSec: 0.7,
  maxIdleSec: 1.4,
};

/**
 * Plan a tour given an array of buildings (output of parseBuildings()).
 * @param {Array<{px,py,level,height}>} buildings
 * @param {{ seed?: number, durationSec?: number, sectorCols?: number, sectorRows?: number }} opts
 */
export function planTour(buildings, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const rng = mulberry32(opts.seed ?? Math.floor(Math.random() * 1e9));

  const filled = buildings.filter((b) => b.level >= 1);
  if (filled.length < 2) {
    if (filled.length === 0) return { events: [], totalDuration: 0 };
    return {
      events: [
        { type: "start", at: filled[0] },
        { type: "idle", at: filled[0], dur: cfg.durationSec },
      ],
      totalDuration: cfg.durationSec,
    };
  }

  // ----- 1. Bounding box + sector grid ------------------------------------
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

  // sectors[r][c] = array of buildings
  const sectors = Array.from({ length: cfg.sectorRows }, () =>
    Array.from({ length: cfg.sectorCols }, () => [])
  );
  for (const b of filled) {
    const c = Math.min(cfg.sectorCols - 1, Math.floor((b.px - minX) / colW));
    const r = Math.min(cfg.sectorRows - 1, Math.floor((b.py - minY) / rowH));
    sectors[r][c].push(b);
  }

  // Subsample dense sectors: keep the tallest buildings + a couple of randoms
  // so daily seeds still produce visible variety. Cap = maxBuildingsPerSector.
  for (let r = 0; r < cfg.sectorRows; r++) {
    for (let c = 0; c < cfg.sectorCols; c++) {
      const cell = sectors[r][c];
      if (cell.length <= cfg.maxBuildingsPerSector) continue;
      // Sort by level desc, then by daily seed shuffle.
      cell.sort((a, b) => b.level - a.level || rng() - 0.5);
      // Keep the top half by level, the rest filled with random picks.
      const topHalf = Math.ceil(cfg.maxBuildingsPerSector / 2);
      const top = cell.slice(0, topHalf);
      const rest = cell.slice(topHalf);
      // Shuffle rest, take what we need.
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      const picked = top.concat(rest.slice(0, cfg.maxBuildingsPerSector - topHalf));
      sectors[r][c] = picked;
    }
  }

  // ----- 2. Snake-order traversal of non-empty sectors --------------------
  const startTopRow = rng() < 0.5; // randomize whether we start top or bottom
  const rowOrder = startTopRow
    ? [...Array(cfg.sectorRows).keys()]
    : [...Array(cfg.sectorRows).keys()].reverse();
  const startLTR = rng() < 0.5;

  const sectorPath = []; // list of buildings arrays in visit order
  rowOrder.forEach((r, idx) => {
    const colsThisRow = [...Array(cfg.sectorCols).keys()];
    // Snake direction alternates per row, with random initial direction.
    const goLTR = startLTR ? idx % 2 === 0 : idx % 2 === 1;
    if (!goLTR) colsThisRow.reverse();
    for (const c of colsThisRow) {
      const cell = sectors[r][c];
      if (cell.length > 0) sectorPath.push(cell);
    }
  });

  if (sectorPath.length === 0) {
    return { events: [], totalDuration: 0 };
  }

  // ----- 3. Pick starting building (highest-level building in first sector) -
  const firstSector = sectorPath[0];
  const startCandidates = firstSector
    .slice()
    .sort((a, b) => b.level - a.level || rng() - 0.5);
  const start = startCandidates[0];

  const events = [{ type: "start", at: start }];
  let current = start;

  // ----- 4. Walk each sector with nearest-neighbour, bridging between -----
  for (let s = 0; s < sectorPath.length; s++) {
    const sectorBuildings = sectorPath[s];
    const isFirstSector = s === 0;
    const nextSector = s + 1 < sectorPath.length ? sectorPath[s + 1] : null;
    const nextCentroid = nextSector ? centroidOf(nextSector) : null;

    // Order buildings within this sector: nearest-neighbour from `current`,
    // but bias the LAST pick toward the next sector's centroid so the bridge
    // jump is short.
    const remaining = isFirstSector
      ? sectorBuildings.filter((b) => b !== start)
      : sectorBuildings.slice();

    while (remaining.length > 0) {
      // If this is the last building in this sector AND there's a next sector,
      // pick the one closest to the next sector's centroid (better bridging).
      const isLastInSector = remaining.length === 1 && nextCentroid;

      let bestIdx = 0;
      let bestScore = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const b = remaining[i];
        let score;
        const dCur = Math.hypot(b.px - current.px, b.py - current.py);
        if (isLastInSector) {
          score = 0; // only one option
        } else if (nextCentroid && remaining.length <= 2) {
          // Bias the final intra-sector pick toward the next sector's centroid
          // so the bridge jump after this sector is short.
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

      // Determine if this is a "bridge" jump (sector → sector entry).
      const isBridge =
        !isFirstSector && remaining.length === sectorBuildings.length - 1;

      const dist = Math.hypot(next.px - current.px, next.py - current.py);
      const dur = isBridge
        ? cfg.bridgeHopSec
        : Math.min(
            cfg.maxHopSec,
            Math.max(cfg.minHopSec, cfg.minHopSec + dist / 280)
          );
      const arcRange = isBridge ? cfg.bridgeArc : cfg.intraArc;
      const arcHeight = arcRange[0] + rng() * (arcRange[1] - arcRange[0]);
      const facing = next.px >= current.px ? "right" : "left";

      events.push({
        type: "jump",
        from: current,
        to: next,
        dur,
        arcHeight,
        facing,
        dist,
        isBridge: !!isBridge,
      });

      current = next;

      // Idle insertion: after bridge jumps mostly, occasionally after intra.
      const wantIdle =
        rng() < (isBridge ? cfg.bridgeIdleProb : cfg.intraIdleProb);
      if (wantIdle) {
        const idleDur =
          cfg.minIdleSec + rng() * (cfg.maxIdleSec - cfg.minIdleSec);
        events.push({ type: "idle", at: current, dur: idleDur });
      }
    }
  }

  // ----- 5. Close the loop: jump back to start ----------------------------
  if (current !== start) {
    const dist = Math.hypot(start.px - current.px, start.py - current.py);
    const dur = cfg.bridgeHopSec * 1.2;
    const arcHeight = cfg.bridgeArc[1] + 6;
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
      isBridge: true,
    });
  }

  // ----- 6. Time budget: scale durations to fit cfg.durationSec -----------
  const totalRaw = events.reduce(
    (acc, e) => acc + (e.type === "jump" || e.type === "idle" ? e.dur : 0),
    0
  );
  if (totalRaw > 0) {
    // If the natural tour is too long, compress proportionally (keeps the
    // pacing relationships intact). If it's too short, stretch idles only
    // so jumps stay snappy.
    if (totalRaw > cfg.durationSec) {
      const scale = cfg.durationSec / totalRaw;
      for (const e of events) {
        if (e.type === "jump" || e.type === "idle") e.dur *= scale;
      }
    } else if (totalRaw < cfg.durationSec * 0.95) {
      const slack = cfg.durationSec - totalRaw;
      const idles = events.filter((e) => e.type === "idle");
      if (idles.length > 0) {
        const per = slack / idles.length;
        for (const e of idles) e.dur += per;
      } else {
        // No idles in tour — append a single closing idle at start position.
        events.push({ type: "idle", at: start, dur: slack });
      }
    }
  }

  const totalDuration = events.reduce(
    (acc, e) => acc + (e.type === "jump" || e.type === "idle" ? e.dur : 0),
    0
  );

  return { events, totalDuration };
}

function centroidOf(buildings) {
  let sx = 0, sy = 0;
  for (const b of buildings) {
    sx += b.px;
    sy += b.py;
  }
  return { px: sx / buildings.length, py: sy / buildings.length };
}
