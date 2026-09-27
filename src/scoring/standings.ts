// Loads a token's posts + trust from the database and runs the pure scoring engine.
// Used by the live leaderboard (API) and by cycle settlement (worker).
import { q } from "../db.js";
import { realWordCount } from "../lib/text.js";
import { scorePosts, userCycleScores, type ContentType, type PostScore, type ScorablePost } from "./scoring.js";

export interface Standing {
  userId: string;
  handle: string;
  points: number;
  posts: number;
  likes: number;
  replies: number;   // comments, named to match the frontend
  reposts: number;   // shares
  interactions: number;
  trust: number;
  level: string;
}

interface Row {
  id: string; user_id: string; platform: string; posted_at: Date; text: string; deleted: boolean; content_type: ContentType;
  likes: number; comments: number; shares: number; saves: number; views: string; credited_raw: number | null;
}

export async function standings(launchId: string, now = new Date()): Promise<{ standings: Standing[]; scores: PostScore[] }> {
  const rows = await q<Row>(
    `SELECT p.id, p.user_id, p.platform, p.posted_at, p.text, p.deleted, p.content_type,
            p.likes, p.comments, p.shares, p.saves, p.views, pc.credited_raw
       FROM posts p
       JOIN users u ON u.id = p.user_id AND NOT u.banned
       LEFT JOIN post_credit pc ON pc.post_id = p.id
      WHERE p.launch_id = $1 AND p.posted_at > now() - interval '8 days'`,
    [launchId],
  );
  const posts: ScorablePost[] = rows.map((r) => ({
    id: r.id, userId: r.user_id, platform: r.platform, postedAt: new Date(r.posted_at),
    realWords: realWordCount(r.text), deleted: r.deleted, contentType: r.content_type,
    metrics: { likes: r.likes, comments: r.comments, shares: r.shares, saves: r.saves, views: Number(r.views) },
    creditedRaw: r.credited_raw ?? 0,
  }));
  const scores = scorePosts(posts, now);

  const trustRows = await q<{ user_id: string; score: number; level: string }>(
    "SELECT user_id, score, level FROM trust WHERE launch_id = $1", [launchId]);
  const trust = new Map(trustRows.map((t) => [t.user_id, t.score]));
  const levels = new Map(trustRows.map((t) => [t.user_id, t.level]));

  const agg = new Map<string, { posts: number; likes: number; replies: number; reposts: number }>();
  posts.forEach((p, i) => {
    if (!scores[i]!.eligible) return;
    const a = agg.get(String(p.userId)) ?? { posts: 0, likes: 0, replies: 0, reposts: 0 };
    a.posts++; a.likes += p.metrics.likes; a.replies += p.metrics.comments; a.reposts += p.metrics.shares;
    agg.set(String(p.userId), a);
  });
  const interactions = new Map([...agg].map(([k, a]) => [k, a.likes + a.replies + a.reposts]));
  const users = userCycleScores(scores, trust as Map<string | number, number>, interactions as Map<string | number, number>);

  const ids = users.map((u) => String(u.userId));
  const handles = ids.length
    ? new Map((await q<{ id: string; x_handle: string }>("SELECT id, x_handle FROM users WHERE id = ANY($1::bigint[])", [ids])).map((u) => [u.id, u.x_handle]))
    : new Map<string, string>();

  return {
    scores,
    standings: users.map((u) => {
      const id = String(u.userId), a = agg.get(id)!;
      return { userId: id, handle: handles.get(id) ?? "", points: u.points, ...a, interactions: u.interactions,
        trust: trust.get(id) ?? 1, level: levels.get(id) ?? "clear" };
    }),
  };
}
