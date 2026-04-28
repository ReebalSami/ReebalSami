#!/usr/bin/env node
/**
 * inject-webslinger.mjs
 *
 * Reads a lowlighter/metrics isocalendar SVG, extracts every contribution
 * cube, plans a parkour tour for a chibi web-slinger character, and emits
 * a fully-baked SMIL animation injected into the SVG. No JS at runtime —
 * GitHub renders the SVG natively and the SMIL plays the pre-computed
 * waypoint sequence.
 *
 * Pipeline:
 *   parseBuildings()  → array of cube positions + levels
 *   planTour()        → array of jump/idle events (deterministic per seed)
 *   buildSMIL()       → keyTimes/values for translate/scale/rotate/opacity
 *   buildCharacter()  → static character markup
 *   inject            → splice into the outer <svg>
 *
 * Usage:
 *   node scripts/inject-webslinger.mjs <svg-path> <light|dark> [seed]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseBuildings } from "./parse-iso-calendar.mjs";
import { planTour } from "./plan-character-tour.mjs";
import { buildCharacterBody, PALETTE as CHAR_PALETTE } from "./webslinger-character.mjs";

// ----- args ---------------------------------------------------------------

const [, , svgPathArg, themeArg = "light", seedArg] = process.argv;
if (!svgPathArg) {
  console.error("Usage: inject-webslinger <svg-path> <light|dark> [seed]");
  process.exit(1);
}
if (themeArg !== "light" && themeArg !== "dark") {
  console.error(`Theme must be 'light' or 'dark', got '${themeArg}'`);
  process.exit(1);
}

const svgPath = resolve(svgPathArg);
const theme = themeArg;
// Daily-rotating seed: day-number since epoch + theme tweak so light & dark
// don't share an identical tour (slight visual difference between variants).
const seed =
  seedArg !== undefined
    ? parseInt(seedArg, 10)
    : Math.floor(Date.now() / 86_400_000) + (theme === "dark" ? 7919 : 0);

const TOTAL_DUR_SEC = 20;

// ----- read SVG -----------------------------------------------------------

let svg = readFileSync(svgPath, "utf8");

// ----- idempotency: strip any prior injection -----------------------------

function stripPriorInjection(s) {
  let cleaned = s.replace(
    /\n*<!-- webslinger character[^]*?<g class="webslinger">[^]*?<\/g>\s*<\/g>\s*\n?/g,
    ""
  );
  cleaned = cleaned.replace(
    /<g class="webslinger">[^]*?<\/g>\s*<\/g>\s*\n?/g,
    ""
  );
  cleaned = cleaned.replace(
    /\n*<style>\s*\/\* webslinger brand overrides[^]*?<\/style>\s*\n?/g,
    ""
  );
  cleaned = cleaned.replace(
    /<svg([^>]*?)\s+data-ws-orig-height="([0-9.]+)"([^>]*)>/,
    (_match, before, origH, after) => {
      let tag = `<svg${before}${after}>`;
      tag = tag.replace(/\bheight="[0-9.]+"/, `height="${origH}"`);
      tag = tag.replace(
        /\bviewBox="([0-9.\-]+)\s+([0-9.\-]+)\s+([0-9.\-]+)\s+[0-9.\-]+"/,
        (_m, x, y, w) => `viewBox="${x} ${y} ${w} ${origH}"`
      );
      return tag;
    }
  );
  return cleaned;
}

const beforeStripLen = svg.length;
svg = stripPriorInjection(svg);
if (svg.length !== beforeStripLen) {
  console.log(
    `🧹 Stripped prior injection (${beforeStripLen - svg.length} bytes removed)`
  );
}

// ----- find outer SVG dimensions ------------------------------------------

const outerMatch = svg.match(/<svg\b[^>]*>/);
if (!outerMatch) {
  console.error(`No <svg> root tag found in ${svgPath}`);
  process.exit(1);
}
const outerTag = outerMatch[0];

function parseDim(tag, attr) {
  const m = tag.match(new RegExp(`\\b${attr}="([0-9.]+)"`));
  return m ? parseFloat(m[1]) : null;
}

let width = parseDim(outerTag, "width");
let height = parseDim(outerTag, "height");
if (!width || !height) {
  const vb = outerTag.match(
    /viewBox="\s*([0-9.\-]+)\s+([0-9.\-]+)\s+([0-9.\-]+)\s+([0-9.\-]+)\s*"/
  );
  if (vb) {
    width = width ?? parseFloat(vb[3]);
    height = height ?? parseFloat(vb[4]);
  }
}
if (!width || !height) {
  console.error(`Could not determine SVG dimensions from outer tag: ${outerTag}`);
  process.exit(1);
}
console.log(`📐 Outer SVG: ${width}×${height}`);

// ----- parse buildings + plan tour ----------------------------------------

const buildings = parseBuildings(svg);
const tall = buildings.filter((b) => b.level >= 1);
console.log(
  `🏙️  Found ${buildings.length} cells (${tall.length} buildings level≥1)`
);

if (tall.length < 2) {
  console.warn(
    "⚠️  Not enough buildings to plan a tour — character will idle in place."
  );
}

const tour = planTour(buildings, { seed, durationSec: TOTAL_DUR_SEC });
console.log(
  `🗺️  Planned tour: seed=${seed}, ${tour.events.length} events, ${tour.totalDuration.toFixed(2)}s`
);

// ----- build SMIL keyframes from tour -------------------------------------
/**
 * For each jump, we emit 5 sub-keyframes approximating a parabolic arc:
 *   t_jump_start: from
 *   +0.25:        25% along + 75% of arcHeight up
 *   +0.50:        midway + full arcHeight up (apex)
 *   +0.75:        75% along + 75% of arcHeight up
 *   +1.00:        to (landing)
 * For idles, we emit ONE keyframe holding position. Head rotation gets
 * its own intra-idle sub-keyframes for the "look around" wobble.
 */

