#!/usr/bin/env node
/**
 * generate-github-numbers.mjs
 *
 * Renders the "GitHub by the numbers" cards for @ReebalSami's profile
 * README, replacing the previous third-party services
 * (github-readme-stats.vercel.app + streak-stats.demolab.com):
 *
 *   numbers-stats-streak-{light,dark}.svg   Combined VOLUME + CADENCE
 *                                           card (960×180). Single SVG so
 *                                           the two halves are guaranteed
 *                                           side-by-side regardless of
 *                                           GitHub's README column width.
 *   numbers-langs-{light,dark}.svg          Top languages by recent commits
 *                                           (960×180, full-width).
 *
 * Story arc: VOLUME = career totals · CADENCE = streak rhythm · LANGS = range.
 *
 * Motion design: the CADENCE column for "Current streak" includes the
 * iconic ring + flame emblem (re-implemented in-house from the original
 * streak-stats.demolab.com look). All entrance animations follow Emil
 * Kowalski's design-engineering principles + Impeccable's motion-design
 * rules: stagger ≤ 80ms, custom expo-out / quart-out keySplines (no
 * built-in `ease`, no bounce / elastic), one-shot entrance choreographed
 * over ~950ms with bounded loops only on state indicators (flame flicker,
 * ring breathe).
 *
 * Run:
 *   GITHUB_TOKEN=ghp_… node scripts/generate-github-numbers.mjs
 *
 * Env:
 *   GITHUB_TOKEN  required, PAT with `read:user` scope so we see private
 *                 contribution counts (matching today's count_private=true)
 *   USERNAME      optional, defaults to "ReebalSami"
 */

import { graphql } from "@octokit/graphql";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CARD_PALETTE, TYPO, EASE, ANIM, escapeXml } from "./lib/palette.mjs";

// ----- config -------------------------------------------------------------

const USERNAME = process.env.USERNAME || "ReebalSami";
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error("Missing GITHUB_TOKEN env var.");
  process.exit(1);
}

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const ASSETS_DIR = resolve(ROOT, "assets");
mkdirSync(ASSETS_DIR, { recursive: true });

const gql = graphql.defaults({
  headers: { authorization: `token ${TOKEN}` },
});

// Languages we hide on the right card (artefacts that skew real-stack signal).
const HIDDEN_LANGS = new Set(["Procfile", "Smarty", "HTML", "CSS", "Roff", "TeX"]);

// ----- GraphQL data fetch -------------------------------------------------

// Languages-by-recent-commits window. 24 months captures the user's ML/AI
// pivot trajectory (recent enough to be relevant, broad enough to show range).
const LANGS_WINDOW_YEARS = 2;
const LANGS_WINDOW_LABEL = "TOP LANGUAGES · LAST 2 YEARS";

/**
 * Fetch user identity + repos with stargazer counts, primary language, and
 * recent commit counts within the languages-window above.
 */
async function fetchUserAndRepos(login) {
  const recentSince = new Date();
  recentSince.setFullYear(recentSince.getFullYear() - LANGS_WINDOW_YEARS);

  const data = await gql(
    `
    query ($login: String!, $since: GitTimestamp!) {
      user(login: $login) {
        login
        createdAt
        repositories(
          first: 100
          ownerAffiliations: OWNER
          isFork: false
          orderBy: { field: PUSHED_AT, direction: DESC }
        ) {
          totalCount
          nodes {
            name
            stargazerCount
            primaryLanguage { name }
            defaultBranchRef {
              target {
                ... on Commit {
                  history(since: $since) { totalCount }
                }
              }
            }
          }
        }
      }
    }
    `,
    { login, since: recentSince.toISOString() }
  );

  return data.user;
}

/**
 * Fetch contributions year-by-year (GitHub limits contributionsCollection to
 * a 1-year range per query) from createdAt to now. Sums totalCommit and
 * totalPullRequest contributions, and accumulates the per-day calendar for
 * streak computation.
 */
