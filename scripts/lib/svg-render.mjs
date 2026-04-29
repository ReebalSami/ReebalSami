/**
 * svg-render.mjs
 *
 * Renders the iso-calendar city SVG from a list of contribution days.
 *
 *   renderCity({ days, weeks })
 *     → { svg, width, height, viewBox, buildings }
 *
 * Where `buildings` is the array of cubes (level ≥ 1) with their roof
 * centers in screen pixels — this is exactly what `walker.mjs` consumes
 * to plan the Spider-Man tour. By piping the SAME object through both
 * the renderer and the walker we guarantee the agent never lands off-roof.
 *
 * The output SVG is theme-agnostic: a single <style> sets light defaults
 * at :root and overrides them inside @media (prefers-color-scheme: dark).
 *
 * Animations:
 *   - Each cube emits a SMIL <animateTransform type="scale"> from
 *     "1 0" → "1 1" anchored at its base-center, staggered by
 *     0.04s × (gx + gy) so the rise sweeps NW→SE in ~1.5s.
 *   - Plays ONCE on load (begin="0s", fill="freeze", no repeatCount).
 */

import {
  CELL_HW,
  CELL_HH,
  UNIT_PX,
  LEVEL_HEIGHT_UNITS,
  project,
  baseCenter,
  roofCenter,
  topPath,
  topPathRelative,
  sideLPathRelative,
  sideRPathRelative,
  tilePath,
  gridBounds,
} from "./iso-projection.mjs";
import { LEVEL_COLOR, BRAND, CHARACTER_CSS_VARS, renderCssVars } from "./palette.mjs";

// Tunable: per-cell rise-stagger increment in seconds. Smaller = snappier
// front-to-back sweep. 0.04s × 32 (max gx+gy) ≈ 1.3s total wave.
const RISE_STAGGER_SEC = 0.04;
// Per-cube rise duration. Each individual cube takes this long to rise.
const RISE_DURATION_SEC = 0.55;

/**
 * Build the iso-city SVG.
 *
 * @param {{
 *   days: Array<{date:string, count:number, level:number, gx:number, gy:number}>,
 *   weeks: number,
 *   characterMarkup?: string,    // optional: pre-built chibi + animations
 * }} opts
 * @returns {{
 *   svg: string,
 *   viewBox: {x:number, y:number, w:number, h:number},
 *   width: number,
 *   height: number,
 *   buildings: Array<{gx:number, gy:number, level:number, h:number, roof:{x:number,y:number}}>,
 * }}
 */