const totalDur = Math.max(tour.totalDuration, TOTAL_DUR_SEC * 0.5);

// Position keyframes (translate)
const posValues = [];
const posKeyTimes = [];

// Facing keyframes (scale x = ±1) — discrete flips
const flipValues = [];
const flipKeyTimes = [];

// Head rotation keyframes (degrees)
const headValues = [];
const headKeyTimes = [];

// Web strand opacity keyframes — discrete on/off
const webValues = [];
const webKeyTimes = [];

let t = 0;
let curX = 0;
let curY = 0;
let curFacing = "right";

function pushPos(time, x, y) {
  // Avoid duplicate adjacent identical times (would break SMIL).
  const k = time / totalDur;
  if (posKeyTimes.length > 0 && Math.abs(posKeyTimes[posKeyTimes.length - 1] - k) < 1e-6) {
    // Replace last
    posValues[posValues.length - 1] = `${x.toFixed(2)},${y.toFixed(2)}`;
  } else {
    posKeyTimes.push(k);
    posValues.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  curX = x;
  curY = y;
}
function pushFacing(time, facing) {
  if (facing === curFacing && flipValues.length > 0) return;
  const k = time / totalDur;
  flipKeyTimes.push(k);
  flipValues.push(facing === "left" ? "-1 1" : "1 1");
  curFacing = facing;
}
function pushHead(time, deg) {
  headKeyTimes.push(time / totalDur);
  headValues.push(deg.toString());
}
function pushWeb(time, opacity) {
  webKeyTimes.push(time / totalDur);
  webValues.push(opacity.toString());
}

// Initialize
const startEvent = tour.events.find((e) => e.type === "start");
if (!startEvent) {
  console.error("Tour has no start event — cannot animate.");
  process.exit(1);
}
pushPos(0, startEvent.at.px, startEvent.at.py);
pushFacing(0, "right");
pushHead(0, 0);
pushWeb(0, 0);

for (let i = 0; i < tour.events.length; i++) {
  const e = tour.events[i];
  if (e.type === "start") continue;

  if (e.type === "jump") {
    pushFacing(t + Math.min(0.05, e.dur * 0.1), e.facing);

    const fx = e.from.px;
    const fy = e.from.py;
    const tx = e.to.px;
    const ty = e.to.py;
    const dx = tx - fx;
    const dy = ty - fy;
    // Apex y = MIN of the two endpoints minus arcHeight (lower y = higher visual)
    const apexBase = Math.min(fy, ty);

    // 4 intermediate keyframes (1/4, 1/2, 3/4) plus the landing (1)
    // Quadratic-like: y_offset = -arcHeight * 4 * τ * (1 - τ) where τ in [0..1]
    for (const frac of [0.25, 0.5, 0.75, 1.0]) {
      const subT = t + e.dur * frac;
      const lerpX = fx + dx * frac;
      // Parabolic offset from baseline using τ * (1-τ) which peaks at τ=0.5
      const tau = frac;
      const yOffsetUp = e.arcHeight * 4 * tau * (1 - tau);
      // Lerp BASELINE between fy and ty for the slope component
      const baseY = fy + dy * frac;
      const lerpY = baseY - yOffsetUp;
      pushPos(subT, lerpX, lerpY);
    }

    // Web strand opacity: snap visible just after takeoff, peak at apex,
    // snap hidden just before landing.
    pushWeb(t + e.dur * 0.05, 0);
    pushWeb(t + e.dur * 0.06, 0.85);
    pushWeb(t + e.dur * 0.5, 1.0);
    pushWeb(t + e.dur * 0.85, 0.5);
    pushWeb(t + e.dur * 0.92, 0);

    // Head: keep neutral during jump
    pushHead(t + e.dur * 0.5, 0);
    pushHead(t + e.dur, 0);

    t += e.dur;
    continue;
  }

  if (e.type === "idle") {
    // Position: hold (same x, y as last)
    const heldX = e.at.px;
    const heldY = e.at.py;

    // Head wobble during idle: a 4-step cycle scaled to idle duration.
    const headSeq = [-12, 9, -7, 0];
    for (let s = 0; s < headSeq.length; s++) {
      const subT = t + e.dur * ((s + 1) / headSeq.length);
      pushHead(subT, headSeq[s]);
      // Position holds
      pushPos(subT, heldX, heldY);
    }
    // Web hidden during idle (already 0 from previous web=0 keyframe)
    t += e.dur;
    continue;
  }
}

// Pad tail to TOTAL_DUR if needed (so the loop has consistent length).
if (t < TOTAL_DUR_SEC) {
  pushPos(TOTAL_DUR_SEC, curX, curY);
  pushHead(TOTAL_DUR_SEC, 0);
  pushWeb(TOTAL_DUR_SEC, 0);
}
// Always end with the SAME position as start so SMIL loops cleanly.
const lastPosClean = posValues[posValues.length - 1];
const startPosClean = posValues[0];
if (lastPosClean !== startPosClean) {
  // Add one more keyframe at exactly t=1 with start position.
  // (Rarely needed because tour planner closes the loop, but safe to be explicit.)
  pushPos(TOTAL_DUR_SEC, startEvent.at.px, startEvent.at.py);
}

// Sanitize: ensure keyTimes are strictly non-decreasing within [0, 1]
function normalizeKeyframes(keyTimes, values) {
  // Pair-sort (shouldn't be needed; our time progression is monotonic)
  // Clamp last to 1.0
  if (keyTimes.length > 0) {
    keyTimes[keyTimes.length - 1] = 1;
  }
  // Format
  return {
    keyTimes: keyTimes.map((k) => Math.max(0, Math.min(1, k)).toFixed(5)).join(";"),
    values: values.join(";"),
  };
}

const posAnim = normalizeKeyframes(posKeyTimes, posValues);
const headAnim = normalizeKeyframes(headKeyTimes, headValues);
const webAnim = normalizeKeyframes(webKeyTimes, webValues);
const flipAnim = normalizeKeyframes(flipKeyTimes, flipValues);

// ----- expand outer SVG height (give the character vertical room) ---------
// The character's head reaches up to ~14px above feet, plus arc apex ~26px
// above the highest building. We add a modest HEADROOM at the top.

const HEADROOM_TOP = 30;
const newHeight = height + HEADROOM_TOP;

let newOuterTag = outerTag;
if (newOuterTag.match(/\bheight="[0-9.]+"/)) {
  newOuterTag = newOuterTag.replace(
    /\bheight="[0-9.]+"/,
    `height="${newHeight}"`
  );
} else {
  newOuterTag = newOuterTag.replace("<svg", `<svg height="${newHeight}"`);
}
if (newOuterTag.match(/\bviewBox="[^"]+"/)) {
  newOuterTag = newOuterTag.replace(
    /\bviewBox="[^"]+"/,
    `viewBox="0 ${-HEADROOM_TOP} ${width} ${newHeight}"`
  );
} else {
  newOuterTag = newOuterTag.replace(
    "<svg",
    `<svg viewBox="0 ${-HEADROOM_TOP} ${width} ${newHeight}"`
  );
}
if (!newOuterTag.includes("data-ws-orig-height=")) {
  newOuterTag = newOuterTag.replace(
    "<svg",
    `<svg data-ws-orig-height="${height}"`
  );
}
svg = svg.replace(outerTag, newOuterTag);

