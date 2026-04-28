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

// ----- expand height + ensure viewBox -------------------------------------
// The character swings ABOVE the calendar (web-strands hang from above), so
// we need a bit of headroom above the original height. We add 60px and shift
// the existing content down via a wrapping <g>.

const HEADROOM = 80;
const newHeight = height + HEADROOM;

// Build the swing path in NEW coordinates: the iso calendar is in the
// upper third of the original height (after we shift down by HEADROOM, the
// iso starts around y=HEADROOM and runs through ~HEADROOM+180). The character
// should swing in the area between y=HEADROOM+30 and y=newHeight-40, with
// arcs peaking near y=HEADROOM-20.
const { anchors } = defaultAnchorsForSize({ width, height });
// Shift anchors down by HEADROOM to account for the new offset
const shiftedAnchors = anchors.map((a) => ({ x: a.x, y: a.y + HEADROOM }));
const swingPath = buildSwingPath({ anchors: shiftedAnchors, peak: 70 });

// ----- build the webslinger group -----------------------------------------

const webslinger = buildWebslinger({
  theme,
  swingPath,
  durationSec: 14,
  scale: 1.4,
});

// ----- rewrite the outer SVG --------------------------------------------
// 1) Replace outer <svg> tag's height attribute with newHeight
// 2) Add or update viewBox to "0 0 width newHeight"
// 3) Wrap existing content in <g transform="translate(0, HEADROOM)"> ... </g>
// 4) Append webslinger group right before </svg>

let newOuterTag = outerTag;

// Update height attribute
if (newOuterTag.match(/\bheight="[0-9.]+"/)) {
  newOuterTag = newOuterTag.replace(/\bheight="[0-9.]+"/, `height="${newHeight}"`);
} else {
  newOuterTag = newOuterTag.replace("<svg", `<svg height="${newHeight}"`);
}

// Update or add viewBox
if (newOuterTag.match(/\bviewBox="[^"]+"/)) {
  newOuterTag = newOuterTag.replace(
    /\bviewBox="[^"]+"/,
    `viewBox="0 0 ${width} ${newHeight}"`
  );
} else {
  newOuterTag = newOuterTag.replace("<svg", `<svg viewBox="0 0 ${width} ${newHeight}"`);
}

// Replace the original outer tag
svg = svg.replace(outerTag, newOuterTag);

// Wrap existing inner content in a translate group. We do this by inserting
// `<g transform="translate(0,HEADROOM)">` right after the outer <svg> open tag,
// and inserting `</g>` right before the closing </svg>.
const openTagEndIdx = svg.indexOf(newOuterTag) + newOuterTag.length;
const closingIdx = svg.lastIndexOf("</svg>");
if (closingIdx === -1) {
  console.error("Could not locate closing </svg> tag");
  process.exit(1);
}

const before = svg.slice(0, openTagEndIdx);
const middle = svg.slice(openTagEndIdx, closingIdx);
const after = svg.slice(closingIdx);

// Inject brand-color override <style> block + transparent bg + content wrapper
// + webslinger group at the end.

const PALETTE = {
  light: {
    bg: "transparent",
    fg: "#22222A",
    muted: "#7C7C82",
    accent: "#B6803F",
    border: "rgba(34,34,42,0.08)",
    h2: "#B6803F",
    field: "#22222A",
  },
  dark: {
    bg: "transparent",
    fg: "#F5F4EE",
    muted: "#A4A4AC",
    accent: "#D4A574",
    border: "rgba(245,244,238,0.10)",
    h2: "#D4A574",
    field: "#F5F4EE",
  },
};
const p = PALETTE[theme];

// Brand override style — injected at the very top of the wrapped content so
// it cascades over the lowlighter defaults.
const brandStyle = `
<style>
  .ws-brand-bg { fill: ${p.bg}; }
  .ws-overlay svg, .ws-overlay foreignObject, .ws-overlay :root {
    background: transparent !important;
  }
  .ws-overlay text, .ws-overlay tspan { fill: ${p.fg} !important; }
  .ws-overlay h2, .ws-overlay h3 {
    color: ${p.h2} !important;
    font-family: "Space Grotesk", "Inter", ui-sans-serif, system-ui, sans-serif !important;
    font-weight: 600 !important;
  }
  .ws-overlay .field, .ws-overlay .field text { color: ${p.field} !important; fill: ${p.field} !important; }
  .ws-overlay .field b { color: ${p.accent} !important; fill: ${p.accent} !important; font-weight: 600; }
  .ws-overlay h2 svg, .ws-overlay h3 svg { fill: ${p.accent} !important; }
  .ws-overlay svg.calendar .day { outline-color: ${p.border} !important; }
  .ws-overlay rect[fill="#28a745"], .ws-overlay rect[fill="#196c2e"] { fill: ${p.accent} !important; }
  /* Keep iso-calendar tower colors as GitHub greens — looks better as a city-scape */
</style>
`;

const wrapped =
  `${brandStyle}
<g class="ws-overlay" transform="translate(0, ${HEADROOM})">
${middle}
</g>
<!-- webslinger character — chibi homage, SMIL-animated swing path -->
${webslinger}
`;

const out = before + wrapped + after;

writeFileSync(svgPath, out);
console.log(
  `✅ Injected webslinger (${theme}) into ${svgPath} — new dimensions ${width}×${newHeight}`
);