async function fetchLifetimeContributions(login, createdAt) {
  const start = new Date(createdAt);
  const now = new Date();

  let totalCommits = 0;
  let totalPRs = 0;
  const dayMap = new Map(); // date -> max contributionCount seen

  let cursor = new Date(start);
  let chunkIdx = 0;
  while (cursor < now) {
    chunkIdx += 1;
    const from = new Date(cursor);
    const to = new Date(cursor);
    to.setFullYear(to.getFullYear() + 1);
    if (to > now) to.setTime(now.getTime());

    const res = await gql(
      `
      query ($login: String!, $from: DateTime!, $to: DateTime!) {
        user(login: $login) {
          contributionsCollection(from: $from, to: $to) {
            totalCommitContributions
            totalPullRequestContributions
            contributionCalendar {
              weeks {
                contributionDays { date contributionCount }
              }
            }
          }
        }
      }
      `,
      { login, from: from.toISOString(), to: to.toISOString() }
    );

    const cc = res.user.contributionsCollection;
    totalCommits += cc.totalCommitContributions;
    totalPRs += cc.totalPullRequestContributions;

    for (const w of cc.contributionCalendar.weeks) {
      for (const d of w.contributionDays) {
        const prev = dayMap.get(d.date) ?? -1;
        if (d.contributionCount > prev) dayMap.set(d.date, d.contributionCount);
      }
    }

    process.stdout.write(`  chunk ${chunkIdx}: ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)} (commits=${cc.totalCommitContributions} prs=${cc.totalPullRequestContributions})\n`);

    cursor = new Date(to.getTime() + 1);
  }

  // Sort days ascending by date.
  const days = [...dayMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, contributionCount]) => ({ date, contributionCount }));

  return { totalCommits, totalPRs, days };
}

// ----- Streak math --------------------------------------------------------

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function isoYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Walk the day-by-day calendar to compute totalContribs, firstContribDate,
 * current streak (ending today or yesterday), and longest streak.
 */
function computeStreaks(days) {
  let totalContribs = 0;
  let firstContribDate = null;

  let longest = 0;
  let longestStart = null;
  let longestEnd = null;

  let runLen = 0;
  let runStart = null;

  for (const d of days) {
    totalContribs += d.contributionCount;
    if (d.contributionCount > 0) {
      if (firstContribDate === null) firstContribDate = d.date;
      if (runLen === 0) runStart = d.date;
      runLen += 1;
      if (runLen > longest) {
        longest = runLen;
        longestStart = runStart;
        longestEnd = d.date;
      }
    } else {
      runLen = 0;
      runStart = null;
    }
  }

  // Current streak: trailing run of consecutive >0 days.
  // GitHub UX convention: a streak is alive while today OR yesterday has a
  // contribution (gives the user breathing room within the same calendar day
  // across timezones).
  const today = isoToday();
  const yest = isoYesterday();

  let curr = 0;
  let currStart = null;
  let currEnd = null;

  // Walk from the end backwards.
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i];
    if (d.date > today) continue; // future day (shouldn't happen but be safe)
    if (curr === 0) {
      // Decide whether the trailing run is "active" by anchoring at today or yesterday.
      if (d.date === today || d.date === yest) {
        if (d.contributionCount > 0) {
          curr = 1;
          currStart = d.date;
          currEnd = d.date;
        } else {
          // The anchor day has 0; check the day before
          continue;
        }
      } else {
        // We've fallen off the today/yesterday window without finding any contribution.
        break;
      }
    } else {
      if (d.contributionCount > 0) {
        curr += 1;
        currStart = d.date;
      } else {
        break;
      }
    }
  }

  return {
    totalContribs,
    firstContribDate,
    currentStreak: curr,
    currentStart: currStart,
    currentEnd: currEnd,
    longestStreak: longest,
    longestStart,
    longestEnd,
  };
}

// ----- Languages ----------------------------------------------------------

function computeTopLangs(repos, topN = 8) {
  const totals = new Map(); // lang -> commits in last 12mo

  for (const r of repos) {
    const lang = r.primaryLanguage?.name;
    if (!lang) continue;
    if (HIDDEN_LANGS.has(lang)) continue;
    const recentCommits = r.defaultBranchRef?.target?.history?.totalCount ?? 0;
    if (recentCommits === 0) continue;
    totals.set(lang, (totals.get(lang) ?? 0) + recentCommits);
  }

  const sorted = [...totals.entries()].sort(([, a], [, b]) => b - a);
  const top = sorted.slice(0, topN);
  const grandTotal = top.reduce((s, [, n]) => s + n, 0) || 1;

  return top.map(([name, commits]) => ({
    name,
    commits,
    pct: commits / grandTotal,
  }));
}

// ----- Date formatting ----------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatYMD(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function formatYMDShort(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

function formatRange(fromIso, toIso) {
  if (!fromIso || !toIso) return "";
  if (fromIso === toIso) return formatYMD(fromIso);
  const [fy, fm, fd] = fromIso.split("-").map(Number);
  const [ty, tm, td] = toIso.split("-").map(Number);
  if (fy === ty && fm === tm) return `${fd}–${td} ${MONTHS[fm - 1]} ${fy}`;
  if (fy === ty) return `${fd} ${MONTHS[fm - 1]} – ${td} ${MONTHS[tm - 1]} ${fy}`;
  return `${formatYMD(fromIso)} – ${formatYMD(toIso)}`;
}

