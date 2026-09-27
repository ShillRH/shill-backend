import type { ContentType, Metrics } from "../scoring/scoring.js";

export type Platform = "x" | "tiktok" | "instagram" | "youtube" | "reddit" | "facebook" | "pumpfun" | "fomo";
export const PLATFORMS: Platform[] = ["x", "tiktok", "instagram", "youtube", "reddit", "facebook", "pumpfun", "fomo"];

export interface FoundPost {
  externalId: string;
  authorExternalId: string;
  authorHandle: string;
  url: string;
  text: string;
  postedAt: Date;
  contentType: ContentType;
  metrics: Metrics;
}

export interface Profile {
  externalId: string;
  handle: string;
  bio: string;              // where users paste their verification code
  followers?: number;
  createdAt?: Date;
}

export interface SocialAdapter {
  platform: Platform;
  /** True when credentials are configured and the platform is supported. */
  enabled(): boolean;
  /**
   * Public posts mentioning the token since `since`.
   * `sinceId`: only return posts newer than this id (platforms that support it).
   * `authors`: only return posts from these handles (platforms that support it) to save API cost.
   */
  searchMentions(q: { ticker: string; contract: string | null; since: Date; sinceId?: string; authors?: string[] }): Promise<FoundPost[]>;
  /** Fresh metrics for posts we already track. Missing ids = deleted/unavailable. */
  refreshMetrics(externalIds: string[]): Promise<Map<string, Metrics>>;
  /** Public profile, used to verify ownership via a code in the bio. */
  getProfile(handle: string): Promise<Profile | null>;
}

export class NotSupportedError extends Error {}
