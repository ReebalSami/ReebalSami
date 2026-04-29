#!/usr/bin/env node
/**
 * test-build.mjs
 *
 * Smoke test: build a synthetic SVG (no GraphQL) and assert the basics.
 * Runs in CI-friendly < 1s on any machine.
 *
 *   - SVG has the expected outer dims
 *   - Exactly weeks*7 floor tiles
 *   - level≥1 cells produce buildings, all with non-zero height
 *   - Walker plans ≥ 1 jump that lands on an actual building
 *   - SMIL well-formed (string presence checks)
 *   - GROUNDING: every jump's `to` is a building from the same set
 *     and its roof.x / roof.y exactly equals roofCenter(gx, gy, level)
 *     — i.e. the renderer and walker share the same geometry.
 *
 * Exit code 0 = OK, 1 = any assert failed.
 */

import { mulberry32 } from "./lib/rng.mjs";
import { renderCity } from "./lib/svg-render.mjs";
import { planTour, SPEED_MULTIPLIER } from "./lib/walker.mjs";
import { buildChibiMarkup } from "./lib/animations.mjs";
import { roofCenter } from "./lib/iso-projection.mjs";

console.log("==> test-build smoke test");

const WEEKS = 26;
const DAYS = 7;
const SEED = 12345;

// ---- 1. synthesize fixture
const rng = mulberry32(SEED);
const days = [];
for (let i = 0; i < WEEKS * DAYS; i++) {
  const gx = Math.floor(i / 7);
  const gy = i % 7;
  const r = rng();
  let level = 0;
  if (r < 0.12) level = 4;
  else if (r < 0.30) level = 3;
  else if (r < 0.50) level = 2;
  else if (r < 0.70) level = 1;
  days.push({
    date: `2026-01-${(i % 28) + 1}`.replace(/(-\d)$/, "-0$1"),
    count: level * 2,
    level,
    gx,
    gy,
  });
}

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  ✔ ${label}`);
  } else {
    console.error(`  ✖ ${label}`);
    failures++;
  }
}

// ---- 2. render BOTH themes and verify each is single-theme
const lightOut = renderCity({ days, weeks: WEEKS, theme: "light" });
const darkOut  = renderCity({ days, weeks: WEEKS, theme: "dark"  });
const { svg, buildings, viewBox, width, height } = lightOut; // legacy alias

assert(typeof svg === "string" && svg.length > 1000, "renderCity returns non-trivial SVG");
assert(svg.startsWith("<svg"), "SVG starts with <svg");
assert(svg.includes("</svg>"), "SVG has closing tag");
assert(width > 100 && height > 50, `SVG has reasonable dims (${width}x${height})`);

// Theme isolation: NO @media block in either file (we use <picture> instead).
assert(!lightOut.svg.includes("@media"), "light SVG has no @media block");
assert(!darkOut.svg.includes("@media"),  "dark SVG has no @media block");

// Theme correctness: floor color matches GitHub Primer for that theme.
assert(lightOut.svg.includes("#eff2f5"), "light SVG floor uses #eff2f5");
assert(darkOut.svg.includes("#151b23"),  "dark SVG floor uses #151b23");
assert(!lightOut.svg.includes("#151b23"), "light SVG does NOT contain dark floor color");
assert(!darkOut.svg.includes("#eff2f5"),  "dark SVG does NOT contain light floor color");
assert(lightOut.svg.includes("color-scheme: light"), "light SVG declares color-scheme: light");
assert(darkOut.svg.includes("color-scheme: dark"),   "dark SVG declares color-scheme: dark");

// Floor tiles: should be exactly WEEKS * DAYS path elements inside .floor
const floorMatch = svg.match(/<g class="floor">([\s\S]*?)<\/g>/);
const floorPaths = floorMatch ? (floorMatch[1].match(/<path/g) || []) : [];
assert(floorPaths.length === WEEKS * DAYS, `floor has ${WEEKS * DAYS} tiles (got ${floorPaths.length})`);

// Buildings: every building has roof + level + h
const expectedBuildings = days.filter((d) => d.level >= 1).length;
assert(buildings.length === expectedBuildings, `${expectedBuildings} buildings (got ${buildings.length})`);
assert(buildings.every((b) => b.h > 0), "all buildings have positive height");
assert(buildings.every((b) => Number.isFinite(b.roof.x) && Number.isFinite(b.roof.y)), "all buildings have finite roof coords");

// Roof grounding: each building's roof MUST equal roofCenter(gx, gy, level)
let roofMismatch = 0;
for (const b of buildings) {
  const r = roofCenter(b.gx, b.gy, b.level);
  if (Math.abs(r.x - b.roof.x) > 1e-6 || Math.abs(r.y - b.roof.y) > 1e-6) {
    roofMismatch++;
  }
}
assert(roofMismatch === 0, "all building.roof equals roofCenter() — single source of truth");

// SMIL rise: every cube has the rise animation
const cubeRiseAnims = (svg.match(/<animateTransform[^>]*type="scale"/g) || []).length;
assert(cubeRiseAnims >= buildings.length, `at least ${buildings.length} cube-rise animations (got ${cubeRiseAnims})`);

// ---- 3. plan tour
const tour = planTour(buildings, { seed: SEED });
assert(tour.events.length >= 2, `tour has events (got ${tour.events.length})`);
assert(tour.totalDuration > 0, `tour has positive duration (${tour.totalDuration.toFixed(2)}s)`);

const buildingSet = new Set(buildings);
const offRoofJumps = tour.events.filter(
  (e) => e.type === "jump" && !buildingSet.has(e.to)
).length;
assert(offRoofJumps === 0, "no off-roof landings");

// Roof grounding (walker side): every jump's `to.roof` must equal roofCenter(to.gx, to.gy, to.level)
let walkerRoofMismatch = 0;
for (const e of tour.events) {
  if (e.type !== "jump") continue;
  const r = roofCenter(e.to.gx, e.to.gy, e.to.level);
  if (Math.abs(r.x - e.to.roof.x) > 1e-6 || Math.abs(r.y - e.to.roof.y) > 1e-6) {
    walkerRoofMismatch++;
  }
}
assert(walkerRoofMismatch === 0, "every jump lands on roofCenter() — geometry contract holds");

const slowdown = SPEED_MULTIPLIER;
assert(slowdown >= 1.3 && slowdown <= 1.5, `SPEED_MULTIPLIER ≈ 1.4 (got ${slowdown})`);

// Pacing: doubled idleProb + per-step micro-pauses + 20%-longer idle dwell
// means BOTH more idle events and more total pause time (≈1.8× baseline).
// Idle count caps because each idle (~1.2s) eats from the 28s budget.
// Threshold 0.10 = at least 10% idle:jump ratio — comfortably above the
// "no idles at all" failure mode (~0.05) but achievable across seeds.
const jumpCount = tour.events.filter((e) => e.type === "jump").length;
const idleCount = tour.events.filter((e) => e.type === "idle").length;
const idleRatio = idleCount / Math.max(1, jumpCount);
assert(idleCount >= 5, `tour has ≥5 idle events (got ${idleCount})`);
assert(idleRatio >= 0.10, `idle:jump ratio ≥0.10 (got ${idleRatio.toFixed(2)} = ${idleCount}/${jumpCount})`);

// ---- 4. build chibi markup
const chibi = buildChibiMarkup({ tour });
assert(chibi.includes('class="ws-root"'), "chibi has root group");
assert(chibi.includes('class="ws-flip"'), "chibi has flip group");
assert(chibi.includes('class="ws-web"'), "chibi has web strand");
assert(chibi.includes("animateTransform"), "chibi has animateTransform");

// ---- 5. final
console.log(`==> ${failures === 0 ? "PASS" : "FAIL"} (${failures} failures)`);
process.exit(failures > 0 ? 1 : 0);
