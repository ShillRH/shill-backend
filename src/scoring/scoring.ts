// $SHILL scoring, exactly as published in the docs:
//   Post points = Interaction points × Content bonus × Trust score
// Pure functions only: no database or network access, so they're easy to test.

export const SCORING = {
  like: 1,
  save: 2,
  comment: 3,
  share: 5,
  perThousandViews: 1,
  contentBonus: { text: 1, image: 1.2, thread: 1.3, short: 1.5, long: 2 } as Record<ContentType, number>,
  postCap: 10_000,          // max points one post can ever earn (before trust)
  postsPerDay: 10,          // best N posts per platform per UTC day count
  minWords: 5,              // real words besides ticker/CA/links
  engagementWindowDays: 7,  // engagement stops counting after this
};

export type ContentType = "text" | "image" | "thread" | "short" | "long";

export interface Metrics {
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  views: number;
}

/** Interaction points before content bonus and trust. */
export function interactionPoints(m: Metrics): number {
  return (
    m.likes * SCORING.like +
    m.saves * SCORING.save +
    m.comments * SCORING.comment +
    m.shares * SCORING.share +
    Math.floor(m.views / 1000) * SCORING.perThousandViews
  );
}

/**
 * A post's lifetime "raw" points: interaction points × content bonus, capped.
 * Trust is applied later, per cycle, because it can change over time.
 */
export function rawPostPoints(m: Metrics, type: ContentType): number {
  const bonus = SCORING.contentBonus[type] ?? 1;
  return Math.min(SCORING.postCap, interactionPoints(m) * bonus);
}

export interface ScorablePost {
  id: number | string;
  userId: number | string;
  platform: string;
  postedAt: Date;
  realWords: number;
  deleted: boolean;
  contentType: ContentType;
  metrics: Metrics;
  /** Raw points already paid out in earlier cycles. */
  creditedRaw: number;
}

export interface PostScore {
  id: ScorablePost["id"];
  userId: ScorablePost["userId"];
  eligible: boolean;
  reason?: string;
  rawTotal: number;   // lifetime raw points now
  rawDelta: number;   // raw points earned since last cycle (what this cycle pays for)
}

/**
 * Scores every post for one token for the cycle ending at `now`.
 * Rules applied:
 *  - deleted posts and posts under the minimum word count earn nothing
 *  - engagement arriving more than 7 days after posting doesn't count
 *    (we simply stop crediting new points; the tracker also stops refreshing)
 *  - only a user's best N posts per platform per UTC day count
 *  - each cycle pays only for points gained since the previous cycle
 */
export function scorePosts(posts: ScorablePost[], now: Date): PostScore[] {
  const windowMs = SCORING.engagementWindowDays * 86_400_000;
  const base: PostScore[] = posts.map((p) => {
    if (p.deleted) return { id: p.id, userId: p.userId, eligible: false, reason: "deleted", rawTotal: 0, rawDelta: 0 };
    if (p.realWords < SCORING.minWords)
      return { id: p.id, userId: p.userId, eligible: false, reason: "too_short", rawTotal: 0, rawDelta: 0 };
    const rawTotal = rawPostPoints(p.metrics, p.contentType);
    const expired = now.getTime() - p.postedAt.getTime() > windowMs;
    const rawDelta = expired ? 0 : Math.max(0, rawTotal - p.creditedRaw);
    return { id: p.id, userId: p.userId, eligible: true, rawTotal, rawDelta };
  });

  // Daily limit: best N posts (by lifetime raw points) per user + platform + UTC day.
  const groups = new Map<string, number[]>();
  posts.forEach((p, i) => {
    if (!base[i]!.eligible) return;
    const key = `${p.userId}|${p.platform}|${p.postedAt.toISOString().slice(0, 10)}`;
    const arr = groups.get(key) ?? [];
    arr.push(i);
    groups.set(key, arr);
  });
  for (const idxs of groups.values()) {
    if (idxs.length <= SCORING.postsPerDay) continue;
    idxs.sort((a, b) => base[b]!.rawTotal - base[a]!.rawTotal);
    for (const i of idxs.slice(SCORING.postsPerDay)) {
      base[i] = { ...base[i]!, eligible: false, reason: "daily_limit", rawDelta: 0 };
    }
  }
  return base;
}

export interface UserCycleScore {
  userId: ScorablePost["userId"];
  points: number;        // after trust
  interactions: number;  // raw interaction count (for display)
}

/** Sums a cycle's points per user and applies each user's trust score. */
export function userCycleScores(
  scores: PostScore[],
  trustByUser: Map<ScorablePost["userId"], number>,
  interactionsByUser: Map<ScorablePost["userId"], number> = new Map(),
): UserCycleScore[] {
  const sums = new Map<ScorablePost["userId"], number>();
  for (const s of scores) {
    if (!s.eligible || s.rawDelta <= 0) continue;
    sums.set(s.userId, (sums.get(s.userId) ?? 0) + s.rawDelta);
  }
  const out: UserCycleScore[] = [];
  for (const [userId, raw] of sums) {
    const trust = clampTrust(trustByUser.get(userId) ?? 1);
    const points = Math.round(raw * trust);
    if (points > 0) out.push({ userId, points, interactions: interactionsByUser.get(userId) ?? 0 });
  }
  return out.sort((a, b) => b.points - a.points);
}

export function clampTrust(t: number): number {
  if (!Number.isFinite(t)) return 0;
  return t < 0.5 ? 0 : Math.min(1, t); // below 0.5 = Blocked = 0
}
