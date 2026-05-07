#!/usr/bin/env node
/**
 * generate-milestones.mjs
 *
 * Renders the "Milestones" card for @ReebalSami's profile README, sourcing
 * EVERY datapoint from GitHub itself — no hardcoded tier thresholds, no
 * manually-curated values. Two sub-sections in one full-width card:
 *
 *   Active milestones   real repository-level milestones (the GitHub
 *                       Issues feature) currently OPEN with at least one
 *                       open issue. Sorted by `updatedAt DESC`, top 3.
 *   Active projects     GitHub Projects v2 updated within the last 90
 *                       days, with computed Done/Total completion via
 *                       the Status field (Todo / In Progress / Done).
 *                       Top 3.
 *
 * The card adapts to the number of available rows — if you don't have 3
 * active milestones, the milestones sub-section renders fewer rows (or is
 * omitted entirely if zero). Same for projects. If both sub-sections are
 * empty, the card shows a graceful "No active milestones — back to
 * building" empty state.
 *
 * Auth: this script needs a token with both `repo` (or `public_repo`) AND
 * `read:project` scopes. The default actions-provided GITHUB_TOKEN does
 * NOT have project scope. If the projects query fails (401/403), the
 * script logs a warning and renders the milestones half only — graceful
 * degradation rather than hard failure.
 *
 * Run:
 *   GITHUB_TOKEN=ghp_… node scripts/generate-milestones.mjs
 *
 * Env:
 *   GITHUB_TOKEN  required, PAT (or fine-grained PAT or GitHub App
 *                 installation token) with `repo` + `read:project`
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

const gql = graphql.defaults({ headers: { authorization: `token ${TOKEN}` } });

// "Active" window: 90 days of inactivity is enough for us to assume the
// project/milestone is effectively archived. Applied to BOTH milestones
// and projects, with one escape hatch: a milestone whose `dueOn` is in
// the future stays active regardless of age (long-running sprint goal).
const ACTIVE_WINDOW_DAYS = 90;

// Cap rows per sub-section so the card doesn't grow without bound on a
// busy account. With 3+3 the card is ~450px tall; beyond that it eats too
// much vertical real estate on the README.
const MAX_MILESTONES = 3;
const MAX_PROJECTS = 3;

// ----- GraphQL queries ----------------------------------------------------

/**
 * Fetch repo-level milestones across all owned (non-fork) repositories.
 * Filtered to OPEN milestones with at least one OPEN issue — milestones
 * that are technically open but have all issues closed are effectively
 * "done, just not yet manually closed by the user" and would clutter the
 * "Active" set with noise.
 */
async function fetchRepoMilestones(login) {
  const data = await gql(
    `
    query ($login: String!) {
      user(login: $login) {
        repositories(first: 100, ownerAffiliations: OWNER, isFork: false) {
          nodes {
            name
            milestones(
              first: 10
              states: OPEN
              orderBy: { field: UPDATED_AT, direction: DESC }
            ) {
              nodes {
                title
                dueOn
                closedIssueCount
                openIssueCount
                progressPercentage
                url
                updatedAt
              }
            }
          }
        }
      }
    }
    `,
    { login }
  );

  const cutoff = Date.now() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const out = [];

  for (const repo of data.user.repositories.nodes) {
    for (const m of repo.milestones.nodes) {
      // Filter 1: must have at least one open issue (else it's "done-but-
      // not-yet-closed" noise).
      if (m.openIssueCount === 0) continue;

      // Filter 2: staleness — either updated within ACTIVE_WINDOW_DAYS,
      // OR has a future due date (long-running goal). An OTTO milestone
      // last touched 39mo ago with a past due date is abandoned, not
      // active, and shouldn't appear as "in progress".
      const updatedRecently = Date.parse(m.updatedAt) >= cutoff;
      const dueInFuture = m.dueOn ? Date.parse(m.dueOn) > now : false;
      if (!updatedRecently && !dueInFuture) continue;

      out.push({
        title: m.title,
        repo: repo.name,
        closedCount: m.closedIssueCount,
        openCount: m.openIssueCount,
        progress: m.progressPercentage / 100,
        dueOn: m.dueOn,
        updatedAt: m.updatedAt,
        url: m.url,
      });
    }
  }

  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out.slice(0, MAX_MILESTONES);
}

