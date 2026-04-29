/**
 * contributions.mjs
 *
 * Fetches a user's contribution calendar from GitHub's GraphQL API,
 * trims it to the most recent N weeks (default 26 = "half year"), and
 * returns a flat day grid the renderer can consume directly.
 *
 * Why GraphQL over scraping the profile HTML or REST?
 *   - Stable, documented endpoint
 *   - Returns the EXACT same level buckets that GitHub displays on the
 *     profile (`contributionLevel`: NONE / FIRST/SECOND/THIRD/FOURTH_QUARTILE)
 *   - One request, no pagination
 *
 * Auth: a personal-access token with public-repo scope. In CI we read
 * `GITHUB_TOKEN` (the workflow already passes `secrets.METRICS_TOKEN`).
 */

import { graphql } from "@octokit/graphql";

/** GitHub's contribution levels mapped to 0..4 ints. */
const LEVEL_MAP = {
  NONE: 0,
  FIRST_QUARTILE: 1,
  SECOND_QUARTILE: 2,
  THIRD_QUARTILE: 3,
  FOURTH_QUARTILE: 4,
};

const QUERY = /* GraphQL */ `
  query ($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              date
              contributionCount
              contributionLevel
            }
          }
        }
      }
    }
  }
`;

/**
 * Fetch the contribution grid for `user`, trimmed to the most recent
 * `weeks` weeks ending today.
 *
 * @param {{user: string, weeks?: number, token?: string}} opts
 * @returns {Promise<{
 *   user: string,
 *   weeks: number,            // actual number returned (≤ requested)
 *   days: Array<{date:string, count:number, level:number, gx:number, gy:number}>,
 *   total: number,            // total contributions across the trimmed window
 * }>}
 */
export async function fetchContributions({ user, weeks = 26, token }) {
  if (!user) throw new Error("fetchContributions: user is required");
  const auth = token || process.env.GITHUB_TOKEN || process.env.METRICS_TOKEN;
  if (!auth) {
    throw new Error(
      "fetchContributions: no auth token (set GITHUB_TOKEN or METRICS_TOKEN)"
    );
  }

  // GitHub returns up to 1 year. Ask for slightly more than `weeks` so we
  // always have enough to trim to whole weeks ending today, regardless of
  // current weekday or DST.
  const now = new Date();
  const fromDate = new Date(now);
  fromDate.setUTCDate(fromDate.getUTCDate() - (weeks + 1) * 7);
  const variables = {
    login: user,
    from: fromDate.toISOString(),
    to: now.toISOString(),
  };

  const client = graphql.defaults({
    headers: { authorization: `token ${auth}` },
  });

  const data = await client(QUERY, variables);
  const cal = data?.user?.contributionsCollection?.contributionCalendar;
  if (!cal) {
    throw new Error(
      `fetchContributions: empty response for user ${user} — check token + login`
    );
  }

  // Flatten weeks → days, preserving GitHub's ordering (oldest first).
  /** @type {Array<{date:string, count:number, level:number}>} */
  const allDays = [];
  for (const wk of cal.weeks) {
    for (const d of wk.contributionDays) {
      allDays.push({
        date: d.date,
        count: d.contributionCount,
        level: LEVEL_MAP[d.contributionLevel] ?? 0,
      });
    }
  }

  // Trim to exactly `weeks * 7` days ending today (= the LAST `weeks*7`
  // entries in the chronological list). GitHub always returns whole weeks
  // aligned to Sunday, so the slice may include up to 6 future-dated cells
  // for the current incomplete week. We KEEP those — they show as level-0
  // empty cells, which is exactly the look GitHub uses.
  const targetDayCount = weeks * 7;
  const trimmed = allDays.slice(-targetDayCount);

  // Re-bucket into weeks: index 0..6 within each week is dayIdx (Sun..Sat).
  // Index 0..weeks-1 across weeks is gx (oldest week first).
  const days = trimmed.map((d, i) => ({
    ...d,
    gx: Math.floor(i / 7),
    gy: i % 7,
  }));

  const total = days.reduce((s, d) => s + d.count, 0);
  return { user, weeks, days, total };
}
