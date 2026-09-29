// Finds new shill posts on every enabled platform and keeps their engagement up to date.
//  - X: every run (each minute) searches for ANY public post that mentions a live token's $TICKER or
//    contract address, from anyone. Authors become shillers automatically; no link or sign-up needed.
//    Several tokens share one query, and each search starts after the newest post already seen.
//  - Engagement on every tracked post is re-checked every X_REFRESH_MINUTES (default 5) for its
//    7-day window, plus one final check just before each cycle settles (see refreshLaunchPosts).
//    X bills a post once per UTC day however often it's read, so frequent refreshes stay cheap.
//  - Other platforms only track accounts that are already linked.
import { q, one } from "../db.js";
import { enabledAdapters, type SocialAdapter } from "../social/index.js";
import { searchX, type XFound } from "../social/x.js";
import { packQueries, tokenTerm } from "../social/xquery.js";
import { upsertXShiller } from "../social/xshillers.js";
import { mentionsToken, realWordCount } from "../lib/text.js";
import { SCORING } from "../scoring/scoring.js";
import { BudgetExceededError, pruneXBilled } from "../lib/budget.js";
import { log, errMsg } from "../lib/log.js";
import { config } from "../config.js";

const REFRESH_MINUTES = Math.max(1, Math.round(Number(process.env.X_REFRESH_MINUTES ?? 5)) || 5);

interface Live { id: string; ticker: string; token_address: string; launched_at: Date }
interface Linked { external_id: string; handle: string; user_id: string; verified_at: Date }

export async function runTracker() {
  const live = await q<Live>("SELECT id, ticker, token_address, launched_at FROM launches WHERE status='live'");
  for (const adapter of enabledAdapters()) {
    try {
      if (adapter.platform === "x") { await pruneXBilled(); await searchXAll(live); }
      else await searchPlatform(adapter, live);
      await refreshDue(adapter);
    } catch (e) {
      if (e instanceof BudgetExceededError) log.info("tracker paused by budget", { platform: adapter.platform, reason: e.message });
      else log.warn("tracker error", { platform: adapter.platform, error: errMsg(e) });
    }
  }
}

/** X: open search for every live token, packed into as few queries as fit. */
async function searchXAll(live: Live[]) {
  const items = live.flatMap((t) => { const term = tokenTerm(t.ticker, t.token_address); return term ? [{ key: t, term }] : []; });
  if (!items.length) return;
  const states = new Map((await q<{ launch_id: string; since_id: string | null }>(
    "SELECT launch_id, since_id FROM tracker_state WHERE platform='x'")).map((r) => [r.launch_id, r.since_id]));
  const shillers = new Map<string, string | null>(); // X user id -> shiller id (null = banned), per run

  for (const { query, keys: tokens } of packQueries(items)) {
    try {
      // Start after the oldest "newest seen" in the group. A token with no history yet starts from
      // its launch (at most 24 hours back). Posts read again the same day aren't billed again.
      const ids = tokens.map((t) => states.get(t.id) ?? null);
      const sinceId = ids.every(Boolean) ? ids.reduce((a, b) => (BigInt(a!) < BigInt(b!) ? a : b))! : undefined;
      const startTime = new Date(Math.min(...tokens.map((t) => Math.max(new Date(t.launched_at).getTime(), Date.now() - 24 * 3600_000))));
      const { posts, newestId } = await searchX(query, sinceId ? { sinceId } : { startTime });

      let added = 0;
      for (const p of posts) added += await addXPost(p, tokens, shillers);
      if (newestId) {
        for (const t of tokens) {
          const prev = states.get(t.id);
          if (prev && BigInt(prev) >= BigInt(newestId)) continue;
          await q(`INSERT INTO tracker_state (platform, launch_id, since_id) VALUES ('x',$1,$2)
                   ON CONFLICT (platform, launch_id) DO UPDATE SET since_id=EXCLUDED.since_id, updated_at=now()`, [t.id, newestId]);
        }
      }
      if (added) log.info("new posts", { platform: "x", tokens: tokens.map((t) => t.id), added });
    } catch (e) {
      if (e instanceof BudgetExceededError) throw e;
      log.warn("search failed", { platform: "x", tokens: tokens.map((t) => t.id), error: errMsg(e) });
    }
  }
}

/** Files one found X post under every token in the group it qualifies for. Returns how many were added. */
async function addXPost(p: XFound, tokens: Live[], shillers: Map<string, string | null>): Promise<number> {
  if (!p.author) return 0;
  if (realWordCount(p.text) < SCORING.minWords) return 0;                     // same bar as submitted posts
  if (Date.now() - p.postedAt.getTime() > SCORING.engagementWindowDays * 86_400_000) return 0;
  const matches = tokens.filter((t) => p.postedAt >= new Date(t.launched_at)
    && mentionsToken(p.text, t.ticker, t.token_address, `${config.frontendOrigin}/#/token/${t.id}`));
  if (!matches.length) return 0;

  if (!shillers.has(p.author.id)) shillers.set(p.author.id, (await upsertXShiller(p.author))?.id ?? null);
  const userId = shillers.get(p.author.id);
  if (!userId) return 0; // banned

  let added = 0;
  for (const t of matches) {
    const r = await q(
      `INSERT INTO posts (platform, external_id, launch_id, user_id, url, text, content_type, posted_at, likes, comments, shares, saves, views)
       VALUES ('x',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (platform, external_id, launch_id) DO NOTHING RETURNING id`,
      [p.externalId, t.id, userId, p.url, p.text, p.contentType, p.postedAt,
       p.metrics.likes, p.metrics.comments, p.metrics.shares, p.metrics.saves, p.metrics.views]);
    added += r.length;
  }
  return added;
}

/** Other platforms: only posts from accounts that are already linked. */
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
  NOT deleted AND posted_at > now() - ${WINDOW} AND last_fetched_at < now() - interval '${REFRESH_MINUTES} minutes'`;

async function refreshDue(adapter: SocialAdapter) {
  const rows = await q<{ id: string; external_id: string }>(
    `SELECT id, external_id FROM posts WHERE platform = $1 AND ${DUE_SQL} ORDER BY last_fetched_at LIMIT 1000`, [adapter.platform]);
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
