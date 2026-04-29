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

// ===== Helpers ===========================================================

export function renderCssVars(vars, indent = "  ") {
  return Object.entries(vars)
    .map(([k, v]) => `${indent}${k}: ${v};`)
    .join("\n");
}
