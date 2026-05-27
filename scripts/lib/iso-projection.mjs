/**
 * iso-projection.mjs
 *
 * THE single source of truth for isometric geometry. Both the city
 * renderer (`svg-render.mjs`) and the Spider-Man walker (`walker.mjs`)
 * import from this file and only this file. By construction, the agent's
 * landing point on a roof is the same pixel that the renderer used to draw
 * that roof's center — so off-by-X bugs become impossible.
 *
 * Coordinate systems
 * ------------------
 *   GRID (world):  (gx, gy, gz)
 *     gx = week index   (0 = oldest week, totalWeeks-1 = newest)
 *     gy = day index    (0 = Sun, 6 = Sat)  — caller's choice; we don't care
 *     gz = height in WORLD UNITS (not pixels)  — 0 means flat on the ground
 *
 *   SCREEN (svg user-space):  (x, y)
 *     +x = right
 *     +y = down  (SVG convention)
 *
 * Projection (standard 2:1 isometric, viewer from south-southeast)
 * ----------------------------------------------------------------
 *   x = (gx - gy) * CELL_HW
 *   y = (gx + gy) * CELL_HH - gz * UNIT_PX
 *
 * With CELL_HW = 2 * CELL_HH (the 2:1 rhombus aspect), increasing gx moves
 * the cell DOWN-RIGHT in screen, and increasing gy moves it DOWN-LEFT.
 *
 *   gx=0, gy=0  → top corner of the calendar grid (back-left in iso)
 *   gx=N, gy=0  → right corner       (back-right)
 *   gx=0, gy=M  → left corner        (front-left)
 *   gx=N, gy=M  → bottom corner      (front-right)  ← closest to viewer
 *
 * For the contribution calendar we use:
 *   gx = weekIdx   (0 = 26 weeks ago,  25 = this week)
 *   gy = dayIdx    (0 = Sunday,        6 = Saturday)
 *
 * So the OLDEST contributions are in the back of the city and the NEWEST
 * are in the front-right — recent activity is the most prominent skyline.
 *
 * Cube anatomy
 * ------------
 * A unit cube at grid (gx, gy) with world height h has 8 corners, named
 * by which base corner they project from + base/top:
 *
 *   B0 = (gx,   gy,   0)   "back"
 *   B1 = (gx+1, gy,   0)   "right"     ← screen-right of the rhombus
 *   B2 = (gx+1, gy+1, 0)   "front"     ← screen-bottom (closest to viewer)
 *   B3 = (gx,   gy+1, 0)   "left"      ← screen-left of the rhombus
 *   T0..T3 are B0..B3 with gz = h (lifted up).
 *
 * The 3 visible faces (from front-down-right viewpoint) are:
 *   topFace:  T0 → T1 → T2 → T3       (rhombus on top of the extrusion)
 *   sideR:    B1 → B2 → T2 → T1       (the "right" face, gx = const = gx+1)
 *   sideL:    B3 → B2 → T2 → T3       (the "left"  face, gy = const = gy+1)
 *
 * For an EMPTY cell (h = 0) only the base rhombus matters:
 *   tilePath = B0 → B1 → B2 → B3
 *
 * Spider-Man landing point
 * ------------------------
 *   roofCenter(gx, gy, h) = project(gx + 0.5, gy + 0.5, h)
 *
 * This is the geometric center of the top face's rhombus. The chibi's
 * sprite origin (between feet) is positioned at this point — feet plant
 * right at the roof center, no front-anchor offset, no nesting tricks.
 */

import { mulberry32 } from "./rng.mjs";

// ===== Tunable constants (the only numbers in iso-space) =================
//
// All other modules import these instead of redefining them. Change here,
// the whole calendar resizes consistently.

/** Half-width of a unit cell's top rhombus (px). */
export const CELL_HW = 7;

/** Half-height of a unit cell's top rhombus (px). 2:1 aspect → CELL_HW = 2 × CELL_HH. */
export const CELL_HH = 3.5;

/** Pixels of screen Y subtracted per 1 unit of world Z (cube extrusion). */
export const UNIT_PX = 3.5;

