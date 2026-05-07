#!/usr/bin/env node
/**
 * generate-github-numbers.mjs
 *
 * Renders the three "GitHub by the numbers" cards for @ReebalSami's profile
 * README, replacing the previous third-party services
 * (github-readme-stats.vercel.app + streak-stats.demolab.com):
 *
 *   LEFT   numbers-stats-{light,dark}.svg    Volume tile (4 lifetime totals)
 *   MIDDLE numbers-streak-{light,dark}.svg   Streak tile (total / current / longest)
 *   RIGHT  numbers-langs-{light,dark}.svg    Top languages by recent commits
 *
 * Story arc: LEFT = volume · MIDDLE = cadence · RIGHT = range.
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
import { CARD_PALETTE, TYPO, escapeXml } from "./lib/palette.mjs";

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

const CARD_W = 480;
const CARD_H = 180;

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

function sectionTitle(p, x, y, label, accentBarLen = 60) {
  return `  <text x="${x}" y="${y}" class="section-label" fill="${p.muted}">${escapeXml(label)}</text>
  <rect x="${x}" y="${y + 8}" width="${accentBarLen}" height="1" fill="${p.accent}" fill-opacity="0.55"/>`;
}

// ----- LEFT card: volume tile ---------------------------------------------

function renderStatsCard({ theme, totalCommits, totalPRs, totalStars, totalRepos }) {
  const p = CARD_PALETTE[theme];

  const PAD_X = 24;
  const PAD_TOP = 28;
  // 2x2 grid centered vertically in the remaining space below the title.
  // The "Building since…" date already lives on the streak card next door,
  // so we don't duplicate it here.
  const TOP_ZONE_Y = PAD_TOP + 12;
  const BOT_ZONE_Y = CARD_H - 12;
  const ZONE_H = BOT_ZONE_Y - TOP_ZONE_Y;
  const CELL_H = 60;
  const ROW_Y = [
    TOP_ZONE_Y + (ZONE_H - CELL_H * 2) / 3,
    TOP_ZONE_Y + (ZONE_H - CELL_H * 2) / 3 * 2 + CELL_H,
  ];
  const COL_X = [PAD_X, CARD_W / 2 + 8];

  const cell = (col, row, value, label) => {
    const x = COL_X[col];
    const y = ROW_Y[row];
    return `  <text x="${x}" y="${y + 26}" class="row-value" fill="${p.fg}">${escapeXml(value)}</text>
  <text x="${x}" y="${y + 48}" class="row-label" fill="${p.muted}">${escapeXml(label)}</text>`;
  };

  const body = `${sectionTitle(p, PAD_X, PAD_TOP - 14, "VOLUME")}

${cell(0, 0, totalCommits.toLocaleString(), "Total commits")}
${cell(1, 0, totalPRs.toLocaleString(), "Total PRs")}
${cell(0, 1, totalStars.toLocaleString(), "Stars received")}
${cell(1, 1, totalRepos.toLocaleString(), "Repositories")}`;

  return svgWrap({
    width: CARD_W,
    height: CARD_H,
    ariaLabel: `Lifetime totals for @${USERNAME}: ${totalCommits} commits, ${totalPRs} PRs, ${totalStars} stars, ${totalRepos} repos.`,
    body,
  });
}

// ----- MIDDLE card: streak tile -------------------------------------------

function renderStreakCard({ theme, totalContribs, currentStreak, currentEnd, longestStreak, longestStart, longestEnd, firstContribDate }) {
  const p = CARD_PALETTE[theme];

  const PAD_X = 16;
  const PAD_TOP = 28;
  const COL_W = (CARD_W - PAD_X * 2) / 3;
  const COL_X = [PAD_X + COL_W * 0.5, PAD_X + COL_W * 1.5, PAD_X + COL_W * 2.5];
  const VAL_Y = PAD_TOP + 50;
  const LABEL_Y = VAL_Y + 22;
  const DATE_Y = LABEL_Y + 18;
  const DIVIDER_Y_TOP = PAD_TOP + 12;
  const DIVIDER_Y_BOT = CARD_H - 16;

  const sinceLabel = firstContribDate
    ? `${formatYMDShort(firstContribDate)} ${firstContribDate.slice(0, 4)} – Present`
    : "";
  const currentLabel = currentEnd ? formatYMDShort(currentEnd) : "—";
  const longestLabel = formatRange(longestStart, longestEnd);

  const col = (i, value, label, sub) => `  <text x="${COL_X[i]}" y="${VAL_Y}" text-anchor="middle" class="row-value" fill="${i === 1 ? p.accent : p.fg}">${escapeXml(value)}</text>
  <text x="${COL_X[i]}" y="${LABEL_Y}" text-anchor="middle" class="row-label" fill="${p.muted}">${escapeXml(label)}</text>
  <text x="${COL_X[i]}" y="${DATE_Y}" text-anchor="middle" class="small-value" fill="${p.muted}">${escapeXml(sub)}</text>`;

  // Vertical dividers between the three columns.
  const divX1 = PAD_X + COL_W;
  const divX2 = PAD_X + COL_W * 2;
  const dividers = `  <line x1="${divX1}" y1="${DIVIDER_Y_TOP}" x2="${divX1}" y2="${DIVIDER_Y_BOT}" stroke="${p.border}" stroke-opacity="${p.borderAlpha}" stroke-width="1"/>
  <line x1="${divX2}" y1="${DIVIDER_Y_TOP}" x2="${divX2}" y2="${DIVIDER_Y_BOT}" stroke="${p.border}" stroke-opacity="${p.borderAlpha}" stroke-width="1"/>`;

  const body = `${sectionTitle(p, PAD_X, PAD_TOP - 14, "CADENCE")}

${col(0, totalContribs.toLocaleString(), "Total contributions", sinceLabel)}
${col(1, currentStreak.toLocaleString(), "Current streak", currentLabel)}
${col(2, longestStreak.toLocaleString(), "Longest streak", longestLabel)}

${dividers}`;

  return svgWrap({
    width: CARD_W,
    height: CARD_H,
    ariaLabel: `Streak for @${USERNAME}: ${totalContribs} contributions, current streak ${currentStreak}, longest streak ${longestStreak}.`,
    body,
  });
}

// ----- RIGHT card: top languages ------------------------------------------

function renderLangsCard({ theme, langs }) {
  const p = CARD_PALETTE[theme];

  const PAD_X = 24;
  const PAD_TOP = 28;
  const TITLE_Y = PAD_TOP - 14;
  // NAME_W must accommodate the widest expected language name
  // (e.g., "Jupyter Notebook" at 13px Space Grotesk).
  const NAME_W = 132;
  const PCT_W = 54;
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
  const ROW_H = Math.min(28, Math.max(16, Math.floor(ZONE_H / Math.max(n, 4))));
  const blockH = ROW_H * n;
  const FIRST_ROW_Y = TOP_ZONE_Y + Math.max(0, (ZONE_H - blockH) / 2);

  const rows = langs.map((l, i) => {
    const y = FIRST_ROW_Y + i * ROW_H;
    const filledW = Math.max(2, Math.round(BAR_W * l.pct));
    const pctLabel = `${(l.pct * 100).toFixed(1).replace(/\.0$/, "")}%`;
    return `  <text x="${PAD_X}" y="${y + BAR_H}" class="row-label" fill="${p.fg}">${escapeXml(l.name)}</text>
  <rect x="${BAR_X}" y="${y}" width="${BAR_W}" height="${BAR_H}" fill="${p.barTrack}" fill-opacity="${p.barTrackAlpha}" rx="${BAR_H / 2}"/>
  <rect x="${BAR_X}" y="${y}" width="${filledW}" height="${BAR_H}" fill="${p.accent}" rx="${BAR_H / 2}"/>
  <text x="${CARD_W - PAD_X}" y="${y + BAR_H}" text-anchor="end" class="small-value" fill="${p.muted}">${escapeXml(pctLabel)}</text>`;
  }).join("\n");

  const empty = langs.length === 0
    ? `  <text x="${CARD_W / 2}" y="${CARD_H / 2}" text-anchor="middle" class="row-desc" fill="${p.muted}">No recent language data.</text>`
    : "";

  const body = `${sectionTitle(p, PAD_X, TITLE_Y, LANGS_WINDOW_LABEL)}

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
    const stats = renderStatsCard({
      theme,
      totalCommits,
      totalPRs,
      totalStars,
      totalRepos,
    });
    const streakSvg = renderStreakCard({
      theme,
      totalContribs: streak.totalContribs,
      currentStreak: streak.currentStreak,
      currentEnd: streak.currentEnd,
      longestStreak: streak.longestStreak,
      longestStart: streak.longestStart,
      longestEnd: streak.longestEnd,
      firstContribDate: streak.firstContribDate,
    });
    const langsSvg = renderLangsCard({ theme, langs });

    const outStats = resolve(ASSETS_DIR, `numbers-stats-${theme}.svg`);
    const outStreak = resolve(ASSETS_DIR, `numbers-streak-${theme}.svg`);
    const outLangs = resolve(ASSETS_DIR, `numbers-langs-${theme}.svg`);
    writeFileSync(outStats, stats);
    writeFileSync(outStreak, streakSvg);
    writeFileSync(outLangs, langsSvg);
    console.log(`Wrote ${outStats}`);
    console.log(`Wrote ${outStreak}`);
    console.log(`Wrote ${outLangs}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