// ----- SVG building blocks ------------------------------------------------

// Combined card geometry. 960 wide guarantees VOLUME + CADENCE always sit
// side-by-side regardless of GitHub's README column width — the browser
// scales a single image proportionally, so the two halves never wrap.
const CARD_W = 960;
const CARD_H = 180;

// Internal layout for the combined VOLUME + CADENCE card.
const VOL_X0 = 24;
const VOL_X1 = 460;          // VOLUME right edge
const GUTTER_DIV_X = 480;    // shared vertical divider between the two halves
const CAD_X0 = 500;
const CAD_X1 = CARD_W - 24;

function svgWrap({ width, height, ariaLabel, body }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeXml(ariaLabel)}">
  <defs>
    <style>
      .section-label { ${TYPO.sectionLabel} }
      .row-label     { ${TYPO.rowLabel} }
      .row-value     { ${TYPO.rowValue} }
      .mid-value     { ${TYPO.midValue} }
      .small-value   { ${TYPO.smallValue} }
      .row-desc      { ${TYPO.rowDesc} }
    </style>
  </defs>
${body}
</svg>
`;
}

function sectionTitle(p, x, y, label, delay, accentBarLen = 60) {
  // Title fades in (200ms quartOut, slight delay), then the accent bar draws
  // its width 0→accentBarLen with a snappier expoOut (Emil's favorite).
  return `  <g opacity="0">
    <animate attributeName="opacity" begin="${delay}s" dur="${ANIM.fast}" from="0" to="1" fill="freeze" calcMode="spline" keySplines="${EASE.quartOut}"/>
    <text x="${x}" y="${y}" class="section-label" fill="${p.muted}">${escapeXml(label)}</text>
  </g>
  <rect x="${x}" y="${y + 8}" width="0" height="1" fill="${p.accent}" fill-opacity="0.55">
    <animate attributeName="width" begin="${delay + 0.08}s" dur="${ANIM.base}" from="0" to="${accentBarLen}" fill="freeze" calcMode="spline" keySplines="${EASE.expoOut}"/>
  </rect>`;
}

// ----- Motion helpers (Emil + Impeccable principles, SMIL-compatible) ----

/**
 * Wrap arbitrary SVG content in a `<g>` whose opacity fades 0→1 and which
 * optionally rises (translateY dy→0) on entrance. One-shot.
 *
 * Per Impeccable's 100/300/500 rule, default duration is 350ms; per Emil's
 * decision tree, the default easing is expo-out (snappy, confident).
 */
function entrance(content, { delay = 0, dy = 0, dur = ANIM.base, ease = EASE.expoOut } = {}) {
  const initialTransform = dy ? `translate(0, ${dy})` : null;
  const transformAnim = dy
    ? `\n    <animateTransform attributeName="transform" type="translate" begin="${delay}s" dur="${dur}" from="0 ${dy}" to="0 0" fill="freeze" calcMode="spline" keySplines="${ease}"/>`
    : "";
  const tAttr = initialTransform ? ` transform="${initialTransform}"` : "";
  return `<g opacity="0"${tAttr}>
    <animate attributeName="opacity" begin="${delay}s" dur="${dur}" from="0" to="1" fill="freeze" calcMode="spline" keySplines="${ease}"/>${transformAnim}
    ${content}
  </g>`;
}

/**
 * Render a horizontal bar (langs row) whose width grows 0→targetW on
 * entrance. Two `<rect>` elements: track behind, fill on top — only the
 * fill animates. Track fades in via parent group, fill draws via width
 * animation. Per Impeccable: animating `width` is acceptable here because
 * the bar is a visual primitive, not a layout-driving element.
 */
function barWithDrawAnim({ x, y, h, trackW, fillW, p, delay, dur = ANIM.slow }) {
  return `<rect x="${x}" y="${y}" width="${trackW}" height="${h}" fill="${p.barTrack}" fill-opacity="${p.barTrackAlpha}" rx="${h / 2}"/>
    <rect x="${x}" y="${y}" width="0" height="${h}" fill="${p.accent}" rx="${h / 2}">
      <animate attributeName="width" begin="${delay}s" dur="${dur}" from="0" to="${fillW}" fill="freeze" calcMode="spline" keySplines="${EASE.expoOut}"/>
    </rect>`;
}

/**
 * Data-bearing ring around the current-streak number. Two concentric
 * circles:
 *
 *   1. BG ring   — full 360°, muted + low opacity. Acts as the "track"
 *                  that anchors the arc visually even when progress=0.
 *   2. PROGRESS  — a second circle stroked with the accent color, using
 *      ARC           `stroke-dasharray` of the full circumference and a
 *                    `stroke-dashoffset` that animates from `circ` (fully
 *                    hidden) to `circ - fillLen` (arc revealed from 12
 *                    o'clock clockwise). `rotate(-90)` puts the start at
 *                    the top. `stroke-linecap="round"` gives a refined
 *                    finish for the terminus of partial arcs.
 *
 * `progress` is `currentStreak / longestStreak`, clamped to [0, 1]. A
 * streak that ties or beats the personal best paints the full 360° (a
 * complete ring) — silent acknowledgment without any extra decoration.
 *
 * After the entrance draw, a subtle stroke-opacity breathe keeps the arc
 * feeling "alive" — same cadence as the previous decorative ring, now
 * grounded in real data rather than pure ornament.
 */
function progressArc({ cx, cy, r, progress, p, delay, dur = ANIM.slow }) {
  const circ = 2 * Math.PI * r;
  const clamped = Math.min(1, Math.max(0, progress));
  const fillLen = circ * clamped;
  const breatheStart = delay + parseFloat(dur);

  // Track / background ring — full circle, low-opacity muted stroke.
  const track = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${p.muted}" stroke-width="2" stroke-opacity="0">
    <animate attributeName="stroke-opacity" begin="${delay}s" dur="${ANIM.reveal}" from="0" to="0.18" fill="freeze" calcMode="spline" keySplines="${EASE.quartOut}"/>
  </circle>`;

  // Progress arc — zero-length dash animates to `fillLen`. rotate(-90)
  // starts the arc at 12 o'clock and sweeps clockwise.
  const arc = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${p.accent}" stroke-width="2.5" stroke-linecap="round" transform="rotate(-90 ${cx} ${cy})" stroke-dasharray="${circ.toFixed(2)}" stroke-dashoffset="${circ.toFixed(2)}" stroke-opacity="0">
    <animate attributeName="stroke-opacity" begin="${delay}s" dur="${ANIM.reveal}" from="0" to="0.9" fill="freeze" calcMode="spline" keySplines="${EASE.quartOut}"/>
    <animate attributeName="stroke-dashoffset" begin="${delay + 0.05}s" dur="${dur}" from="${circ.toFixed(2)}" to="${(circ - fillLen).toFixed(2)}" fill="freeze" calcMode="spline" keySplines="${EASE.expoOut}"/>
    <animate attributeName="stroke-opacity" begin="${breatheStart}s" dur="${ANIM.ringLoop}" values="0.9;0.75;1;0.9" repeatCount="indefinite" calcMode="linear"/>
  </circle>`;

  return `${track}\n  ${arc}`;
}

/**
 * Small flame glyph anchored to the top-right of the current-streak ring.
 * Entrance: opacity 0→1 + scale 0→`baseScale` (snappy expoOut). Loop:
 * subtle scale oscillation + opacity flicker — both within ranges
 * imperceptible enough to read as "alive" without becoming noise.
 *
 * `baseScale` is data-bearing: scales from 0.55 (cold — no streak) to
 * 1.0 (matching personal best). Ties the flame's visual weight to the
 * same progress ratio as the arc, so both elements reinforce the same
 * story. The path is a 14×18 teardrop centered at (0, 0).
 */
function flameWithFlicker({ x, y, p, delay, progress = 1 }) {
  const clamped = Math.min(1, Math.max(0, progress));
  const baseScale = 0.55 + clamped * 0.45; // 0.55 when cold, 1.0 at PB
  const peakScale = (baseScale * 1.08).toFixed(3);
  const dipScale = (baseScale * 0.94).toFixed(3);
  const lowScale = (baseScale * 1.04).toFixed(3);
  const flickerStart = delay + parseFloat(ANIM.flame);
  const FLAME_PATH = "M 0 -9 C 3 -5 5 -1 4 3 C 3 7 1 8 0 9 C -1 8 -3 7 -4 3 C -5 -1 -3 -5 0 -9 Z";
  return `<g transform="translate(${x}, ${y})">
    <g opacity="0">
      <animate attributeName="opacity" begin="${delay}s" dur="${ANIM.flame}" from="0" to="1" fill="freeze" calcMode="spline" keySplines="${EASE.expoOut}"/>
      <animate attributeName="opacity" begin="${flickerStart}s" dur="${ANIM.flameLoop}" values="1;0.85;1;0.92;1" repeatCount="indefinite" calcMode="linear"/>
      <path d="${FLAME_PATH}" fill="${p.accent}" transform="scale(0)">
        <animateTransform attributeName="transform" type="scale" begin="${delay}s" dur="${ANIM.flame}" from="0" to="${baseScale.toFixed(3)}" fill="freeze" calcMode="spline" keySplines="${EASE.expoOut}"/>
        <animateTransform attributeName="transform" type="scale" begin="${flickerStart}s" dur="${ANIM.flameLoop}" values="${baseScale.toFixed(3)};${peakScale};${dipScale};${lowScale};${baseScale.toFixed(3)}" repeatCount="indefinite" calcMode="linear"/>
      </path>
    </g>
  </g>`;
}

/**
 * Count-up text: renders a sequence of visibility-keyed frames so the
 * number appears to tick 0 → target over `dur` seconds. Each intermediate
 * value hard-cuts to the next — SMIL doesn't support text-content
 * tweening, but the rapid frame succession (40–80 ms per frame) reads as
 * a smooth counter.
 *
 * For target < 10 (degenerate: 0, 1, a couple digits) the count-up reads
 * as jitter, so we fall back to a single fade-in of the final value.
 *
 * `format` is an optional callback that transforms each integer frame
 * to its display string (e.g., `n => n.toLocaleString()` for thousands
 * separators). Defaults to a plain numeric string.
 */
function countUpText({
  x, y, textAnchor = "middle", className, fill,
  target, delay, dur = 0.6, steps = 10, format = String,
}) {
  const n = Math.max(0, Math.floor(Number(target)));

  // Short / degenerate values — just fade in the final number. A 1-frame
  // "count-up" from nothing to 1 is not count-up; it's a fade.
  if (!Number.isFinite(n) || n < 10) {
    return entrance(
      `<text x="${x}" y="${y}" text-anchor="${textAnchor}" class="${className}" fill="${fill}">${escapeXml(format(n))}</text>`,
      { delay, dy: 6 }
    );
  }

  const frameCount = Math.min(steps, n);
  const stepDur = dur / frameCount;

  // Generate evenly-spaced integer snapshots from 1..n. We intentionally
  // skip frame "0" — starting at the first non-zero value avoids a
  // visible "0" flash before the count-up begins.
  const frames = [];
  for (let i = 1; i <= frameCount; i += 1) {
    const val = Math.round((i / frameCount) * n);
    const start = delay + (i - 1) * stepDur;
    const end = delay + i * stepDur;
    frames.push({ val, start, end });
  }

  const frameEls = frames.map((f, i) => {
    const isLast = i === frames.length - 1;
    // The last frame stays visible (no end) and also fades its opacity
    // in for an elegant settle. Prior frames hard-cut off at their end.
    const visibilitySet = isLast
      ? `    <set attributeName="visibility" to="visible" begin="${f.start.toFixed(3)}s"/>`
      : `    <set attributeName="visibility" to="visible" begin="${f.start.toFixed(3)}s" end="${f.end.toFixed(3)}s"/>`;
    return `  <text x="${x}" y="${y}" text-anchor="${textAnchor}" class="${className}" fill="${fill}" visibility="hidden">${escapeXml(format(f.val))}