/**
 * Map a contribution level (0-4) to a world-unit cube height. Level 0 is a
 * floor tile (height 0). Levels 1-4 produce visibly distinct skyscrapers
 * that preserve the L1 < L2 < L3 < L4 hierarchy. Tweak here, both the
 * renderer and the walker stay aligned.
 */
export const LEVEL_HEIGHT_UNITS = [0, 2.0, 3.4, 5.0, 7.0];

/**
 * Convert a level index (0..4) to its cube extrusion in PIXELS. This is
 * the function the walker uses when deciding how high to arc a jump and
 * the renderer uses when drawing the side faces.
 */
export function levelHeightPx(level) {
  const units = LEVEL_HEIGHT_UNITS[level] ?? 0;
  return units * UNIT_PX;
}

// ===== Core projection ===================================================

/**
 * Project a grid coordinate to screen.
 *
 * @param {number} gx grid x (week)
 * @param {number} gy grid y (day)
 * @param {number} [gz=0] world height in UNITS (not pixels)
 * @returns {{x:number, y:number}}
 */
export function project(gx, gy, gz = 0) {
  return {
    x: (gx - gy) * CELL_HW,
    y: (gx + gy) * CELL_HH - gz * UNIT_PX,
  };
}

// ===== Cell anchors ======================================================

/**
 * Pixel position of a cell's roof center for a given level. This is where
 * the Spider-Man chibi plants its feet. For empty cells (level 0) this is
 * the center of the floor tile.
 */
export function roofCenter(gx, gy, level) {
  const h = LEVEL_HEIGHT_UNITS[level] ?? 0;
  return project(gx + 0.5, gy + 0.5, h);
}

/**
 * Pixel position of a cell's base center (no extrusion). Used for the
 * cube's animation anchor (it scales Y around its own base).
 */
export function baseCenter(gx, gy) {
  return project(gx + 0.5, gy + 0.5, 0);
}

// ===== Cube face paths ===================================================
//
// Each function returns an SVG path `d` string for ONE face of the cube,
// in absolute pixel coordinates. For animated cubes we want the paths to
// be RELATIVE to the cube's base-center anchor — so we expose both:
//
//   {face}Path(gx, gy, h)         → absolute pixels (e.g. for ground tiles)
//   {face}PathRelative(gx, gy, h) → pixels relative to baseCenter(gx, gy)
//                                   (so the cube group can scale around it)

function fmt(p) { return `${p.x.toFixed(2)},${p.y.toFixed(2)}`; }

function rel(p, anchor) { return { x: p.x - anchor.x, y: p.y - anchor.y }; }

/** Top-face rhombus path. h is in world UNITS. */
export function topPath(gx, gy, h) {
  const T0 = project(gx,     gy,     h);
  const T1 = project(gx + 1, gy,     h);
  const T2 = project(gx + 1, gy + 1, h);
  const T3 = project(gx,     gy + 1, h);
  return `M${fmt(T0)} L${fmt(T1)} L${fmt(T2)} L${fmt(T3)} Z`;
}

export function topPathRelative(gx, gy, h) {
  const a = baseCenter(gx, gy);
  const T0 = rel(project(gx,     gy,     h), a);
  const T1 = rel(project(gx + 1, gy,     h), a);
  const T2 = rel(project(gx + 1, gy + 1, h), a);
  const T3 = rel(project(gx,     gy + 1, h), a);
  return `M${fmt(T0)} L${fmt(T1)} L${fmt(T2)} L${fmt(T3)} Z`;
}

/** Right-side parallelogram: B1 → B2 → T2 → T1. */
export function sideRPath(gx, gy, h) {
  const B1 = project(gx + 1, gy,     0);
  const B2 = project(gx + 1, gy + 1, 0);
  const T2 = project(gx + 1, gy + 1, h);
  const T1 = project(gx + 1, gy,     h);
  return `M${fmt(B1)} L${fmt(B2)} L${fmt(T2)} L${fmt(T1)} Z`;
}

