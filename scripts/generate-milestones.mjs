#!/usr/bin/env node
/**
 * generate-milestones.mjs
 *
 * Generates two SVGs (light + dark) summarizing the @ReebalSami GitHub
 * milestones with progress dots, tier thresholds, and explanations.
 *
 * Auto-fetched (via GitHub GraphQL): public projects count, total commits in
 * the last 12 months, stars received across owned repos, distinct coding
 * languages used.
 *
 * Auto-fetched (via RSS): post count from https://reebal-sami.com/blog/feed.xml.
 *
 * Manually curated (edit the MANUAL block below): spoken languages, AWS
 * certifications, years of professional experience, M.Sc. thesis stage.
 *
 * Output: assets/milestones-light.svg + assets/milestones-dark.svg
 *
 * Run:
 *   node scripts/generate-milestones.mjs
 *
 * Env:
 *   GITHUB_TOKEN  required, any token with public-repo read scope
 *   USERNAME      optional, defaults to "ReebalSami"
 */

import { graphql } from "@octokit/graphql";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ----- config -------------------------------------------------------------

const USERNAME = "ReebalSami";
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error("Missing GITHUB_TOKEN env var.");
  process.exit(1);
}

const PORTFOLIO_FEED = "https://reebal-sami.com/feed/en";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const ASSETS_DIR = resolve(ROOT, "assets");
mkdirSync(ASSETS_DIR, { recursive: true });

// ----- manual milestone data (edit these) ---------------------------------

/**
 * Manually curated values that GitHub doesn't know about.
 */
const MANUAL = {
  spokenLanguagesCount: 4, // German, English, Arabic + Spanish (~A2 learning)
  spokenLanguagesDetail: "German · English · Arabic · Spanish (learning)",

  awsCertsAchieved: 0, // increment as you pass each one
  awsCertsInProgress: 3, // total currently studying
  awsCertsDetail: "Cloud Practitioner · AI Practitioner · ML Engineer Associate",

  yearsExperience: 6, // 5+ at OTTO Group + ~1.5y ML/AI since pivot
  yearsExperienceDetail: "Bilanzbuchhalter at OTTO Group → Data Scientist → AI Engineer",

  thesisStage: "writing", // one of: "writing" | "defended" | "published"
  thesisDetail: "Document Intelligence & Knowledge Graph Construction · FH Wedel · defense Q2 2026",
};

// ----- tier model ---------------------------------------------------------

/**
 * Each milestone has tiers; the current tier is the highest threshold the
 * value has crossed. The progress bar fills toward the FINAL tier.
 *
 * tiers: [{ name, threshold }] sorted ascending. The first entry is the
 * floor (e.g., 0). The progress ratio is value / final.threshold.
 */
function tierFor(value, tiers) {
  let current = tiers[0];
  let next = tiers[1] ?? tiers[0];
  for (let i = 0; i < tiers.length; i++) {
    if (value >= tiers[i].threshold) {
      current = tiers[i];
      next = tiers[i + 1] ?? tiers[i];
    }
  }
  const final = tiers[tiers.length - 1];
  const ratio = Math.min(1, value / final.threshold);
  return { current, next, final, ratio };
}

// ----- GitHub GraphQL queries ---------------------------------------------

const gql = graphql.defaults({
  headers: { authorization: `token ${TOKEN}` },
});