// ----- build character body + assemble webslinger group --------------------

const charMarkup = buildCharacterBody({ theme });

// Add the head rotation animateTransform inside the existing <g class="ws-head"> group.
const headAnimateMarkup = `
      <animateTransform attributeName="transform" type="rotate"
                        values="${headAnim.values}"
                        keyTimes="${headAnim.keyTimes}"
                        dur="${TOTAL_DUR_SEC}s"
                        repeatCount="indefinite"
                        additive="sum"/>`;
const charWithHeadAnim = charMarkup.replace(
  /<g class="ws-head">/,
  `<g class="ws-head">${headAnimateMarkup}`
);

// Add the web strand opacity animation inside the <line class="ws-web"> element.
const webAnimateMarkup = `
      <animate attributeName="opacity"
               values="${webAnim.values}"
               keyTimes="${webAnim.keyTimes}"
               dur="${TOTAL_DUR_SEC}s"
               repeatCount="indefinite"
               calcMode="discrete"/>`;
const charComplete = charWithHeadAnim.replace(
  /(<line class="ws-web"[\s\S]*?)(\/>)/,
  `$1>${webAnimateMarkup}\n    </line>`
);

const webslingerGroup = `
<g class="webslinger">
  <animateTransform attributeName="transform" type="translate"
                    values="${posAnim.values}"
                    keyTimes="${posAnim.keyTimes}"
                    dur="${TOTAL_DUR_SEC}s"
                    repeatCount="indefinite"/>
  <g class="ws-flip">
    <animateTransform attributeName="transform" type="scale"
                      values="${flipAnim.values}"
                      keyTimes="${flipAnim.keyTimes}"
                      dur="${TOTAL_DUR_SEC}s"
                      repeatCount="indefinite"
                      calcMode="discrete"
                      additive="sum"/>
    ${charComplete}
  </g>
</g>
`.trim();