export function sideRPathRelative(gx, gy, h) {
  const a = baseCenter(gx, gy);
  const B1 = rel(project(gx + 1, gy,     0), a);
  const B2 = rel(project(gx + 1, gy + 1, 0), a);
  const T2 = rel(project(gx + 1, gy + 1, h), a);
  const T1 = rel(project(gx + 1, gy,     h), a);
  return `M${fmt(B1)} L${fmt(B2)} L${fmt(T2)} L${fmt(T1)} Z`;
}

/** Left-side parallelogram: B3 → B2 → T2 → T3. */
export function sideLPath(gx, gy, h) {
  const B3 = project(gx,     gy + 1, 0);
  const B2 = project(gx + 1, gy + 1, 0);
  const T2 = project(gx + 1, gy + 1, h);
  const T3 = project(gx,     gy + 1, h);
  return `M${fmt(B3)} L${fmt(B2)} L${fmt(T2)} L${fmt(T3)} Z`;
}

export function sideLPathRelative(gx, gy, h) {
  const a = baseCenter(gx, gy);
  const B3 = rel(project(gx,     gy + 1, 0), a);
  const B2 = rel(project(gx + 1, gy + 1, 0), a);
  const T2 = rel(project(gx + 1, gy + 1, h), a);
  const T3 = rel(project(gx,     gy + 1, h), a);
  return `M${fmt(B3)} L${fmt(B2)} L${fmt(T2)} L${fmt(T3)} Z`;
}

/** Floor tile (flat rhombus) at grid (gx, gy). Top face at h=0. */
export function tilePath(gx, gy) {
  return topPath(gx, gy, 0);
}

// ===== Window grid (for L3/L4 cubes in dark theme) =======================
//
// Generates a deterministic mosaic of lit/unlit windows on one side face
// of a cube. Each window is a small parallelogram sharing the parent
// face's iso skew — vertical edges stay vertical, top/bottom edges slope
// with the face. Same affine system as the cube, so windows rise with the
// cube on load (no separate animation needed).
//
// Face-local coordinates (u, v):
//   u ∈ [0, 1] along the base edge (back → front of the face)
//   v ∈ [0, 1] along the vertical edge (street → roof)
//
// Mapping face-local (u, v) → world (gx_w, gy_w, gz_w):
//   face='R' (sideR, south-east face): gx_w = gx+1, gy_w = gy + u, gz_w = v*h
//   face='L' (sideL, south-west face): gx_w = gx + u, gy_w = gy+1, gz_w = v*h
//
// Window kinds are sampled per-window via a seeded RNG so the pattern is
// stable across rebuilds. Distinct seed per (gx, gy, level, face) means
// each face of each cube gets its own mosaic — no mirror symmetry.

/** Per-level window grid layout. Levels outside this table get no windows. */
const WINDOW_LAYOUT = {
  3: { floors: 3, cols: 2 }, // L3 cubes (h = 5.0 units, ~17.5 px tall)
  4: { floors: 4, cols: 2 }, // L4 cubes (h = 7.0 units, ~24.5 px tall)
};

/**
 * Cumulative probability thresholds for window kind sampling. Ordered:
 *   ~60% warm-on    — amber, the dominant NYC look
 *   ~ 8% warm-bright — punchier yellow accent
 *   ~10% cool-on    — rare cool-blue (fluorescent / monitor glow)
 *   ~22% off        — unlit pane, recessed dark
 * Sum = 1.00.
 */
const WINDOW_KIND_THRESHOLDS = [
  { kind: "warm-on", upTo: 0.60 },
  { kind: "warm-bright", upTo: 0.68 },
  { kind: "cool-on", upTo: 0.78 },
  { kind: "off", upTo: 1.00 },
];

function pickWindowKind(r) {
  for (const t of WINDOW_KIND_THRESHOLDS) {
    if (r < t.upTo) return t.kind;
  }
  return "off";
}

function windowSeedFor(gx, gy, level, face) {
  // Mix grid position, level, and face index into a single 32-bit seed.
  // Primes chosen to avoid simple collisions on a 26×7 grid.
  return (
    ((gx * 7919) ^ (gy * 524287) ^ (level * 6151) ^ (face === "L" ? 1 : 2)) >>> 0
  );
}

