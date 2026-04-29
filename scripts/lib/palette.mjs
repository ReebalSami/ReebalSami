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
// Source: https://docs.github.com/en/account-and-profile/setting-up-and-managing-your-github-profile/managing-contribution-settings-on-your-profile/showing-an-overview-of-your-activity-on-your-profile
// Light: ebedf0 / 9be9a8 / 40c463 / 30a14e / 216e39
// Dark:  161b22 / 0e4429 / 006d32 / 26a641 / 39d353
//
// We pre-compute side-face shades so the renderer can emit them as plain
// CSS class fills (no per-cube inline filters).

export const LEVEL_COLOR = {
  light: {
    top:   ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
    sideL: ["#c9cdd3", "#7ab689", "#329e4f", "#247c3d", "#1a5630"], // ~22% darker
    sideR: ["#a4a8ae", "#5a8666", "#23783b", "#195e2e", "#124224"], // ~38% darker
  },
  dark: {
    top:   ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"],
    sideL: ["#11151b", "#0a3320", "#005226", "#1c7d31", "#2da342"], // ~22% darker
    sideR: ["#0d1117", "#072518", "#003c1c", "#125c25", "#1f7a31"], // ~38% darker
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

// ===== Page background ===================================================
//
// Used as the SVG's solid backdrop. Light = GitHub's profile-page bg.
// Dark  = GitHub's dark-mode profile bg (matches contribution chart).

export const PAGE_BG = {
  light: "#ffffff",
  dark: "#0d1117",
};

// ===== Character (chibi web-slinger) =====================================

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
