#!/usr/bin/env node
/**
 * generate-hero.mjs
 *
 * Renders the hero typing SVG that opens @ReebalSami's profile README.
 * Cycles through 4 lines with a per-character "type" reveal, in the bronze
 * accent of the portfolio's visual identity. Uses SMIL animations exclusively
 * (which GitHub renders inside <img>-referenced SVGs — already proven by the
 * chibi web-slinger animation in assets/metrics-*.svg).
 *
 * Implementation choice: each character is a <tspan> with its own opacity
 * <animate>. The browser's text engine handles centering and positioning,
 * so we never need to estimate text widths — sidesteps a fragile class of
 * font-metric guessing.
 *
 * Output: assets/hero-typing-light.svg + assets/hero-typing-dark.svg
 *
 * Run:
 *   node scripts/generate-hero.mjs
 *
 * No env vars or network access required.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CARD_PALETTE, TYPO, escapeXml } from "./lib/palette.mjs";

// ----- paths --------------------------------------------------------------

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const ASSETS_DIR = resolve(ROOT, "assets");
mkdirSync(ASSETS_DIR, { recursive: true });

// ----- content ------------------------------------------------------------

/**
 * The 4 hero lines, preserved verbatim from the previous third-party
 * readme-typing-svg URL. Edit this array to update the rotation.
 */
const LINES = [
  "Hi, I'm Reebal — Data Scientist & AI Engineer",
  "Building LLM × Computer Vision systems in Hamburg",
  "M.Sc. Thesis: GraphRAG over local LLMs",
  "Open to Data Scientist / AI Engineer roles — Q2 2026",
];

// ----- timing -------------------------------------------------------------

const TYPE_DUR = 2.5;                      // seconds to type all chars in one line
const HOLD_DUR = 0.7;                      // seconds to hold a fully-typed line
const SLOT = TYPE_DUR + HOLD_DUR;          // total time per line
const CYCLE = LINES.length * SLOT;         // total animation cycle

// ----- geometry -----------------------------------------------------------

const WIDTH = 900;
const HEIGHT = 70;
const BASELINE_Y = 48;                     // text baseline (visually centered for 30px font)

// ----- helpers ------------------------------------------------------------

/** Format a fraction t in [0, 1] with enough precision for SMIL keyTimes. */
const k = (t) => Number(t.toFixed(6)).toString();

/**
 * Build the keyTimes/values for a single character's opacity over one CYCLE.
 *   - Hidden until tAppear (relative time within the cycle)
 *   - Visible from tAppear to tDisappear
 *   - Hidden again until cycle restarts
 */
function charOpacityAnim(tAppearAbs, tDisappearAbs) {
  const kAppear = tAppearAbs / CYCLE;
  const kDisappear = tDisappearAbs / CYCLE;

  // calcMode="discrete" → instant transitions exactly at each keyTime.
  if (kAppear === 0) {
    if (kDisappear >= 1) {
      return { keyTimes: "0;1", values: "1;1" };
    }
    return { keyTimes: `0;${k(kDisappear)};1`, values: "1;0;0" };
  }
  if (kDisappear >= 1) {
    return { keyTimes: `0;${k(kAppear)};1`, values: "0;1;1" };
  }
  return {
    keyTimes: `0;${k(kAppear)};${k(kDisappear)};1`,
    values: "0;1;0;0",
  };
}

// ----- SVG composition ----------------------------------------------------

function renderHero(theme) {
  const p = CARD_PALETTE[theme];

  // For each line, render a single <text> at (WIDTH/2, BASELINE_Y) with
  // text-anchor="middle". Inside, each character is a <tspan> that animates
  // opacity from 0 → 1 at its scheduled appear time. The browser positions
  // every tspan as if all are visible (since they ARE rendered, just with
  // opacity 0 until their cue) — so the line is correctly centered no matter
  // how few are visible.

  const lineGroups = LINES.map((line, i) => {
    const lineStart = i * SLOT;
    const lineEnd = (i + 1) * SLOT;
    const charDelay = TYPE_DUR / Math.max(1, line.length);

    const tspans = Array.from(line).map((char, j) => {
      const tAppear = lineStart + j * charDelay;
      const a = charOpacityAnim(tAppear, lineEnd);
      // Render whitespace as a normal space — preserve-whitespace via xml:space.
      return `<tspan opacity="0">${escapeXml(char)}<animate attributeName="opacity" dur="${CYCLE}s" repeatCount="indefinite" calcMode="discrete" keyTimes="${a.keyTimes}" values="${a.values}"/></tspan>`;
    }).join("");

    return `  <text x="${WIDTH / 2}" y="${BASELINE_Y}" text-anchor="middle"
        class="hero-line" fill="${p.accent}" xml:space="preserve">${tspans}</text>`;
  }).join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img" aria-label="${escapeXml(LINES[0])}">
  <defs>
    <style>
      .hero-line { ${TYPO.heroLine} }
    </style>
  </defs>
${lineGroups}
</svg>
`;
}

// ----- main ---------------------------------------------------------------

function main() {
  for (const theme of ["light", "dark"]) {
    const svg = renderHero(theme);
    const out = resolve(ASSETS_DIR, `hero-typing-${theme}.svg`);
    writeFileSync(out, svg);
    const totalChars = LINES.reduce((s, l) => s + l.length, 0);
    console.log(`Wrote ${out} (${svg.length} bytes, ${LINES.length} lines, ${totalChars} chars, cycle=${CYCLE}s)`);
  }
}

main();
