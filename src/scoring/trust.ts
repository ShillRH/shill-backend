// Trust score, as published in the docs. Everyone starts at 1.0; each signal that fires
// takes points off. The result multiplies all of a user's points for the token.
// Pure function: the caller gathers the inputs from the database.

import { similarity } from "../lib/text.js";

export type SignalId =
  | "volume_50_24h"
  | "bot_engagement"
  | "new_account"
  | "burst_posting"
  | "near_duplicates"
  | "like_heavy"
  | "low_followers"
  | "self_engagement";

export const SIGNALS: Record<SignalId, { penalty: number; label: string; behavioral: boolean }> = {
  volume_50_24h:   { penalty: 0.40, label: "More than 50 posts about one token in 24 hours", behavioral: false },
  bot_engagement:  { penalty: 0.30, label: "Engagement mostly from new, empty or bot-like accounts", behavioral: false },
  new_account:     { penalty: 0.25, label: "Linked account under 30 days old", behavioral: false },
  burst_posting:   { penalty: 0.25, label: "5 or more posts within one minute", behavioral: true },
  near_duplicates: { penalty: 0.20, label: "3 or more near-identical posts", behavioral: true },
  like_heavy:      { penalty: 0.20, label: "Lots of likes with no comments or shares", behavioral: false },
  low_followers:   { penalty: 0.15, label: "Linked account with fewer than 25 followers", behavioral: false },
  self_engagement: { penalty: 0.15, label: "Engaging with your own posts from another linked account", behavioral: false },
};

export type TrustLevel = "clear" | "watch" | "limited" | "blocked";

export interface TrustInput {
  now: Date;
  /** Posts by this user about this token (any platform). */
  posts: { postedAt: Date; text: string; likes: number; comments: number; shares: number }[];
  /** Each linked account's age and followers (undefined when the platform doesn't expose it). */
  accounts: { createdAt?: Date; followers?: number }[];
  /** Optional: share of engagement coming from low-quality accounts (0..1), if your data provider supplies it. */
  lowQualityEngagementShare?: number;
  /** Optional: true if one of the user's linked accounts engaged with another of their posts. */
  selfEngagementDetected?: boolean;
}

export interface TrustResult {
  score: number;
  level: TrustLevel;
  signals: SignalId[];
}

const DAY = 86_400_000;

export function computeTrust(input: TrustInput): TrustResult {
  const fired = new Set<SignalId>();
  const now = input.now.getTime();

  // Volume: more than 50 posts about the token in the last 24 hours
  const last24 = input.posts.filter((p) => now - p.postedAt.getTime() <= DAY);
  if (last24.length > 50) fired.add("volume_50_24h");

  // Burst: 5+ posts within any 60-second window
  const times = input.posts.map((p) => p.postedAt.getTime()).sort((a, b) => a - b);
  for (let i = 0; i + 4 < times.length; i++) {
    if (times[i + 4]! - times[i]! <= 60_000) { fired.add("burst_posting"); break; }
  }

  // Near-duplicates: 3+ posts that are ≥ 90% similar to each other
  const texts = input.posts.map((p) => p.text).filter((t) => t.trim().length > 0);
  outer: for (let i = 0; i < texts.length; i++) {
    let matches = 1;
    for (let j = 0; j < texts.length; j++) {
      if (i !== j && similarity(texts[i]!, texts[j]!) >= 0.9) matches++;
      if (matches >= 3) { fired.add("near_duplicates"); break outer; }
    }
  }

  // Like-heavy: any post with 200+ likes and zero comments and shares
  if (input.posts.some((p) => p.likes >= 200 && p.comments === 0 && p.shares === 0)) fired.add("like_heavy");

  // Account age and followers (the weakest linked account counts)
  if (input.accounts.some((a) => a.createdAt && now - a.createdAt.getTime() < 30 * DAY)) fired.add("new_account");
  if (input.accounts.some((a) => a.followers !== undefined && a.followers < 25)) fired.add("low_followers");

  if ((input.lowQualityEngagementShare ?? 0) >= 0.5) fired.add("bot_engagement");
  if (input.selfEngagementDetected) fired.add("self_engagement");

  let score = 1;
  for (const s of fired) score -= SIGNALS[s].penalty;

  // Established accounts (60+ days, 100+ followers) can't drop below Watch (0.75)
  // from posting speed or wording alone.
  const established =
    input.accounts.length > 0 &&
    input.accounts.every(
      (a) => a.createdAt && now - a.createdAt.getTime() >= 60 * DAY && (a.followers ?? 0) >= 100,
    );
  const onlyBehavioral = [...fired].every((s) => SIGNALS[s].behavioral);
  if (established && fired.size > 0 && onlyBehavioral) score = Math.max(score, 0.75);

  score = Math.max(0, Math.round(score * 100) / 100);
  return { score, level: levelFor(score), signals: [...fired] };
}

export function levelFor(score: number): TrustLevel {
  if (score >= 1) return "clear";
  if (score >= 0.75) return "watch";
  if (score >= 0.5) return "limited";
  return "blocked";
}
