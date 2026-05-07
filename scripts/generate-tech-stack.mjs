#!/usr/bin/env node
/**
 * generate-tech-stack.mjs
 *
 * Renders the tech stack icon grid for @ReebalSami's profile README:
 * 18 brand-coloured logos in a 9×2 grid, light + dark variants.
 *
 * Reads vendored SVG icons from assets/icons/skill-icons/ (sourced from the
 * MIT-licensed `tandpfun/skill-icons` project; see
 * assets/icons/skill-icons/LICENSE.md).
 *
 * Output: assets/tech-stack-light.svg + assets/tech-stack-dark.svg
 *
 * Run:
 *   node scripts/generate-tech-stack.mjs
 *
 * No env vars or network access required — pure local SVG composition.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { escapeXml } from "./lib/palette.mjs";

// ----- paths --------------------------------------------------------------

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const ICONS_DIR = resolve(ROOT, "assets/icons/skill-icons");
const ASSETS_DIR = resolve(ROOT, "assets");
mkdirSync(ASSETS_DIR, { recursive: true });

// ----- icon roster --------------------------------------------------------

/**
 * Each entry: slug used in our README's logical naming, plus the canonical
 * skill-icons file root (used to locate <Root>-Light.svg / <Root>-Dark.svg /
 * <Root>.svg in ICONS_DIR).
 *
 * The order is the visible left-to-right, top-to-bottom order of the grid.
 * Row 1: languages + shells.
 * Row 2: web, AI/cloud, infra, data.
 */
const ICONS = [
  // Row 1: languages
  { slug: "python", file: "Python", title: "Python" },
  { slug: "typescript", file: "TypeScript", title: "TypeScript" },
  { slug: "java", file: "Java", title: "Java" },
  { slug: "r", file: "R", title: "R" },
  { slug: "sql", file: "MySQL", title: "SQL (MySQL/PostgreSQL)" },
  { slug: "bash", file: "Bash", title: "Bash" },
  { slug: "react", file: "React", title: "React" },
  { slug: "nextjs", file: "NextJS", title: "Next.js" },
  { slug: "fastapi", file: "FastAPI", title: "FastAPI" },
  // Row 2: backend, web, cloud, infra, vcs, db
  { slug: "spring", file: "Spring", title: "Spring" },
  { slug: "tailwind", file: "TailwindCSS", title: "Tailwind CSS" },
  { slug: "nodejs", file: "NodeJS", title: "Node.js" },
  { slug: "aws", file: "AWS", title: "AWS" },
  { slug: "docker", file: "Docker", title: "Docker" },
  { slug: "git", file: "Git", title: "Git" },
  { slug: "github", file: "Github", title: "GitHub" },
  { slug: "postgres", file: "PostgreSQL", title: "PostgreSQL" },
  { slug: "mongodb", file: "MongoDB", title: "MongoDB" },
];

// ----- layout constants ---------------------------------------------------

const COLS = 9;
const ROWS = 2;
const ICON_PX = 48; // visible icon size
const ICON_NATIVE = 256; // skill-icons source size
const ICON_SCALE = ICON_PX / ICON_NATIVE; // 0.1875
const GAP_X = 8;
const GAP_Y = 8;
const PAD = 16;

const WIDTH = COLS * ICON_PX + (COLS - 1) * GAP_X + PAD * 2;
const HEIGHT = ROWS * ICON_PX + (ROWS - 1) * GAP_Y + PAD * 2;

// ----- helpers ------------------------------------------------------------

/**
 * Pick the appropriate vendored variant for the given theme.
 * Preference: <Root>-Light.svg / <Root>-Dark.svg, fall back to <Root>.svg.
 */
function loadIconVariant(file, theme) {
  const themed = resolve(ICONS_DIR, `${file}-${theme === "dark" ? "Dark" : "Light"}.svg`);
  const plain = resolve(ICONS_DIR, `${file}.svg`);
  if (existsSync(themed)) return readFileSync(themed, "utf8");
  if (existsSync(plain)) return readFileSync(plain, "utf8");
  throw new Error(`No icon found for "${file}" (looked for ${themed} and ${plain}).`);
}

/**
 * Strip the outer <svg ...> wrapper and return only the inner markup.
 * skill-icons SVGs use a single root <svg>, so this is a tight regex.
 */
function unwrapSvgInner(svgText) {
  const match = svgText.match(/<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/);
  if (!match) throw new Error("Could not unwrap <svg>…</svg> from icon SVG.");
  return match[1];
}

/**
 * Namespace every `id="X"`, `url(#X)`, and `xlink:href="#X"` reference inside
 * the inner SVG content with the given prefix, to avoid ID collisions when
 * embedding many icons into a single output SVG.
 */
function namespaceIds(inner, prefix) {
  return inner
    .replace(/(\bid=")([^"]+)(")/g, (_, a, id, c) => `${a}${prefix}_${id}${c}`)
    .replace(/(url\(#)([^)]+)(\))/g, (_, a, id, c) => `${a}${prefix}_${id}${c}`)
    .replace(/(xlink:href="#)([^"]+)(")/g, (_, a, id, c) => `${a}${prefix}_${id}${c}`);
}

/**
 * Position calculation for the i-th icon in the grid (0-indexed).
 */
function positionFor(i) {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const x = PAD + col * (ICON_PX + GAP_X);
  const y = PAD + row * (ICON_PX + GAP_Y);
  return { x, y };
}

// ----- main render --------------------------------------------------------

function renderTechStack(theme) {
  const tiles = ICONS.map((icon, i) => {
    const raw = loadIconVariant(icon.file, theme);
    const inner = unwrapSvgInner(raw);
    const namespaced = namespaceIds(inner, icon.slug);
    const { x, y } = positionFor(i);
    return `  <g transform="translate(${x}, ${y}) scale(${ICON_SCALE})">
    <title>${escapeXml(icon.title)}</title>
${namespaced}
  </g>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img" aria-label="Tech stack: ${ICONS.map((i) => i.title).join(", ")}">
${tiles.join("\n")}
</svg>
`;
}

// ----- main ---------------------------------------------------------------

function main() {
  for (const theme of ["light", "dark"]) {
    const svg = renderTechStack(theme);
    const out = resolve(ASSETS_DIR, `tech-stack-${theme}.svg`);
    writeFileSync(out, svg);
    console.log(`Wrote ${out} (${svg.length} bytes, ${ICONS.length} icons)`);
  }
}

main();