async function fetchGitHubStats(login) {
  const now = new Date();
  const oneYearAgo = new Date(now);
  oneYearAgo.setFullYear(now.getFullYear() - 1);

  const data = await gql(
    `
    query ($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        repositories(
          first: 100
          ownerAffiliations: OWNER
          isFork: false
          privacy: PUBLIC
          orderBy: { field: STARGAZERS, direction: DESC }
        ) {
          totalCount
          nodes {
            stargazerCount
            primaryLanguage { name }
            languages(first: 10) { nodes { name } }
          }
        }
        contributionsCollection(from: $from, to: $to) {
          totalCommitContributions
          totalPullRequestContributions
        }
      }
    }
    `,
    { login, from: oneYearAgo.toISOString(), to: now.toISOString() }
  );

  const repos = data.user.repositories.nodes;
  const totalRepos = data.user.repositories.totalCount;
  const totalStars = repos.reduce((sum, r) => sum + r.stargazerCount, 0);
  const totalCommits =
    data.user.contributionsCollection.totalCommitContributions;
  const languages = new Set();
  for (const r of repos) {
    for (const l of r.languages.nodes) languages.add(l.name);
  }
  return {
    totalRepos,
    totalStars,
    totalCommits,
    coderLanguagesCount: languages.size,
  };
}

// ----- RSS feed (portfolio blog) -----------------------------------------

async function fetchPortfolioPostsCount(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { "user-agent": `${USERNAME}-milestones-bot` },
    });
    if (!res.ok) return 0;
    const xml = await res.text();
    const items = xml.match(/<item[\s>]/g);
    return items?.length ?? 0;
  } catch (err) {
    console.warn(`RSS fetch failed for ${url}: ${err.message}`);
    return 0;
  }
}

// ----- SVG rendering ------------------------------------------------------

const PALETTE = {
  light: {
    bg: "#FAF9F4",
    fg: "#22222A",
    muted: "#7C7C82",
    accent: "#B6803F",
    accentSoft: "#B6803F",
    accentSoftAlpha: 0.08,
    border: "#22222A",
    borderAlpha: 0.12,
    dotEmpty: "#22222A",
    dotEmptyAlpha: 0.12,
  },
  dark: {
    bg: "#1B1B20",
    fg: "#F5F4EE",
    muted: "#A4A4AC",
    accent: "#D4A574",
    accentSoft: "#D4A574",
    accentSoftAlpha: 0.12,
    border: "#F5F4EE",
    borderAlpha: 0.12,
    dotEmpty: "#F5F4EE",
    dotEmptyAlpha: 0.14,
  },
};

const SVG_WIDTH = 800;
const ROW_HEIGHT = 76;
const ROW_PAD_X = 60;
const ROW_PAD_TOP = 80; // space for the section title
const ROW_PAD_BOTTOM = 40;
const DOT_COUNT = 30;
const DOT_RADIUS = 2.4;
const DOT_GAP = 4;
const DOT_BAND_WIDTH =
  DOT_COUNT * (DOT_RADIUS * 2) + (DOT_COUNT - 1) * DOT_GAP; // 240ish

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function renderRow({ y, milestone, p }) {
  const { label, value, valueSuffix = "", tier, description, href } = milestone;
  const filledDots = Math.round(tier.ratio * DOT_COUNT);

  const dots = [];
  for (let i = 0; i < DOT_COUNT; i++) {
    const cx = i * (DOT_RADIUS * 2 + DOT_GAP) + DOT_RADIUS;
    const filled = i < filledDots;
    dots.push(
      `<circle cx="${cx}" cy="${DOT_RADIUS}" r="${DOT_RADIUS}" fill="${filled ? p.accent : p.dotEmpty}" fill-opacity="${
        filled ? 1 : p.dotEmptyAlpha
      }"/>`
    );
  }

  const tierLabel = `${tier.current.name}${tier.current.name !== tier.final.name ? ` · next: ${tier.next.name} (${tier.next.threshold.toLocaleString()})` : " · max"}`;

  // Each row is wrapped in <a> if href provided. Inside the <a> we render the
  // visual content, all positioned relative to the row's translate.
  const content = `
    <text x="0" y="14" class="row-label" fill="${p.fg}">${escapeXml(label)}</text>
    <text x="${SVG_WIDTH - 2 * ROW_PAD_X}" y="14" class="row-value" fill="${p.accent}" text-anchor="end">${escapeXml(value)}${escapeXml(valueSuffix)}</text>
    <g transform="translate(0, 28)">${dots.join("")}</g>
    <text x="${DOT_BAND_WIDTH + 16}" y="${28 + DOT_RADIUS + 4}" class="tier-label" fill="${p.muted}">${escapeXml(tierLabel)}</text>
    <text x="0" y="${ROW_HEIGHT - 16}" class="row-desc" fill="${p.muted}">${escapeXml(description)}</text>
    <line x1="0" y1="${ROW_HEIGHT - 4}" x2="${SVG_WIDTH - 2 * ROW_PAD_X}" y2="${ROW_HEIGHT - 4}" stroke="${p.border}" stroke-opacity="${p.borderAlpha}" stroke-width="1"/>
  `;

  if (href) {
    return `<a href="${escapeXml(href)}" target="_blank" rel="noopener"><g transform="translate(${ROW_PAD_X}, ${y})">${content}</g></a>`;
  }
  return `<g transform="translate(${ROW_PAD_X}, ${y})">${content}</g>`;
}