/**
 * Fetch GitHub Projects v2 owned by the user. For each, count items by
 * Status (Todo / In Progress / Done) so we can compute a real Done/Total
 * completion %.
 *
 * Returns null if the token lacks `read:project` scope (401/403). The
 * caller treats `null` as "skip the projects sub-section entirely" rather
 * than failing the whole render.
 */
async function fetchActiveProjects(login) {
  let data;
  try {
    data = await gql(
      `
      query ($login: String!) {
        user(login: $login) {
          projectsV2(
            first: 20
            orderBy: { field: UPDATED_AT, direction: DESC }
          ) {
            nodes {
              title
              number
              url
              updatedAt
              closed
              items(first: 100) {
                totalCount
                nodes {
                  fieldValues(first: 10) {
                    nodes {
                      ... on ProjectV2ItemFieldSingleSelectValue {
                        name
                        field {
                          ... on ProjectV2SingleSelectField { name }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
      `,
      { login }
    );
  } catch (err) {
    const msg = err?.message || String(err);
    if (/Resource not accessible|FORBIDDEN|401|403|read:project/i.test(msg)) {
      console.warn(
        `! Projects query rejected (token likely lacks read:project scope). Skipping projects sub-section. Detail: ${msg.slice(0, 120)}`
      );
      return null;
    }
    throw err;
  }

  const cutoff = Date.now() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const out = [];

  for (const proj of data.user.projectsV2.nodes) {
    if (proj.closed) continue;
    if (Date.parse(proj.updatedAt) < cutoff) continue;

    let done = 0;
    let inProgress = 0;
    let todo = 0;
    for (const item of proj.items.nodes) {
      const statusFieldValue = item.fieldValues.nodes.find(
        (fv) => fv && fv.field && fv.field.name === "Status"
      );
      const status = statusFieldValue?.name ?? "";
      if (status === "Done") done += 1;
      else if (/in.?progress/i.test(status)) inProgress += 1;
      else todo += 1; // includes "Todo", "Backlog", any other label, or unset
    }

    const total = proj.items.totalCount;
    out.push({
      title: proj.title,
      number: proj.number,
      itemsTotal: total,
      done,
      inProgress,
      todo,
      progress: total > 0 ? done / total : 0,
      updatedAt: proj.updatedAt,
      url: proj.url,
    });
  }

  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out.slice(0, MAX_PROJECTS);
}

// ----- formatting helpers -------------------------------------------------