${visibilitySet}
  </text>`;
  }).join("\n");

  return `<g>\n${frameEls}\n</g>`;
}

// ----- Combined card: VOLUME + CADENCE (one 960×180 SVG) ------------------

function renderCombinedCard({
  theme,
  totalCommits, totalPRs, totalStars, totalRepos,
  totalContribs, currentStreak, currentEnd,
  longestStreak, longestStart, longestEnd,
  firstContribDate,
}) {
  const p = CARD_PALETTE[theme];

  // === VOLUME half =======================================================

  const VOL_PAD_TOP = 28;
  const VOL_TOP_Y = VOL_PAD_TOP + 12;
  const VOL_BOT_Y = CARD_H - 12;
  const VOL_ZONE_H = VOL_BOT_Y - VOL_TOP_Y;
  const VOL_CELL_H = 60;
  const VOL_GUTTER = (VOL_ZONE_H - VOL_CELL_H * 2) / 3;
  const VOL_ROW_Y = [
    VOL_TOP_Y + VOL_GUTTER,
    VOL_TOP_Y + VOL_GUTTER * 2 + VOL_CELL_H,
  ];
  const VOL_COL_X = [VOL_X0, VOL_X0 + (VOL_X1 - VOL_X0) / 2 + 8];

  // Stagger numbers: each cell enters with a 60ms delay after the previous.
  // Per Impeccable: cap total stagger ≤ 500ms (4 cells × 60ms = 240ms — well under).
  const volBase = 0.12; // delay after section title settles
  const volCell = (col, row, value, label, idx) => {
    const x = VOL_COL_X[col];
    const y = VOL_ROW_Y[row];
    const numDelay = volBase + idx * 0.06;
    const labelDelay = numDelay + 0.1;
    return `${entrance(
      `<text x="${x}" y="${y + 26}" class="row-value" fill="${p.fg}">${escapeXml(value)}</text>`,
      { delay: numDelay, dy: 6 }
    )}
    ${entrance(
      `<text x="${x}" y="${y + 48}" class="row-label" fill="${p.muted}">${escapeXml(label)}</text>`,
      { delay: labelDelay, dur: ANIM.fast, ease: EASE.quartOut }
    )}`;
  };

  const volumeBody = `${sectionTitle(p, VOL_X0, VOL_PAD_TOP - 14, "VOLUME", 0)}
  ${volCell(0, 0, totalCommits.toLocaleString(), "Total commits", 0)}
  ${volCell(1, 0, totalPRs.toLocaleString(), "Total PRs", 1)}
  ${volCell(0, 1, totalStars.toLocaleString(), "Stars received", 2)}
  ${volCell(1, 1, totalRepos.toLocaleString(), "Repositories", 3)}`;

  // === Center divider between halves ====================================

  const divider = `<line x1="${GUTTER_DIV_X}" y1="24" x2="${GUTTER_DIV_X}" y2="${CARD_H - 24}" stroke="${p.border}" stroke-opacity="${p.borderAlpha}" stroke-width="1" opacity="0">
    <animate attributeName="opacity" begin="0.18s" dur="${ANIM.base}" from="0" to="1" fill="freeze" calcMode="spline" keySplines="${EASE.quartOut}"/>
  </line>`;

  // === CADENCE half =====================================================

  const CAD_PAD_TOP = 28;
  const CAD_INNER_W = CAD_X1 - CAD_X0;
  const CAD_COL_W = CAD_INNER_W / 3;
  const CAD_COL_X = [
    CAD_X0 + CAD_COL_W * 0.5,
    CAD_X0 + CAD_COL_W * 1.5,
    CAD_X0 + CAD_COL_W * 2.5,
  ];
  const CAD_VAL_Y = CAD_PAD_TOP + 50;
  // Pushed 8px further down from the previous 22/18 so the shrunken ring
  // (r=24) has ~9px clearance above the label's ascender, instead of the
  // old r=34 that clipped straight through the label baseline.
  const CAD_LABEL_Y = CAD_VAL_Y + 30;
  const CAD_DATE_Y = CAD_LABEL_Y + 18;
  const CAD_DIV_Y_TOP = CAD_PAD_TOP + 12;
  const CAD_DIV_Y_BOT = CARD_H - 16;
  const CAD_DIV_X_1 = CAD_X0 + CAD_COL_W;
  const CAD_DIV_X_2 = CAD_X0 + CAD_COL_W * 2;

  // Compressed date format ("Since 30 Oct 2022" — 17 chars) keeps the
  // sub-line clear of the column divider. The original "30 Oct 2022 –
  // Present" overflowed into the divider on column 1.
  const sinceLabel = firstContribDate
    ? `Since ${formatYMDShort(firstContribDate)} ${firstContribDate.slice(0, 4)}`
    : "";
  const currentLabel = currentEnd ? formatYMDShort(currentEnd) : "—";
  const longestLabel = formatRange(longestStart, longestEnd);

  const cadBase = 0.30; // CADENCE half enters slightly after VOLUME settles

  // Data-bearing ring geometry: the arc's sweep = current/longest. A
  // fresh streak (like current=1, longest=9) paints ~40°; tying/beating
  // the personal best paints the full circle. `dur` is longer than the
  // other tweens so the eye can track the arc drawing around the digit.
  const streakProgress = longestStreak > 0
    ? Math.min(1, currentStreak / longestStreak)
    : 0;
  const RING_R = 24;
  const RING_CY = CAD_VAL_Y - 14; // centered on the cap height of the digit
  const FLAME_OFFSET_X = 18;      // top-right of ring, tighter after shrink
  const FLAME_OFFSET_Y = -16;
  const ringDelay = cadBase + 0.08 + 0.05;
  const flameDelay = ringDelay + 0.20; // after arc has drawn a bit

  const cadCol = (col, rawValue, label, sub, accent = false) => {
    const cx = CAD_COL_X[col];
    const numDelay = cadBase + col * 0.06;
    const labelDelay = numDelay + 0.65; // wait for count-up to finish
    const dateDelay = labelDelay + 0.05;
    return `${countUpText({
      x: cx, y: CAD_VAL_Y, className: "row-value",
      fill: accent ? p.accent : p.fg,
      target: rawValue,
      delay: numDelay,
      format: (n) => n.toLocaleString(),
    })}
    ${entrance(
      `<text x="${cx}" y="${CAD_LABEL_Y}" text-anchor="middle" class="row-label" fill="${p.muted}">${escapeXml(label)}</text>`,
      { delay: labelDelay, dur: ANIM.fast, ease: EASE.quartOut }
    )}
    ${entrance(
      `<text x="${cx}" y="${CAD_DATE_Y}" text-anchor="middle" class="small-value" fill="${p.muted}">${escapeXml(sub)}</text>`,
      { delay: dateDelay, dur: ANIM.fast, ease: EASE.quartOut }
    )}`;
  };

  const cadenceDividers = `<g opacity="0">
    <animate attributeName="opacity" begin="0.2s" dur="${ANIM.base}" from="0" to="1" fill="freeze" calcMode="spline" keySplines="${EASE.quartOut}"/>
    <line x1="${CAD_DIV_X_1}" y1="${CAD_DIV_Y_TOP}" x2="${CAD_DIV_X_1}" y2="${CAD_DIV_Y_BOT}" stroke="${p.border}" stroke-opacity="${p.borderAlpha}" stroke-width="1"/>
    <line x1="${CAD_DIV_X_2}" y1="${CAD_DIV_Y_TOP}" x2="${CAD_DIV_X_2}" y2="${CAD_DIV_Y_BOT}" stroke="${p.border}" stroke-opacity="${p.borderAlpha}" stroke-width="1"/>
  </g>`;

  const cadenceBody = `${sectionTitle(p, CAD_X0, CAD_PAD_TOP - 14, "CADENCE", 0.18)}
  ${cadenceDividers}
  ${progressArc({ cx: CAD_COL_X[1], cy: RING_CY, r: RING_R, progress: streakProgress, p, delay: ringDelay })}
  ${flameWithFlicker({ x: CAD_COL_X[1] + FLAME_OFFSET_X, y: RING_CY + FLAME_OFFSET_Y, p, delay: flameDelay, progress: streakProgress })}
  ${cadCol(0, totalContribs, "Total contributions", sinceLabel)}
  ${cadCol(1, currentStreak, "Current streak", currentLabel, true)}
  ${cadCol(2, longestStreak, "Longest streak", longestLabel)}`;

  const body = `  ${divider}
  ${volumeBody}
  ${cadenceBody}`;

  return svgWrap({
    width: CARD_W,
    height: CARD_H,
    ariaLabel: `Stats for @${USERNAME}: ${totalCommits} commits, ${totalPRs} PRs, ${totalStars} stars, ${totalRepos} repos. Streak: ${totalContribs} contributions, current ${currentStreak} day(s), longest ${longestStreak} day(s) (${Math.round(streakProgress * 100)}% of personal best).`,
    body,
  });
}

// ----- Top languages card (full-width, 960×180) ---------------------------

function renderLangsCard({ theme, langs }) {
  const p = CARD_PALETTE[theme];

  const PAD_X = 24;
  const PAD_TOP = 28;
  const TITLE_Y = PAD_TOP - 14;
  // NAME_W must accommodate the widest expected language name
  // (e.g., "Jupyter Notebook" at 13px Space Grotesk).
  const NAME_W = 156;
  const PCT_W = 56;
  const BAR_X = PAD_X + NAME_W;
  const BAR_W = CARD_W - PAD_X * 2 - NAME_W - PCT_W;
  const BAR_H = 6;

  // Adapt row height to language count: more rows → tighter; fewer rows →
  // more breathing room. Keeps the card from looking sparse with 3 langs or
  // crowded with 8.
  const TOP_ZONE_Y = PAD_TOP + 12;
  const BOT_ZONE_Y = CARD_H - 16;
  const ZONE_H = BOT_ZONE_Y - TOP_ZONE_Y;
  const n = Math.max(1, langs.length);
  const ROW_H = Math.min(28, Math.max(18, Math.floor(ZONE_H / Math.max(n, 4))));
  const blockH = ROW_H * n;
  const FIRST_ROW_Y = TOP_ZONE_Y + Math.max(0, (ZONE_H - blockH) / 2);

  // Each row: name fades in, bar draws (width 0→target with expoOut), pct
  // fades in. Stagger 80ms between rows. Total stagger capped at 8 × 80 =
  // 640ms — slightly above Impeccable's "10 items × 50ms = 500ms" cap, but
  // we have at most 8 rows in practice.
  const baseDelay = 0.20;
  const perRowDelay = 0.08;

  const rows = langs.map((l, i) => {
    const y = FIRST_ROW_Y + i * ROW_H;
    const filledW = Math.max(2, Math.round(BAR_W * l.pct));
    const pctLabel = `${(l.pct * 100).toFixed(1).replace(/\.0$/, "")}%`;
    const rowDelay = baseDelay + i * perRowDelay;
    const pctDelay = rowDelay + parseFloat(ANIM.slow) * 0.6;

    return `  ${entrance(
      `<text x="${PAD_X}" y="${y + BAR_H}" class="row-label" fill="${p.fg}">${escapeXml(l.name)}</text>`,
      { delay: rowDelay, dur: ANIM.fast, ease: EASE.quartOut }
    )}
  ${barWithDrawAnim({
    x: BAR_X, y, h: BAR_H, trackW: BAR_W, fillW: filledW, p, delay: rowDelay,
  })}
  ${entrance(
    `<text x="${CARD_W - PAD_X}" y="${y + BAR_H}" text-anchor="end" class="small-value" fill="${p.muted}">${escapeXml(pctLabel)}</text>`,
    { delay: pctDelay, dur: ANIM.fast, ease: EASE.quartOut }
  )}`;
  }).join("\n");

  const empty = langs.length === 0
    ? `  <text x="${CARD_W / 2}" y="${CARD_H / 2}" text-anchor="middle" class="row-desc" fill="${p.muted}">No recent language data.</text>`
    : "";

  const body = `${sectionTitle(p, PAD_X, TITLE_Y, LANGS_WINDOW_LABEL, 0)}