function renderSvg({ milestones, theme }) {
  const p = PALETTE[theme];
  const totalHeight = ROW_PAD_TOP + milestones.length * ROW_HEIGHT + ROW_PAD_BOTTOM;

  const rows = milestones
    .map((m, i) =>
      renderRow({
        y: ROW_PAD_TOP + i * ROW_HEIGHT,
        milestone: m,
        p,
      })
    )
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${SVG_WIDTH} ${totalHeight}" width="${SVG_WIDTH}" height="${totalHeight}" role="img" aria-label="Milestones for @${USERNAME}">
  <defs>
    <style>
      .section-label { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; letter-spacing: 0.14em; font-weight: 500; }
      .row-label { font-family: "Space Grotesk", ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
      .row-value { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
      .tier-label { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10.5px; letter-spacing: 0.06em; }
      .row-desc { font-family: "DM Sans", "Inter", ui-sans-serif, system-ui, -apple-system, sans-serif; font-size: 12px; font-weight: 400; }
    </style>
  </defs>
  <rect width="${SVG_WIDTH}" height="${totalHeight}" fill="${p.bg}"/>

  <!-- title -->
  <text x="${ROW_PAD_X}" y="34" class="section-label" fill="${p.muted}">MILESTONES</text>
  <rect x="${ROW_PAD_X}" y="42" width="60" height="1" fill="${p.accent}" fill-opacity="0.55"/>
  <text x="${ROW_PAD_X}" y="62" class="row-desc" fill="${p.muted}">Progress dots fill toward the final tier · click any row to dig deeper.</text>

  ${rows}
</svg>
`;
}

// ----- main ---------------------------------------------------------------

async function main() {
  console.log(`Fetching GitHub stats for @${USERNAME}…`);
  const stats = await fetchGitHubStats(USERNAME);
  console.log(`Fetching post count from ${PORTFOLIO_FEED}…`);
  const blogPostsCount = await fetchPortfolioPostsCount(PORTFOLIO_FEED);

  // ---- milestone definitions ---------------------------------------------
  const milestones = [
    {
      label: "Public projects shipped",
      value: stats.totalRepos.toLocaleString(),
      tier: tierFor(stats.totalRepos, [
        { name: "Bronze", threshold: 10 },
        { name: "Silver", threshold: 30 },
        { name: "Gold", threshold: 50 },
        { name: "Platinum", threshold: 100 },
      ]),
      description: "Open-source repositories owned by @ReebalSami (forks excluded).",
      href: `https://github.com/${USERNAME}?tab=repositories`,
    },
    {
      label: "Commits in the last year",
      value: stats.totalCommits.toLocaleString(),
      tier: tierFor(stats.totalCommits, [
        { name: "Bronze", threshold: 500 },
        { name: "Silver", threshold: 2_000 },
        { name: "Gold", threshold: 5_000 },
        { name: "Platinum", threshold: 10_000 },
      ]),
      description: "Verified commits across all repos in the trailing 12 months.",
      href: `https://github.com/${USERNAME}?tab=overview`,
    },
    {
      label: "Stars received",
      value: stats.totalStars.toLocaleString(),
      tier: tierFor(stats.totalStars, [
        { name: "Bronze", threshold: 25 },
        { name: "Silver", threshold: 100 },
        { name: "Gold", threshold: 500 },
        { name: "Platinum", threshold: 2_000 },
      ]),
      description: "Stars on owned repositories — peer recognition signal.",
      href: `https://github.com/${USERNAME}?tab=repositories&sort=stargazers`,
    },
    {
      label: "Coding languages used",
      value: stats.coderLanguagesCount.toLocaleString(),
      tier: tierFor(stats.coderLanguagesCount, [
        { name: "Bronze", threshold: 5 },
        { name: "Silver", threshold: 10 },
        { name: "Gold", threshold: 15 },
        { name: "Platinum", threshold: 20 },
      ]),
      description: "Distinct languages detected across owned repos by GitHub Linguist.",
      href: `https://github.com/${USERNAME}?tab=repositories`,
    },
    {
      label: "Spoken languages",
      value: MANUAL.spokenLanguagesCount.toString(),
      tier: tierFor(MANUAL.spokenLanguagesCount, [
        { name: "Bronze", threshold: 2 },
        { name: "Silver", threshold: 4 },
        { name: "Gold", threshold: 6 },
        { name: "Polyglot", threshold: 8 },
      ]),
      description: MANUAL.spokenLanguagesDetail,
      href: "https://reebal-sami.com/about",
    },
    {
      label: "AWS certifications",
      value: `${MANUAL.awsCertsAchieved}/${MANUAL.awsCertsInProgress}`,
      tier: tierFor(MANUAL.awsCertsAchieved, [
        { name: "In progress", threshold: 0 },
        { name: "Foundational", threshold: 1 },
        { name: "Specialty", threshold: 2 },
        { name: "All three", threshold: 3 },
      ]),
      description: MANUAL.awsCertsDetail,
      href: "https://www.credly.com/users/reebal-sami",
    },
    {
      label: "Years as a builder",
      value: `${MANUAL.yearsExperience}+`,
      tier: tierFor(MANUAL.yearsExperience, [
        { name: "Apprentice", threshold: 2 },
        { name: "Practitioner", threshold: 5 },
        { name: "Senior", threshold: 10 },
        { name: "Veteran", threshold: 15 },
      ]),
      description: MANUAL.yearsExperienceDetail,
      href: "https://reebal-sami.com/about",
    },
    {
      label: "Posts on the portfolio blog",
      value: blogPostsCount.toLocaleString(),
      tier: tierFor(blogPostsCount, [
        { name: "Drafted", threshold: 1 },
        { name: "Started", threshold: 5 },
        { name: "Voice found", threshold: 15 },
        { name: "Library", threshold: 50 },
      ]),
      description: "Long-form writing published at reebal-sami.com/blog.",
      href: "https://reebal-sami.com/blog",
    },
    {
      label: "M.Sc. thesis",
      value:
        MANUAL.thesisStage === "published"
          ? "published"
          : MANUAL.thesisStage === "defended"
            ? "defended"
            : "writing",
      tier: tierFor(
        { writing: 1, defended: 2, published: 3 }[MANUAL.thesisStage] ?? 1,
        [
          { name: "Drafting", threshold: 1 },
          { name: "Submitted", threshold: 2 },
          { name: "Published", threshold: 3 },
        ]
      ),
      description: MANUAL.thesisDetail,
      href: "https://reebal-sami.com/about#thesis",
    },
  ];

  for (const theme of ["light", "dark"]) {
    const svg = renderSvg({ milestones, theme });
    const out = resolve(ASSETS_DIR, `milestones-${theme}.svg`);
    writeFileSync(out, svg);
    console.log(`Wrote ${out} (${svg.length} bytes)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