// ----- brand-color CSS overrides -----------------------------------------

const PAL = {
  light: {
    fg: "#22222A",
    accent: "#B6803F",
    border: "rgba(34,34,42,0.08)",
    emptyCell: "#ebedf0", // GitHub native (light)
  },
  dark: {
    fg: "#F5F4EE",
    accent: "#D4A574",
    border: "rgba(245,244,238,0.10)",
    emptyCell: "#161b22", // GitHub native (dark) — matches contribution chart
  },
};
const p = PAL[theme];

const brandStyle = `
<style>
  /* webslinger brand overrides */
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
  /* Recolor empty iso-calendar cells (default fill="#ebedf0") to match
     GitHub's native contribution chart background. */
  path[fill="#ebedf0"] { fill: ${p.emptyCell} !important; }
</style>
`;

// ----- splice into outer SVG just before </svg> ---------------------------

const closingIdx = svg.lastIndexOf("</svg>");
if (closingIdx === -1) {
  console.error("Could not locate closing </svg> tag");
  process.exit(1);
}

const before = svg.slice(0, closingIdx);
const after = svg.slice(closingIdx);

const out =
  before +
  brandStyle +
  `\n<!-- webslinger character — chibi parkour with pre-computed tour -->\n` +
  webslingerGroup +
  "\n" +
  after;

writeFileSync(svgPath, out);
console.log(
  `✅ Injected webslinger (${theme}) → ${svgPath} — dimensions ${width}×${newHeight}`
);