function relativeTime(iso) {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  const s = Math.max(1, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d >= 30) return `${Math.floor(d / 30)}mo ago`;
  if (d >= 1) return `${d}d ago`;
  if (h >= 1) return `${h}h ago`;
  if (m >= 1) return `${m}m ago`;
  return "just now";
}

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function formatDueOn(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

function fmtPercent(p) {
  return `${Math.round(p * 100)}%`;
}

// ----- layout constants ---------------------------------------------------

const CARD_W = 960;
const PAD_X = 24;
const PAD_TOP = 28;
const PAD_BOTTOM = 24;

// No top-level title — the README H2 "Milestones" already labels this card.
// Instead we use two peer VOLUME/CADENCE-style section labels ("ACTIVE
// MILESTONES" + "ACTIVE PROJECTS") inside the card itself, matching the
// pattern established by `numbers-stats-streak-*.svg`.
const SECTION_HEADER_HEIGHT = 32; // label (14) + accent bar (1) + gap (17)
const SUB_SECTION_GAP = 20;       // gap between the two peer sections
const ROW_HEIGHT = 50;            // per row (title+bar+subtitle), incl. spacing
const BAR_HEIGHT = 6;
const BAR_LABEL_W = 60;           // right-side reserved space for "92%"

function computeHeight({ milestones, projects }) {
  let h = PAD_TOP;

  let inSection = false;
  if (milestones.length > 0) {
    h += SECTION_HEADER_HEIGHT + milestones.length * ROW_HEIGHT;
    inSection = true;
  }
  if (projects.length > 0) {
    if (inSection) h += SUB_SECTION_GAP;
    h += SECTION_HEADER_HEIGHT + projects.length * ROW_HEIGHT;
    inSection = true;
  }
  if (!inSection) h += SECTION_HEADER_HEIGHT + 40; // empty state

  h += PAD_BOTTOM;
  return h;
}

// ----- animation helpers (mirroring generate-github-numbers.mjs) ----------

/**
 * Wrap arbitrary SVG content in a `<g>` whose opacity fades 0→1 and which
 * optionally rises (translateY dy→0) on entrance. One-shot.
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
 * Track + fill horizontal bar where the fill draws 0→targetW on entrance.
 * Same primitive used in generate-github-numbers.mjs renderLangsCard().
 */
function barWithDrawAnim({ x, y, h, trackW, fillW, p, delay, dur = ANIM.slow }) {
  return `<rect x="${x}" y="${y}" width="${trackW}" height="${h}" fill="${p.barTrack}" fill-opacity="${p.barTrackAlpha}" rx="${h / 2}"/>
    <rect x="${x}" y="${y}" width="0" height="${h}" fill="${p.accent}" rx="${h / 2}">
      <animate attributeName="width" begin="${delay}s" dur="${dur}" from="0" to="${fillW}" fill="freeze" calcMode="spline" keySplines="${EASE.expoOut}"/>
    </rect>`;
}

// ----- SVG primitives -----------------------------------------------------

function svgWrap({ width, height, ariaLabel, body }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeXml(ariaLabel)}">
  <defs>
    <style>
      .section-label { ${TYPO.sectionLabel} }
      .row-label     { ${TYPO.rowLabel} }
      .row-value     { ${TYPO.rowValue} }
      .small-value   { ${TYPO.smallValue} }
      .row-desc      { ${TYPO.rowDesc} }
    </style>
  </defs>
${body}
</svg>
`;
}

function sectionTitle(p, x, y, label, delay, accentBarLen = 60) {
  return `  <g opacity="0">
    <animate attributeName="opacity" begin="${delay}s" dur="${ANIM.fast}" from="0" to="1" fill="freeze" calcMode="spline" keySplines="${EASE.quartOut}"/>
    <text x="${x}" y="${y}" class="section-label" fill="${p.muted}">${escapeXml(label)}</text>
  </g>
  <rect x="${x}" y="${y + 8}" width="0" height="1" fill="${p.accent}" fill-opacity="0.55">
    <animate attributeName="width" begin="${delay + 0.08}s" dur="${ANIM.base}" from="0" to="${accentBarLen}" fill="freeze" calcMode="spline" keySplines="${EASE.expoOut}"/>
  </rect>`;
}

// ----- Row renderers ------------------------------------------------------

function renderMilestoneRow({ p, y, m, delay }) {
  const barX = PAD_X;
  const barW = CARD_W - PAD_X * 2 - BAR_LABEL_W;
  const fillW = Math.max(2, Math.round(barW * m.progress));
  const pctLabel = fmtPercent(m.progress);
  const pctDelay = delay + 0.05;
  const barDelay = delay + 0.10;
  const subDelay = delay + 0.18;

  const title = entrance(
    `<text x="${PAD_X}" y="${y}" class="row-label" fill="${p.fg}">${escapeXml(m.title)}</text>`,
    { delay, dur: ANIM.fast, ease: EASE.quartOut, dy: 4 }
  );

  const pct = entrance(
    `<text x="${CARD_W - PAD_X}" y="${y}" text-anchor="end" class="small-value" fill="${p.muted}">${escapeXml(pctLabel)}</text>`,
    { delay: pctDelay, dur: ANIM.fast, ease: EASE.quartOut }
  );

  const barY = y + 8;
  const bar = barWithDrawAnim({
    x: barX, y: barY, h: BAR_HEIGHT, trackW: barW, fillW, p, delay: barDelay,
  });

  const subtitleParts = [
    m.repo,
    m.dueOn ? `due ${formatDueOn(m.dueOn)}` : null,
    `${m.closedCount}/${m.closedCount + m.openCount} issues`,
    `updated ${relativeTime(m.updatedAt)}`,
  ].filter(Boolean);

  const subtitle = entrance(
    `<text x="${PAD_X}" y="${y + 28}" class="small-value" fill="${p.muted}">${escapeXml(subtitleParts.join(" · "))}</text>`,
    { delay: subDelay, dur: ANIM.fast, ease: EASE.quartOut }
  );

  return `<a href="${escapeXml(m.url)}" target="_blank" rel="noopener">
    ${title}
    ${pct}
    ${bar}
    ${subtitle}
  </a>`;
}

function renderProjectRow({ p, y, proj, delay }) {
  const barX = PAD_X;
  const barW = CARD_W - PAD_X * 2 - BAR_LABEL_W;
  const fillW = Math.max(2, Math.round(barW * proj.progress));
  const pctLabel = fmtPercent(proj.progress);
  const pctDelay = delay + 0.05;
  const barDelay = delay + 0.10;
  const subDelay = delay + 0.18;

  const title = entrance(
    `<text x="${PAD_X}" y="${y}" class="row-label" fill="${p.fg}">${escapeXml(proj.title)}</text>`,
    { delay, dur: ANIM.fast, ease: EASE.quartOut, dy: 4 }
  );

  const pct = entrance(
    `<text x="${CARD_W - PAD_X}" y="${y}" text-anchor="end" class="small-value" fill="${p.muted}">${escapeXml(pctLabel)}</text>`,
    { delay: pctDelay, dur: ANIM.fast, ease: EASE.quartOut }
  );

  const barY = y + 8;
  const bar = barWithDrawAnim({
    x: barX, y: barY, h: BAR_HEIGHT, trackW: barW, fillW, p, delay: barDelay,
  });

  const subParts = [
    `${proj.itemsTotal} items`,
    `${proj.done} done`,
  ];
  if (proj.inProgress > 0) subParts.push(`${proj.inProgress} in progress`);
  if (proj.todo > 0) subParts.push(`${proj.todo} to do`);
  subParts.push(`updated ${relativeTime(proj.updatedAt)}`);

  const subtitle = entrance(
    `<text x="${PAD_X}" y="${y + 28}" class="small-value" fill="${p.muted}">${escapeXml(subParts.join(" · "))}</text>`,
    { delay: subDelay, dur: ANIM.fast, ease: EASE.quartOut }
  );

  return `<a href="${escapeXml(proj.url)}" target="_blank" rel="noopener">
    ${title}
    ${pct}
    ${bar}
    ${subtitle}
  </a>`;
}

// ----- Main render --------------------------------------------------------

function renderSvg({ theme, milestones, projects }) {
  const p = CARD_PALETTE[theme];
  const totalH = computeHeight({ milestones, projects });

  // `cursorY` tracks the next available y-coordinate (top of next element).
  let cursorY = PAD_TOP;
  const sections = [];

  // Entrance choreography: each section's title animates first, then its
  // rows staggered 80ms each. Total entrance stays ≤ 1.0s for a populated
  // card per Impeccable's "cap stagger at ≤ 500ms × depth" rule.
  let entranceDelay = 0;

  if (milestones.length > 0) {
    // sectionTitle expects the baseline y for the text; our cursor is the
    // top of the label zone, so add 14 (the font-ascent of section-label
    // at 11px).
    sections.push(
      sectionTitle(p, PAD_X, cursorY + 14, "ACTIVE MILESTONES", entranceDelay)
    );
    // Label + accent bar + breathing room = SECTION_HEADER_HEIGHT. The
    // first row's title baseline sits inside that breathing room.
    const rowsStartY = cursorY + SECTION_HEADER_HEIGHT + 14;
    entranceDelay += 0.18;

    milestones.forEach((m, i) => {
      const rowY = rowsStartY + i * ROW_HEIGHT;
      sections.push(
        renderMilestoneRow({
          p, y: rowY, m, delay: entranceDelay + i * 0.08,
        })
      );
    });
    cursorY += SECTION_HEADER_HEIGHT + milestones.length * ROW_HEIGHT;
    entranceDelay += milestones.length * 0.08;
  }

  if (projects.length > 0) {
    if (milestones.length > 0) cursorY += SUB_SECTION_GAP;

    sections.push(
      sectionTitle(p, PAD_X, cursorY + 14, "ACTIVE PROJECTS", entranceDelay)
    );
    const rowsStartY = cursorY + SECTION_HEADER_HEIGHT + 14;
    entranceDelay += 0.18;

    projects.forEach((proj, i) => {
      const rowY = rowsStartY + i * ROW_HEIGHT;
      sections.push(
        renderProjectRow({
          p, y: rowY, proj, delay: entranceDelay + i * 0.08,
        })
      );
    });
    cursorY += SECTION_HEADER_HEIGHT + projects.length * ROW_HEIGHT;
  }

  if (milestones.length === 0 && projects.length === 0) {
    sections.push(
      sectionTitle(p, PAD_X, PAD_TOP + 14, "NO ACTIVE WORK", 0)
    );
    sections.push(
      `  <text x="${CARD_W / 2}" y="${PAD_TOP + SECTION_HEADER_HEIGHT + 30}" text-anchor="middle" class="row-desc" fill="${p.muted}">Between sprints — back to building.</text>`
    );
  }

  const ariaParts = [];
  if (milestones.length > 0) {
    ariaParts.push(
      `${milestones.length} active milestone(s): ${milestones
        .map((m) => `${m.title} ${fmtPercent(m.progress)}`)
        .join("; ")}`
    );
  }
  if (projects.length > 0) {
    ariaParts.push(
      `${projects.length} active project(s): ${projects
        .map((proj) => `${proj.title} ${fmtPercent(proj.progress)}`)
        .join("; ")}`
    );
  }
  const ariaLabel =
    ariaParts.length === 0
      ? `Milestones for @${USERNAME}: no active work right now.`
      : `Milestones for @${USERNAME}. ${ariaParts.join(". ")}.`;

  const body = sections.join("\n\n");
  return svgWrap({ width: CARD_W, height: totalH, ariaLabel, body });
}

// ----- main ---------------------------------------------------------------

async function main() {
  console.log(`==> Fetching repo milestones for @${USERNAME}…`);
  const milestones = await fetchRepoMilestones(USERNAME);
  console.log(`    ${milestones.length} active milestone(s):`);
  for (const m of milestones) {
    console.log(
      `      · ${m.title} (${m.repo}) ${fmtPercent(m.progress)} (${m.closedCount}/${m.closedCount + m.openCount}) updated ${relativeTime(m.updatedAt)}`
    );
  }

  console.log(`\n==> Fetching active GitHub Projects v2 for @${USERNAME}…`);
  const projects = (await fetchActiveProjects(USERNAME)) ?? [];
  console.log(`    ${projects.length} active project(s):`);
  for (const proj of projects) {
    console.log(
      `      · ${proj.title} (#${proj.number}) ${fmtPercent(proj.progress)} — ${proj.done}/${proj.itemsTotal} done, ${proj.inProgress} in progress, ${proj.todo} to do, updated ${relativeTime(proj.updatedAt)}`
    );
  }

  console.log("");
  for (const theme of ["light", "dark"]) {
    const svg = renderSvg({ theme, milestones, projects });
    const out = resolve(ASSETS_DIR, `milestones-${theme}.svg`);
    writeFileSync(out, svg);
    console.log(`Wrote ${out} (${svg.length} bytes)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
