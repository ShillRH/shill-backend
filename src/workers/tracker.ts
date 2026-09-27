// Finds new shill posts on every enabled platform and keeps their engagement up to date,
// while keeping paid API usage low:
//  - only posts from linked $SHILL accounts are searched for (X supports author filters)
//  - each search starts after the newest post already seen (since_id)
//  - engagement is re-checked less often as posts age:
//      under 6 hours old -> every hour
//      6 to 48 hours     -> every 6 hours
//      2 to 7 days       -> once a day
//    plus one final check just before each cycle settles (see refreshLaunchPosts)
import { q, one } from "../db.js";
import { enabledAdapters, type SocialAdapter } from "../social/index.js";
import { mentionsToken } from "../lib/text.js";
import { SCORING } from "../scoring/scoring.js";
import { BudgetExceededError } from "../lib/budget.js";
import { log, errMsg } from "../lib/log.js";
import { config } from "../config.js";

interface Live { id: string; ticker: string; token_address: string; launched_at: Date }
interface Linked { external_id: string; handle: string; user_id: string; verified_at: Date }

export async function runTracker() {
  const live = await q<Live>("SELECT id, ticker, token_address, launched_at FROM launches WHERE status='live'");
  for (const adapter of enabledAdapters()) {
    try {
      await searchPlatform(adapter, live);
      await refreshDue(adapter);
    } catch (e) {
      if (e instanceof BudgetExceededError) log.info("tracker paused by budget", { platform: adapter.platform, reason: e.message });
      else log.warn("tracker error", { platform: adapter.platform, error: errMsg(e) });
    }
  }
}

async function searchPlatform(adapter: SocialAdapter, live: Live[]) {
  const linked = await q<Linked>(
    `SELECT la.external_id, la.handle, la.user_id, la.verified_at FROM linked_accounts la JOIN users u ON u.id = la.user_id
      WHERE la.platform = $1 AND la.verified_at IS NOT NULL AND NOT u.banned`, [adapter.platform]);
  if (!linked.length) return; // nobody to track on this platform, so spend nothing
  const byId = new Map(linked.map((l) => [l.external_id, l]));
  const byHandle = new Map(linked.map((l) => [l.handle.toLowerCase(), l]));

  for (const t of live) {
    try {
      const state = await one<{ since_id: string | null }>(
        "SELECT since_id FROM tracker_state WHERE platform=$1 AND launch_id=$2", [adapter.platform, t.id]);
      const since = new Date(Math.max(new Date(t.launched_at).getTime(), Date.now() - 24 * 3600_000));
      const found = await adapter.searchMentions({
        ticker: t.ticker, contract: t.token_address, since,
        sinceId: state?.since_id ?? undefined,
        authors: linked.map((l) => l.handle),
      });

      let added = 0;
      let newest = state?.since_id ?? null;
      for (const p of found) {
        if (adapter.platform === "x" && (!newest || BigInt(p.externalId) > BigInt(newest))) newest = p.externalId;
        const acct = byId.get(p.authorExternalId) ?? (p.authorHandle ? byHandle.get(p.authorHandle.toLowerCase()) : undefined);
        if (!acct) continue;
        if (p.postedAt < new Date(acct.verified_at)) continue;   // posts count from linking onward
        if (p.postedAt < new Date(t.launched_at)) continue;
        if (!mentionsToken(p.text, t.ticker, t.token_address, `${config.frontendOrigin}/#/token/${t.id}`)) continue;
        const url = adapter.platform === "x" ? `https://x.com/${acct.handle}/status/${p.externalId}` : p.url;
        const r = await q(
          `INSERT INTO posts (platform, external_id, launch_id, user_id, url, text, content_type, posted_at, likes, comments, shares, saves, views)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (platform, external_id, launch_id) DO NOTHING RETURNING id`,
          [adapter.platform, p.externalId, t.id, acct.user_id, url, p.text, p.contentType, p.postedAt,
           p.metrics.likes, p.metrics.comments, p.metrics.shares, p.metrics.saves, p.metrics.views]);
        added += r.length;
      }
      if (newest) {
        await q(`INSERT INTO tracker_state (platform, launch_id, since_id) VALUES ($1,$2,$3)
                 ON CONFLICT (platform, launch_id) DO UPDATE SET since_id=EXCLUDED.since_id, updated_at=now()`,
          [adapter.platform, t.id, newest]);
      }
      if (added) log.info("new posts", { platform: adapter.platform, launch: t.id, added });
    } catch (e) {
      if (e instanceof BudgetExceededError) throw e;
      log.warn("search failed", { platform: adapter.platform, launch: t.id, error: errMsg(e) });
    }
  }
}

const WINDOW = `interval '${SCORING.engagementWindowDays} days'`;
const DUE_SQL = `
  NOT deleted AND posted_at > now() - ${WINDOW} AND (
       (posted_at > now() - interval '6 hours'  AND last_fetched_at < now() - interval '1 hour')
    OR (posted_at <= now() - interval '6 hours' AND posted_at > now() - interval '48 hours' AND last_fetched_at < now() - interval '6 hours')
    OR (posted_at <= now() - interval '48 hours' AND last_fetched_at < now() - interval '24 hours'))`;

async function refreshDue(adapter: SocialAdapter) {
  const rows = await q<{ id: string; external_id: string }>(
    `SELECT id, external_id FROM posts WHERE platform = $1 AND ${DUE_SQL} ORDER BY posted_at DESC LIMIT 1000`, [adapter.platform]);
  await applyRefresh(adapter, rows);
}

/** Final engagement check for one token right before its cycle settles. */
export async function refreshLaunchPosts(launchId: string) {
  for (const adapter of enabledAdapters()) {
    const rows = await q<{ id: string; external_id: string }>(
      `SELECT id, external_id FROM posts WHERE platform = $1 AND launch_id = $2 AND NOT deleted
         AND posted_at > now() - ${WINDOW} AND last_fetched_at < now() - interval '30 minutes'`, [adapter.platform, launchId]);
    try { await applyRefresh(adapter, rows); }
    catch (e) {
      // Out of budget or API down: settle with the numbers we already have.
      log.warn("final refresh skipped", { platform: adapter.platform, launch: launchId, error: errMsg(e) });
    }
  }
}

async function applyRefresh(adapter: SocialAdapter, rows: { id: string; external_id: string }[]) {
  if (!rows.length) return;
  const metrics = await adapter.refreshMetrics([...new Set(rows.map((r) => r.external_id))]);
  for (const r of rows) {
    const m = metrics.get(r.external_id);
    if (!m) { await q("UPDATE posts SET deleted = true, last_fetched_at = now() WHERE id = $1", [r.id]); continue; }
    await q("UPDATE posts SET likes=$2, comments=$3, shares=$4, saves=$5, views=$6, last_fetched_at=now() WHERE id=$1",
      [r.id, m.likes, m.comments, m.shares, m.saves, m.views]);
  }
}
