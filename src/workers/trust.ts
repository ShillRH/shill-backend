// Recomputes every active shiller's trust score per token (docs: every 15 minutes).
import { q } from "../db.js";
import { computeTrust } from "../scoring/trust.js";
import { log, errMsg } from "../lib/log.js";

export async function runTrust() {
  const pairs = await q<{ user_id: string; launch_id: string }>(
    "SELECT DISTINCT user_id, launch_id FROM posts WHERE posted_at > now() - interval '7 days'");
  for (const { user_id, launch_id } of pairs) {
    try {
      const posts = await q<{ posted_at: Date; text: string; likes: number; comments: number; shares: number }>(
        "SELECT posted_at, text, likes, comments, shares FROM posts WHERE user_id=$1 AND launch_id=$2 AND posted_at > now() - interval '7 days'",
        [user_id, launch_id]);
      const accounts = await q<{ account_created: Date | null; followers: number | null }>(
        "SELECT account_created, followers FROM linked_accounts WHERE user_id=$1 AND verified_at IS NOT NULL", [user_id]);
      const r = computeTrust({
        now: new Date(),
        posts: posts.map((p) => ({ postedAt: new Date(p.posted_at), text: p.text, likes: p.likes, comments: p.comments, shares: p.shares })),
        accounts: accounts.map((a) => ({ createdAt: a.account_created ? new Date(a.account_created) : undefined, followers: a.followers ?? undefined })),
        // lowQualityEngagementShare / selfEngagementDetected: supply these when your data provider
        // exposes who engaged (e.g. X liking_users / retweeted_by endpoints).
      });
      await q(
        `INSERT INTO trust (user_id, launch_id, score, level, signals, updated_at) VALUES ($1,$2,$3,$4,$5,now())
         ON CONFLICT (user_id, launch_id) DO UPDATE SET score=EXCLUDED.score, level=EXCLUDED.level, signals=EXCLUDED.signals, updated_at=now()`,
        [user_id, launch_id, r.score, r.level, JSON.stringify(r.signals)]);
    } catch (e) {
      log.warn("trust failed", { user: user_id, launch: launch_id, error: errMsg(e) });
    }
  }
}