/**
 * Compute window parallelogram paths for one side face of a cube,
 * relative to that cube's baseCenter (so they live inside the cube's
 * inner animated <g> alongside the side faces).
 *
 * Returns an empty array for cubes whose level has no entry in
 * WINDOW_LAYOUT (currently anything below L3).
 *
 * @param {number} gx grid x
 * @param {number} gy grid y
 * @param {number} level contribution level (1..4)
 * @param {number} h cube height in WORLD UNITS (LEVEL_HEIGHT_UNITS[level])
 * @param {'L'|'R'} face which side face — 'L' = sideL (south-west), 'R' = sideR (south-east)
 * @returns {Array<{path:string, kind:'warm-on'|'warm-bright'|'cool-on'|'off'}>}
 */
export function windowPathsRelative(gx, gy, level, h, face) {
  const layout = WINDOW_LAYOUT[level];
  if (!layout) return [];
  const { floors, cols } = layout;

  // Face-local layout. Margins/gutters as fractions of the face dim.
  // V_BOT > V_TOP leaves a "ground-floor / storefront" strip at street
  // level, mirroring real NYC building stacking.
  const U_MARGIN = 0.18;
  const U_GUTTER = 0.18;
  const V_TOP = 0.10;
  const V_BOT = 0.18;
  const V_GUTTER = 0.10;

  const uWin = (1 - 2 * U_MARGIN - U_GUTTER * (cols - 1)) / cols;
  const vWin = (1 - V_TOP - V_BOT - V_GUTTER * (floors - 1)) / floors;

  const anchor = baseCenter(gx, gy);
  const rng = mulberry32(windowSeedFor(gx, gy, level, face));
  const out = [];

  for (let row = 0; row < floors; row++) {
    // row=0 is the top floor (closest to the roof);
    // row=floors-1 is the bottom floor (closest to street level).
    const vHi = 1 - V_TOP - row * (vWin + V_GUTTER);
    const vLo = vHi - vWin;

    for (let col = 0; col < cols; col++) {
      const uLo = U_MARGIN + col * (uWin + U_GUTTER);
      const uHi = uLo + uWin;

      // Four face-local corners → world coords → project → face-relative pixels.
      const corners = [
        [uLo, vLo],
        [uHi, vLo],
        [uHi, vHi],
        [uLo, vHi],
      ].map(([u, v]) => {
        const gz = v * h;
        const p =
          face === "R"
            ? project(gx + 1, gy + u, gz)
            : project(gx + u, gy + 1, gz);
        return { x: p.x - anchor.x, y: p.y - anchor.y };
      });

      const [c0, c1, c2, c3] = corners;
      const path = `M${fmt(c0)} L${fmt(c1)} L${fmt(c2)} L${fmt(c3)} Z`;
      const kind = pickWindowKind(rng());
      out.push({ path, kind });
    }
  }

  return out;
}

// ===== Calendar bounds ===================================================

/**
 * Compute the screen-space bounding box of a contribution grid of
 * `weeks` columns × `days` rows. Cubes can extend ABOVE the grid so we
 * factor in the tallest possible cube height too.
 *
 * @param {number} weeks  number of week columns (e.g. 26)
 * @param {number} days   number of day rows    (typically 7)
 * @returns {{minX, maxX, minY, maxY, width, height}}
 */
export function gridBounds(weeks, days) {
  // The 4 corners of the flat (h=0) calendar parallelogram.
  const corners = [
    project(0,     0,     0),
    project(weeks, 0,     0),
    project(weeks, days,  0),
    project(0,     days,  0),
  ];
  // The tallest possible cube extrusion sits ABOVE these corners.
  const maxH = LEVEL_HEIGHT_UNITS[LEVEL_HEIGHT_UNITS.length - 1];
  // Top corners (z = maxH) — only y matters since x is unchanged by gz.
  const topY = Math.min(...corners.map((c) => c.y - maxH * UNIT_PX));

  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = topY;
  const maxY = Math.max(...ys);
  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}