${rows}
${empty}`;

  return svgWrap({
    width: CARD_W,
    height: CARD_H,
    ariaLabel: `Top languages for @${USERNAME} by recent commits: ${langs.map((l) => `${l.name} ${(l.pct * 100).toFixed(0)}%`).join(", ")}.`,
    body,
  });
}

// ----- main ---------------------------------------------------------------

async function main() {
  console.log(`==> Fetching user + repos for @${USERNAME}…`);
  const user = await fetchUserAndRepos(USERNAME);
  const repos = user.repositories.nodes;
  const totalRepos = user.repositories.totalCount;
  const totalStars = repos.reduce((s, r) => s + (r.stargazerCount ?? 0), 0);

  console.log(`==> Fetching lifetime contributions (chunked year-by-year from ${user.createdAt})…`);
  const { totalCommits, totalPRs, days } = await fetchLifetimeContributions(USERNAME, user.createdAt);

  console.log(`==> Computing streaks (over ${days.length} days)…`);
  const streak = computeStreaks(days);

  console.log(`==> Computing top languages by recent commits…`);
  const langs = computeTopLangs(repos, 8);

  console.log(`\n--- Summary ---`);
  console.log(`  totalCommits      = ${totalCommits}`);
  console.log(`  totalPRs          = ${totalPRs}`);
  console.log(`  totalStars        = ${totalStars}`);
  console.log(`  totalRepos        = ${totalRepos}`);
  console.log(`  totalContribs     = ${streak.totalContribs}`);
  console.log(`  firstContribDate  = ${streak.firstContribDate}`);
  console.log(`  currentStreak     = ${streak.currentStreak} (${streak.currentStart} → ${streak.currentEnd})`);
  console.log(`  longestStreak     = ${streak.longestStreak} (${streak.longestStart} → ${streak.longestEnd})`);
  console.log(`  topLangs          = ${langs.map((l) => `${l.name}:${l.commits}`).join(", ")}\n`);

  for (const theme of ["light", "dark"]) {
    const combined = renderCombinedCard({
      theme,
      totalCommits,
      totalPRs,
      totalStars,
      totalRepos,
      totalContribs: streak.totalContribs,
      currentStreak: streak.currentStreak,
      currentEnd: streak.currentEnd,
      longestStreak: streak.longestStreak,
      longestStart: streak.longestStart,
      longestEnd: streak.longestEnd,
      firstContribDate: streak.firstContribDate,
    });
    const langsSvg = renderLangsCard({ theme, langs });

    const outCombined = resolve(ASSETS_DIR, `numbers-stats-streak-${theme}.svg`);
    const outLangs = resolve(ASSETS_DIR, `numbers-langs-${theme}.svg`);
    writeFileSync(outCombined, combined);
    writeFileSync(outLangs, langsSvg);
    console.log(`Wrote ${outCombined}`);
    console.log(`Wrote ${outLangs}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