export function renderCity({ days, weeks, characterMarkup = "" }) {
  if (!Array.isArray(days) || days.length === 0) {
    throw new Error("renderCity: days array is required and non-empty");
  }
  const DAYS_PER_WEEK = 7;
  const totalCells = weeks * DAYS_PER_WEEK;
  if (days.length !== totalCells) {
    throw new Error(
      `renderCity: expected ${totalCells} days, got ${days.length}`
    );
  }

  // ----- compute viewBox + padding ---------------------------------------
  const PAD_X = 14;
  const PAD_TOP = 18;
  const PAD_BOTTOM = 10;
  const bb = gridBounds(weeks, DAYS_PER_WEEK);
  const viewBox = {
    x: bb.minX - PAD_X,
    y: bb.minY - PAD_TOP,
    w: bb.width + 2 * PAD_X,
    h: bb.height + PAD_TOP + PAD_BOTTOM,
  };

  // Output pixel dimensions — render at a fixed scale so the README image
  // looks crisp. The SVG remains scalable; this is just the default.
  const PIXEL_SCALE = 5;
  const widthPx = Math.round(viewBox.w * PIXEL_SCALE);
  const heightPx = Math.round(viewBox.h * PIXEL_SCALE);

  // ----- buildings list (for the walker, returned to caller) -------------
  /** @type {Array<{gx,gy,level,h,roof}>} */
  const buildings = [];
  for (const d of days) {
    if (d.level >= 1) {
      buildings.push({
        gx: d.gx,
        gy: d.gy,
        level: d.level,
        h: LEVEL_HEIGHT_UNITS[d.level],
        roof: roofCenter(d.gx, d.gy, d.level),
      });
    }
  }

  // ----- floor tiles (every cell, including filled — they get covered) ---
  const tilePaths = days
    .map((d) => `<path d="${tilePath(d.gx, d.gy)}"/>`)
    .join("\n      ");

  // ----- cubes (level ≥ 1), painter-sorted back-to-front -----------------
  // Sort by (gx + gy) ascending so back cubes draw first; secondary sort
  // by gx ascending (stable across same-depth cells).
  const sortedBuildings = [...buildings].sort((a, b) => {
    const da = a.gx + a.gy;
    const db = b.gx + b.gy;
    return da - db || a.gx - b.gx;
  });

  const cubeMarkup = sortedBuildings
    .map((b) => buildCubeMarkup(b))
    .join("\n      ");

  // ----- title strip (top-left of svg) -----------------------------------
  // Tiny date-range caption — light grey, easy to ignore but informative.
  const firstDate = days[0].date;
  const lastDate = days[days.length - 1].date;
  const caption = `${formatDate(firstDate)} → ${formatDate(lastDate)}`;

  // ----- styles ----------------------------------------------------------
  const style = buildStyleBlock();

  // ----- assemble final svg ---------------------------------------------
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"
  viewBox="${fmt(viewBox.x)} ${fmt(viewBox.y)} ${fmt(viewBox.w)} ${fmt(viewBox.h)}"
  width="${widthPx}" height="${heightPx}"
  role="img"
  aria-label="Isometric calendar of GitHub contributions for the last ${weeks} weeks">
  <title>GitHub contributions, last ${weeks} weeks</title>
  ${style}
  <g class="caption">
    <text x="${fmt(viewBox.x + 2)}" y="${fmt(viewBox.y + 8)}">${caption}</text>
  </g>
  <g class="floor">
      ${tilePaths}
  </g>
  <g class="cubes">
      ${cubeMarkup}
  </g>
  ${characterMarkup}
</svg>`;

  return {
    svg,
    viewBox,
    width: widthPx,
    height: heightPx,
    buildings: sortedBuildings,
  };
}

// ===== Per-cube markup ===================================================

function buildCubeMarkup(b) {
  const anchor = baseCenter(b.gx, b.gy);
  const sideR = sideRPathRelative(b.gx, b.gy, b.h);
  const sideL = sideLPathRelative(b.gx, b.gy, b.h);
  const top = topPathRelative(b.gx, b.gy, b.h);
  const beginSec = (b.gx + b.gy) * RISE_STAGGER_SEC;

  // Wrap in two groups:
  //   outer: positions the cube at its base-center anchor
  //   inner: starts at scale(1, 0) and animates to scale(1, 1)
  //          → the cube extrudes upward from the floor
  // Animate the inner group from scale(1 0) → scale(1 1). The 3-keyframe
  // values list with a slight overshoot at 0.7 and snap back to 1 produces
  // a "spring-up" feel using LINEAR interpolation (no out-of-range splines).
  return `<g class="cube" transform="translate(${fmt(anchor.x)} ${fmt(anchor.y)})">
        <g transform="scale(1 0)">
          <animateTransform attributeName="transform" type="scale"
                            values="1 0; 1 1.08; 1 1" keyTimes="0; 0.78; 1"
                            dur="${RISE_DURATION_SEC}s" begin="${fmt(beginSec)}s"
                            fill="freeze"
                            calcMode="spline" keySplines="0.25 0.1 0.3 1; 0.4 0 0.6 1"/>
          <path class="c-sideR-${b.level}" d="${sideR}"/>
          <path class="c-sideL-${b.level}" d="${sideL}"/>
          <path class="c-top-${b.level}"   d="${top}"/>
        </g>
      </g>`;
}

// ===== Style block builder ===============================================

function buildStyleBlock() {
  const lightCss = buildPaletteCss(LEVEL_COLOR.light);
  const darkCss = buildPaletteCss(LEVEL_COLOR.dark);
  const lightVars = renderCssVars(CHARACTER_CSS_VARS.light, "      ");
  const darkVars = renderCssVars(CHARACTER_CSS_VARS.dark, "        ");
  return `<style>
    :root {
      color-scheme: light dark;
${lightVars}
    }
    .caption text {
      font-family: ui-sans-serif, system-ui, "Space Grotesk", "Inter", sans-serif;
      font-size: 4px;
      fill: ${BRAND.light.mutedText};
      letter-spacing: 0.05em;
    }
${indent(lightCss, "    ")}
    @media (prefers-color-scheme: dark) {
      :root {
${darkVars}
      }
      .caption text { fill: ${BRAND.dark.mutedText}; }
${indent(darkCss, "      ")}
    }
  </style>`;
}

function buildPaletteCss(palette) {
  const out = [];
  for (let lv = 0; lv <= 4; lv++) {
    out.push(`.c-top-${lv}   { fill: ${palette.top[lv]}; }`);
    out.push(`.c-sideL-${lv} { fill: ${palette.sideL[lv]}; }`);
    out.push(`.c-sideR-${lv} { fill: ${palette.sideR[lv]}; }`);
  }
  // Floor tiles: always level-0 (empty cells appear as gray; filled cells
  // get their cubes drawn on top so the floor is hidden anyway).
  out.push(`.floor path { fill: ${palette.top[0]}; }`);
  return out.join("\n");
}

function indent(s, pre) {
  return s.split("\n").map((line) => (line ? pre + line : line)).join("\n");
}

// ===== Utilities =========================================================

function fmt(n) {
  return Number.isFinite(n) ? Number(n.toFixed(2)).toString() : "0";
}

function formatDate(iso) {
  // iso like "2025-11-03"
  const [y, m, d] = iso.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}, ${y}`;
}

// Re-export so the renderer/walker share the same import surface.
export { roofCenter, LEVEL_HEIGHT_UNITS } from "./iso-projection.mjs";
