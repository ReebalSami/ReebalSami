#!/usr/bin/env node
/**
 * inject-webslinger.mjs
 *
 * Post-processes a metrics-generated SVG (lowlighter/metrics output containing
 * the isocalendar plugin) and injects an animated chibi web-slinger character
 * that swings across the visible area in a multi-arc path.
 *
 * Strategy:
 *   - Read the outer SVG element's width/height attributes
 *   - Build a 6-anchor swing path in those pixel coordinates
 *   - Insert the webslinger group as the last child of the outer SVG so it
 *     renders on top of everything else (including the foreignObject body)
 *   - Also expand the outer SVG height a bit to give the swing arc room
 *
 * Usage:
 *   node scripts/inject-webslinger.mjs <svg-path> <theme>
 *   e.g. node scripts/inject-webslinger.mjs assets/metrics-light.svg light
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildWebslinger,
  buildSwingPath,
  defaultAnchorsForSize,
} from "./webslinger-character.mjs";

// ----- args ---------------------------------------------------------------

const [, , svgPathArg, themeArg = "light"] = process.argv;
if (!svgPathArg) {
  console.error("Usage: inject-webslinger <svg-path> <light|dark>");
  process.exit(1);
}
if (themeArg !== "light" && themeArg !== "dark") {
  console.error(`Theme must be 'light' or 'dark', got '${themeArg}'`);
  process.exit(1);
}

const svgPath = resolve(svgPathArg);
const theme = themeArg;

// ----- read + parse outer dimensions --------------------------------------

let svg = readFileSync(svgPath, "utf8");

// Match the outer <svg ...> opening tag.
const outerMatch = svg.match(/<svg\b[^>]*>/);
if (!outerMatch) {
  console.error(`No <svg> root tag found in ${svgPath}`);
  process.exit(1);
}
const outerTag = outerMatch[0];

function parseDim(tag, attr) {
  const re = new RegExp(`\\b${attr}="([0-9.]+)"`);
  const m = tag.match(re);
  return m ? parseFloat(m[1]) : null;
}

let width = parseDim(outerTag, "width");
let height = parseDim(outerTag, "height");

// If width/height aren't on the root, try the viewBox.
if (!width || !height) {
  const vb = outerTag.match(/viewBox="\s*([0-9.\-]+)\s+([0-9.\-]+)\s+([0-9.\-]+)\s+([0-9.\-]+)\s*"/);
  if (vb) {
    width = width ?? parseFloat(vb[3]);
    height = height ?? parseFloat(vb[4]);
  }
}

if (!width || !height) {
  console.error(`Could not determine SVG dimensions from outer tag: ${outerTag}`);
  process.exit(1);
}

console.log(`📐 Outer SVG dimensions: ${width}×${height}`);

// ----- expand height + plan the swing path -------------------------------
// The lowlighter isocalendar content lives inside a <foreignObject> with HTML
// children; wrapping that foreignObject in a transformed <g> breaks its
// rendering. So we keep the foreignObject in place and:
//   1) Expand outer SVG height by HEADROOM at the BOTTOM (gives the character
//      a "ground level" to swing toward without overlapping the streak/commit
//      stats column on the right)
//   2) Plan the swing path to weave THROUGH the iso-calendar towers — anchor
//      lows in the lower iso-band, peaks just above the highest towers — so
//      the character looks like he's swinging across the contribution skyline.

const HEADROOM = 20;
const newHeight = height + HEADROOM;

// Iso calendar geometry inside the lowlighter SVG (480x310 typical):
//   - heading + stats text column occupy x ≈ 300 – 480 on the right side
//   - iso projection occupies x ≈ 0 – 280
//   - tower tops sit around y ≈ 50 – 90
//   - bottom of iso projection around y ≈ 200 – 230
// The character must NOT swing into the right-side stats column (x > 0.62 *
// width). We constrain anchors to the LEFT 60% of the width.
const lowY = Math.max(180, height * 0.65);
const peakY = Math.max(40, height * 0.18);

const xMin = width * 0.04;
const xMax = width * 0.60; // stops before the stats column
const span = xMax - xMin;
const anchors = [
  { x: xMin + span * 0.00, y: lowY + 30 },
  { x: xMin + span * 0.18, y: lowY },
  { x: xMin + span * 0.36, y: lowY + 8 },
  { x: xMin + span * 0.54, y: lowY - 6 },
  { x: xMin + span * 0.72, y: lowY + 8 },
  { x: xMin + span * 0.88, y: lowY - 4 },
  { x: xMin + span * 1.00, y: lowY + 30 },
];
const peak = lowY - peakY;
const swingPath = buildSwingPath({ anchors, peak });

// ----- build the webslinger group -----------------------------------------

const webslinger = buildWebslinger({
  theme,
  swingPath,
  durationSec: 14,
});

// ----- rewrite the outer SVG --------------------------------------------
// 1) Update the outer <svg> height attribute to newHeight
// 2) Update or add viewBox to "0 0 width newHeight"
// 3) Append the webslinger group right before </svg>

let newOuterTag = outerTag;

if (newOuterTag.match(/\bheight="[0-9.]+"/)) {
  newOuterTag = newOuterTag.replace(/\bheight="[0-9.]+"/, `height="${newHeight}"`);
} else {
  newOuterTag = newOuterTag.replace("<svg", `<svg height="${newHeight}"`);
}

if (newOuterTag.match(/\bviewBox="[^"]+"/)) {
  newOuterTag = newOuterTag.replace(
    /\bviewBox="[^"]+"/,
    `viewBox="0 0 ${width} ${newHeight}"`
  );
} else {
  newOuterTag = newOuterTag.replace("<svg", `<svg viewBox="0 0 ${width} ${newHeight}"`);
}

svg = svg.replace(outerTag, newOuterTag);

// Append the webslinger just before the closing </svg> tag.
const closingIdx = svg.lastIndexOf("</svg>");
if (closingIdx === -1) {
  console.error("Could not locate closing </svg> tag");
  process.exit(1);
}

const before = svg.slice(0, closingIdx);
const after = svg.slice(closingIdx);

// Brand-color CSS overrides (apply to the lowlighter-rendered calendar HTML
// inside foreignObject and to any SVG text labels). Injected at the end of
// the SVG where it'll still cascade over earlier rules.

const PALETTE = {
  light: {
    fg: "#22222A",
    muted: "#7C7C82",
    accent: "#B6803F",
    border: "rgba(34,34,42,0.08)",
    // Empty iso cells stay light grey (matches the warm cream README bg)
    emptyCellFill: "#ebedf0",
  },
  dark: {
    fg: "#F5F4EE",
    muted: "#A4A4AC",
    accent: "#D4A574",
    border: "rgba(245,244,238,0.10)",
    // Empty iso cells become near-transparent dark so they blend into the
    // GitHub dark page bg instead of forming a cream ground plane.
    emptyCellFill: "#1B1B20",
  },
};
const p = PALETTE[theme];

const brandStyle = `
<style>
  /* Brand palette overrides for the lowlighter calendar content.
     Scoped broadly because the calendar is rendered inside a foreignObject. */
  svg { background: transparent; }
  text, tspan { fill: ${p.fg}; }
  h2, h3 {
    color: ${p.accent} !important;
    font-family: "Space Grotesk", "Inter", ui-sans-serif, system-ui, sans-serif !important;
    font-weight: 600 !important;
  }
  .field b { color: ${p.accent} !important; font-weight: 600; }
  h2 svg, h3 svg { fill: ${p.accent} !important; }
  svg.calendar .day { outline-color: ${p.border} !important; }
  /* Recolor the empty iso-calendar cells (default fill="#ebedf0").
     The lowlighter plugin uses 3 path elements per cube (top, left, right).
     We override all three so the "ground plane" of empty cells blends
     into the README background instead of looking like a cream slab. */
  path[fill="#ebedf0"] { fill: ${p.emptyCellFill} !important; }
  /* Note: we deliberately KEEP the green tower colors for filled cells —
     they read as a skyline and the chibi web-slinger swings through them. */
</style>
`;

const out =
  before +
  brandStyle +
  `\n<!-- webslinger character — chibi homage, SMIL-animated swing path -->\n` +
  webslinger +
  "\n" +
  after;

writeFileSync(svgPath, out);
console.log(
  `✅ Injected webslinger (${theme}) into ${svgPath} — new dimensions ${width}×${newHeight}`
);
