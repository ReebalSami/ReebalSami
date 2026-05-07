/**
 * palette.mjs
 *
 * Single source of truth for every color in the calendar SVG.
 *
 *   LEVEL_COLOR.{light|dark}.top[level]    → top face (pure GitHub palette)
 *   LEVEL_COLOR.{light|dark}.sideL[level]  → south-west face (mid shade)
 *   LEVEL_COLOR.{light|dark}.sideR[level]  → south-east face (darkest shade)
 *
 * The TOP shades match GitHub's contribution graph EXACTLY. Side shades are
 * derived by darkening the top by ~22% / ~38% to give the iso-cube its 3D
 * read while staying in the same color family.
 *
 *   BRAND.{light|dark}    → portfolio gold accent (used on web strand
 *                            tint and chrome — never on cubes)
 *
 *   CHARACTER_CSS_VARS    → CSS custom properties consumed by the chibi
 *
 * The renderer emits two CSS blocks: light defaults at :root, dark
 * overrides inside @media (prefers-color-scheme: dark). One SVG, both
 * themes — no <picture> tag in the README.
 */

// ===== GitHub-native contribution palette ================================
//
// Values extracted directly from `td.ContributionCalendar-day` on
// github.com/<user> in both light and default-dark themes (current Primer
// release). Update these only by re-inspecting github.com — Primer values
// drift over time and we want pixel-exact match against the live graph.
//
// Side-face shades are precomputed at 78% (sideL) and 62% (sideR) of each
// top color so the renderer emits them as plain CSS class fills (no
// per-cube inline filters). The 78/62 multipliers preserve the iso 3D
// read across the redesigned palette.

export const LEVEL_COLOR = {
  light: {
    top:   ["#eff2f5", "#aceebb", "#4ac26b", "#2da44e", "#116329"],
    sideL: ["#babdbf", "#86ba92", "#3a9753", "#23803d", "#0d4d20"], // ~22% darker
    sideR: ["#949698", "#6b9474", "#2e7842", "#1c6630", "#0b3d19"], // ~38% darker
  },
  dark: {
    top:   ["#151b23", "#033a16", "#196c2e", "#2ea043", "#56d364"],
    sideL: ["#10151b", "#022d11", "#145424", "#247d34", "#43a54e"], // ~22% darker
    sideR: ["#0d1116", "#02240e", "#10431d", "#1d632a", "#35833e"], // ~38% darker
  },
};

// ===== Brand (portfolio gold) ============================================

export const BRAND = {
  light: {
    fg: "#22222A",
    accent: "#B6803F",
    border: "rgba(34,34,42,0.08)",
    mutedText: "#7C7C82",
  },
  dark: {
    fg: "#F5F4EE",
    accent: "#D4A574",
    border: "rgba(245,244,238,0.10)",
    mutedText: "#A4A4AC",
  },
};

// ===== Character (chibi web-slinger) =====================================
//
// (No PAGE_BG export: the SVG renders with no painted background so it
// inherits whatever GitHub theme the viewer is using — default-dark,
// dark-dimmed, high-contrast, light, light-high-contrast all just work.)

export const CHARACTER_CSS_VARS = {
  light: {
    "--ws-red": "#B82626",
    "--ws-blue": "#1E2D5C",
    "--ws-eye": "#FAF9F4",
    "--ws-stroke": "#22222A",
    "--ws-web": "rgba(34,34,42,0.78)",
    "--ws-accent": BRAND.light.accent,
  },
  dark: {
    "--ws-red": "#C32A2A",
    "--ws-blue": "#3A4F8C",
    "--ws-eye": "#F5F4EE",
    "--ws-stroke": "#0d1117",
    "--ws-web": "rgba(245,244,238,0.78)",
    "--ws-accent": BRAND.dark.accent,
  },
};

// ===== Card palette (for non-calendar SVGs: numbers, hero, tech-stack) ====
//
// Used by scripts/generate-github-numbers.mjs, scripts/generate-hero.mjs,
// scripts/generate-tech-stack.mjs. Mirrors the inline PALETTE shape used by
// scripts/generate-milestones.mjs so future refactors can fold them together.

export const CARD_PALETTE = {
  light: {
    bg: "transparent",
    fg: "#22222A",
    muted: "#7C7C82",
    accent: "#B6803F",
    accentSoft: "#B6803F",
    accentSoftAlpha: 0.08,
    border: "#22222A",
    borderAlpha: 0.12,
    barTrack: "#22222A",
    barTrackAlpha: 0.08,
  },
  dark: {
    bg: "transparent",
    fg: "#F5F4EE",
    muted: "#A4A4AC",
    accent: "#D4A574",
    accentSoft: "#D4A574",
    accentSoftAlpha: 0.12,
    border: "#F5F4EE",
    borderAlpha: 0.12,
    barTrack: "#F5F4EE",
    barTrackAlpha: 0.10,
  },
};

// ===== Typography (shared CSS class definitions) ==========================
//
// Inlined into each SVG's <style> block. Keeping a single source-of-truth
// avoids visual drift between milestones-*, numbers-*, hero-*, tech-stack-*.

export const TYPO = {
  // Small uppercase tracker label, e.g., "MILESTONES", "GITHUB BY THE NUMBERS"
  sectionLabel: `font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; letter-spacing: 0.14em; font-weight: 500;`,

  // Row / card heading (e.g., "Total commits")
  rowLabel: `font-family: "Space Grotesk", ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif; font-size: 13px; font-weight: 500; letter-spacing: -0.005em;`,

  // Big numeric value (uses tabular-nums for column alignment)
  rowValue: `font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 28px; font-weight: 600; font-variant-numeric: tabular-nums;`,

  // Mid-size numeric value (used in streak, langs)
  midValue: `font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums;`,

  // Tiny numeric value (percentages, dates)
  smallValue: `font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; letter-spacing: 0.04em; font-variant-numeric: tabular-nums;`,

  // Body / descriptive text
  rowDesc: `font-family: "DM Sans", "Inter", ui-sans-serif, system-ui, -apple-system, sans-serif; font-size: 12px; font-weight: 400;`,

  // Hero typing line
  heroLine: `font-family: "Space Grotesk", ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif; font-size: 30px; font-weight: 600; letter-spacing: -0.01em;`,
};

// ===== Shared SVG helpers =================================================

/**
 * Escape a string for safe inclusion in SVG text content / attribute values.
 */
export function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ===== Helpers ===========================================================

export function renderCssVars(vars, indent = "  ") {
  return Object.entries(vars)
    .map(([k, v]) => `${indent}${k}: ${v};`)
    .join("\n");
}
