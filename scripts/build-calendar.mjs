#!/usr/bin/env node
/**
 * build-calendar.mjs
 *
 * The single entry point for the daily build. Glues all modules together:
 *
 *   contributions.fetchContributions()  → real GitHub day grid
 *   svg-render.renderCity()             → iso city SVG + buildings list
 *   walker.planTour()                   → Spider-Man tour over buildings
 *   animations.buildChibiMarkup()       → SMIL-rigged chibi <g>
 *
 * Writes the final SVG to `assets/metrics.svg`.
 *
 * Daily-rotating seed: day-number since epoch. Cache-friendly (same SVG
 * for the same day) but a fresh tour pattern every UTC midnight.
 *
 * Usage:
 *   node scripts/build-calendar.mjs                       # uses GITHUB_TOKEN env
 *   node scripts/build-calendar.mjs --user X              # override user
 *   node scripts/build-calendar.mjs --weeks 26            # override window
 *   node scripts/build-calendar.mjs --out path.svg        # override output
 *   node scripts/build-calendar.mjs --seed N              # deterministic tour
 *   node scripts/build-calendar.mjs --fixture             # use synthetic data (no token)
 *   node scripts/build-calendar.mjs --theme light|dark|both  # default 'both'
 *
 * With --theme both (the default), --out's `.svg` is replaced by `-light.svg`
 * and `-dark.svg` so you get TWO files. The README pairs them with <picture>.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { fetchContributions } from "./lib/contributions.mjs";
import { renderCity } from "./lib/svg-render.mjs";
import { planTour } from "./lib/walker.mjs";
import { buildChibiMarkup } from "./lib/animations.mjs";
import { mulberry32 } from "./lib/rng.mjs";

// ===== CLI parsing ======================================================

const args = parseArgs(process.argv.slice(2));
const config = {
  user: args.user || "ReebalSami",
  weeks: parseInt(args.weeks || "26", 10),
  out: args.out || "assets/metrics.svg",
  seed: args.seed != null ? parseInt(args.seed, 10) : Math.floor(Date.now() / 86_400_000),
  fixture: !!args.fixture,
  theme: args.theme || "both",
};
if (!["light", "dark", "both"].includes(config.theme)) {
  throw new Error(`--theme must be one of: light, dark, both (got '${config.theme}')`);
}

console.log(`==> build-calendar`);
console.log(`    user=${config.user} weeks=${config.weeks} seed=${config.seed} theme=${config.theme} out=${config.out}${config.fixture ? " (fixture)" : ""}`);

// ===== 1. Fetch / synthesize day grid ===================================

let days;
if (config.fixture) {
  days = synthesizeFixture(config.weeks, config.seed);
  console.log(`==> fixture: ${days.length} days`);
} else {
  const fetched = await fetchContributions({
    user: config.user,
    weeks: config.weeks,
  });
  days = fetched.days;
  console.log(`==> fetched ${days.length} days, ${fetched.total} total contributions`);
}

// ===== 2. Plan tour once (theme-independent) ============================
//
// Buildings + tour are derived from grid geometry alone, so they are the
// same in both themes. We render once per theme afterwards, varying only
// the stylesheet and the chibi CSS-vars.

const { buildings, viewBox, width, height } = renderCity({
  days,
  weeks: config.weeks,
  theme: "light", // theme doesn't affect buildings/viewBox; pick either
  characterMarkup: "",
});
console.log(`==> rendered ${buildings.length} buildings, viewBox ${fmtVB(viewBox)}, ${width}×${height}`);

const tour = planTour(buildings, { seed: config.seed });
console.log(`==> tour: ${tour.events.length} events, ${tour.totalDuration.toFixed(2)}s, playlist=[${tour.playlist.join(",")}]`);

const chibi = buildChibiMarkup({ tour });
console.log(`==> chibi markup: ${chibi.length} bytes`);

// ===== 3. Render once per requested theme ===============================

const themesToRender = config.theme === "both" ? ["light", "dark"] : [config.theme];
for (const theme of themesToRender) {
  const { svg: cityShell } = renderCity({
    days,
    weeks: config.weeks,
    theme,
    characterMarkup: "",
  });
  // Splice chibi in just before </svg> (renderer leaves no placeholder
  // marker; we use the closing tag as the splice point).
  const finalSvg = cityShell.replace(
    /<\/svg>\s*$/,
    `\n  ${chibi}\n</svg>\n`
  );

  const outPath = resolve(process.cwd(), themedOutPath(config.out, theme, config.theme));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, finalSvg);
  console.log(`==> wrote ${outPath} (${finalSvg.length} bytes, ${theme})`);
}

// ===== Helpers ==========================================================

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function fmtVB(v) {
  return `[${v.x.toFixed(1)} ${v.y.toFixed(1)} ${v.w.toFixed(1)} ${v.h.toFixed(1)}]`;
}

/**
 * When --theme is 'both', insert `-light` / `-dark` before the file extension.
 * When --theme is 'light' or 'dark', use --out exactly as given.
 *
 *   themedOutPath('assets/metrics.svg', 'light', 'both') -> 'assets/metrics-light.svg'
 *   themedOutPath('assets/metrics.svg', 'dark',  'dark') -> 'assets/metrics.svg'
 */
function themedOutPath(outArg, theme, themeMode) {
  if (themeMode !== "both") return outArg;
  const dot = outArg.lastIndexOf(".");
  if (dot < 0) return `${outArg}-${theme}`;
  return `${outArg.slice(0, dot)}-${theme}${outArg.slice(dot)}`;
}

/**
 * Generate a plausible-looking 26×7 contribution grid without hitting the
 * GraphQL API. Used by `--fixture` (local dev, smoke tests). Bias is
 * weekday-heavy with occasional L4 bursts.
 */
function synthesizeFixture(weeks, seed) {
  const rng = mulberry32(seed);
  const days = [];
  const today = new Date();
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - (weeks * 7 - 1 - i));
    const date = d.toISOString().slice(0, 10);
    const gx = Math.floor(i / 7);
    const gy = i % 7;
    const weekdayBias = (gy === 0 || gy === 6) ? 0.35 : 0.85;
    const r = rng();
    let level = 0;
    if (r < weekdayBias * 0.15) level = 4;
    else if (r < weekdayBias * 0.4) level = 3;
    else if (r < weekdayBias * 0.65) level = 2;
    else if (r < weekdayBias * 0.85) level = 1;
    days.push({ date, count: level * 2, level, gx, gy });
  }
  return days;
}
