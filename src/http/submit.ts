// Post submission: no sign-in needed. A shiller pastes their X post link on a token page.
// We read the post from X, check it mentions the token, and credit its author. The author's
// X account is their $SHILL identity and payout destination (X Money), so submitting someone
// else's post can only ever credit that person. After the first submission, the tracker also
// finds that author's future posts automatically.
import { q, one } from "../db.js";
import { config } from "../config.js";
import { fetchXPost } from "../social/x.js";
import { BudgetExceededError } from "../lib/budget.js";
import { mentionsToken, realWordCount } from "../lib/text.js";
import { SCORING } from "../scoring/scoring.js";
import { rateLimit } from "../lib/ratelimit.js";
import { route, HttpError, str } from "./router.js";

const X_URL = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{5,25})/i;

route("POST", "/tokens/:id/submit", async (ctx) => {
  rateLimit(ctx.req, "submit", 20, 3600_000, "Too many submissions from this connection. Try again in a bit.");
  const url = str((ctx.body as Record<string, unknown>)?.url, "Post link", 300);
  const m = X_URL.exec(url);
  if (!m) throw new HttpError(400, "Paste a link to an X post, like https://x.com/you/status/123…");
  const postId = m[2]!;

  const t = await one<{ id: string; ticker: string; token_address: string; launched_at: Date }>(
    "SELECT id, ticker, token_address, launched_at FROM launches WHERE id = $1 AND status = 'live'", [ctx.params.id]);
  if (!t) throw new HttpError(404, "Token not found.");

  const dupe = await one("SELECT 1 FROM posts WHERE platform='x' AND external_id=$1 AND launch_id=$2", [postId, t.id]);
  if (dupe) return { ok: true, message: "That post is already being tracked." };

  let p;
  try { p = await fetchXPost(postId); }
  catch (e) {
    if (e instanceof BudgetExceededError) throw new HttpError(503, "Post tracking is paused until next month's budget resets.");
    throw new HttpError(502, "We couldn't reach X just now. Try again in a minute.");
  }
  if (!p) throw new HttpError(404, "We couldn't find that post. Make sure it's public and not deleted.");
  if (p.postedAt < new Date(t.launched_at)) throw new HttpError(400, `That post was made before $${t.ticker} launched.`);
  if (Date.now() - p.postedAt.getTime() > SCORING.engagementWindowDays * 86_400_000)
    throw new HttpError(400, "Posts older than 7 days can't be added.");
  if (!mentionsToken(p.text, t.ticker, t.token_address, `${config.frontendOrigin}/#/token/${t.id}`))
    throw new HttpError(400, `That post doesn't mention $${t.ticker} or its contract address.`);
  if (realWordCount(p.text) < SCORING.minWords)
    throw new HttpError(400, `Posts need at least ${SCORING.minWords} real words besides the ticker or address to count.`);

  const user = await one<{ id: string; banned: boolean }>(
    `INSERT INTO users (x_user_id, x_handle) VALUES ($1,$2)
     ON CONFLICT (x_user_id) DO UPDATE SET x_handle = EXCLUDED.x_handle RETURNING id, banned`,
    [p.authorExternalId, p.authorUsername]);
  if (!user) throw new Error("user upsert failed");
  if (user.banned) throw new HttpError(403, "This account can't earn on $SHILL.");
  await q(
    `INSERT INTO linked_accounts (user_id, platform, handle, external_id, followers, account_created, verified_at)
     VALUES ($1,'x',$2,$3,$4,$5, to_timestamp(0))
     ON CONFLICT (user_id, platform) DO UPDATE SET handle=EXCLUDED.handle, followers=EXCLUDED.followers, account_created=EXCLUDED.account_created`,
    [user.id, p.authorUsername, p.authorExternalId, p.authorFollowers, p.authorCreatedAt]);
  await q(
    `INSERT INTO posts (platform, external_id, launch_id, user_id, url, text, content_type, posted_at, likes, comments, shares, saves, views)
     VALUES ('x',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
    [p.externalId, t.id, user.id, p.url, p.text, p.contentType, p.postedAt,
     p.metrics.likes, p.metrics.comments, p.metrics.shares, p.metrics.saves, p.metrics.views]);
  return { ok: true, handle: p.authorUsername,
    message: `Added. @${p.authorUsername}'s post now counts, and their future posts about $${t.ticker} are picked up automatically.` };
});
