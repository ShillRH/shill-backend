// X (Twitter) API v2, pay-per-use. Every call goes through the monthly budget in lib/budget.ts.
//
// Cost controls:
//  - Searches only look for posts from linked $SHILL accounts (from: filters), so we never pay
//    to read posts from people who can't earn.
//  - Searches use since_id, so each post is found once instead of on every pass.
//  - No author-profile expansion (profiles are billed separately); we match authors by id.
import { config } from "../config.js";
import type { ContentType, Metrics } from "../scoring/scoring.js";
import { reserveX, chargeX, costOf, type Purpose } from "../lib/budget.js";
import { getJson, chunk } from "./http.js";
import { buildQueries } from "./xquery.js";
import type { FoundPost, Profile, SocialAdapter } from "./types.js";

const API = "https://api.x.com/2";
const auth = () => ({ headers: { Authorization: `Bearer ${config.x.bearer}` } });
const PAGE = 100;

interface Tweet {
  id: string; text: string; author_id: string; created_at: string;
  public_metrics: { like_count: number; reply_count: number; retweet_count: number; quote_count: number; bookmark_count?: number; impression_count?: number };
  attachments?: { media_keys?: string[] };
}
interface SearchResp {
  data?: Tweet[];
  includes?: { media?: { media_key: string; type: string; duration_ms?: number }[] };
  meta?: { next_token?: string; newest_id?: string };
}

function metricsOf(t: Tweet): Metrics {
  const m = t.public_metrics;
  return { likes: m.like_count, comments: m.reply_count, shares: m.retweet_count + m.quote_count, saves: m.bookmark_count ?? 0, views: m.impression_count ?? 0 };
}

async function metered<T extends { data?: unknown[] }>(url: string, purpose: Purpose, maxPosts: number): Promise<T> {
  await reserveX(costOf(maxPosts, 0), purpose);
  const r = await getJson<T>(url, auth());
  await chargeX(purpose, r.data?.length ?? 0);
  return r;
}

export const xAdapter: SocialAdapter = {
  platform: "x",
  enabled: () => Boolean(config.x.bearer),

  async searchMentions({ ticker, contract, since, sinceId, authors }) {
    const terms = [`$${ticker}`, contract ? `"${contract}"` : null].filter(Boolean).join(" OR ");
    const queries = buildQueries(`(${terms}) -is:retweet`, (authors ?? []).map((a) => a.replace(/^@/, "")));
    const out: FoundPost[] = [];
    for (const query of queries) {
      let next: string | undefined;
      for (let page = 0; page < 5; page++) {
        const params = new URLSearchParams({
          query, max_results: String(PAGE),
          "tweet.fields": "created_at,public_metrics,author_id,attachments",
          expansions: "attachments.media_keys", "media.fields": "type,duration_ms",
        });
        if (sinceId) params.set("since_id", sinceId); else params.set("start_time", since.toISOString());
        if (next) params.set("next_token", next);
        const r = await metered<SearchResp>(`${API}/tweets/search/recent?${params}`, "search", PAGE);
        const media = new Map((r.includes?.media ?? []).map((m) => [m.media_key, m]));
        for (const t of r.data ?? []) {
          const kinds = (t.attachments?.media_keys ?? []).map((k) => media.get(k)).filter(Boolean);
          const video = kinds.find((m) => m!.type === "video");
          let contentType: ContentType = "text";
          if (video) contentType = (video.duration_ms ?? 0) >= 180_000 ? "long" : "short";
          else if (kinds.length) contentType = "image";
          out.push({
            externalId: t.id, authorExternalId: t.author_id, authorHandle: "",
            url: `https://x.com/i/status/${t.id}`, text: t.text, postedAt: new Date(t.created_at),
            contentType, metrics: metricsOf(t),
          });
        }
        next = r.meta?.next_token;
        if (!next) break;
      }
    }
    return out;
  },

  async refreshMetrics(ids) {
    const out = new Map<string, Metrics>();
    for (const batch of chunk(ids, 100)) {
      const params = new URLSearchParams({ ids: batch.join(","), "tweet.fields": "public_metrics" });
      const r = await metered<{ data?: Tweet[] }>(`${API}/tweets?${params}`, "refresh", batch.length);
      for (const t of r.data ?? []) out.set(t.id, metricsOf(t));
    }
    return out;
  },

  // X accounts are linked with Sign in with X, so profile lookups aren't needed for verification.
  async getProfile(): Promise<Profile | null> { return null; },
};

/** Looks up one post plus its author (used when someone submits a post link). Costs 1 post + 1 user read. */
export async function fetchXPost(id: string): Promise<(FoundPost & { authorFollowers: number; authorCreatedAt: Date; authorUsername: string }) | null> {
  const params = new URLSearchParams({
    "tweet.fields": "created_at,public_metrics,author_id,attachments",
    expansions: "author_id,attachments.media_keys",
    "user.fields": "username,created_at,public_metrics",
    "media.fields": "type,duration_ms",
  });
  await reserveX(costOf(1, 1), "search");
  const r = await getJson<{
    data?: Tweet;
    includes?: { users?: { id: string; username: string; created_at: string; public_metrics: { followers_count: number } }[];
                 media?: { media_key: string; type: string; duration_ms?: number }[] };
  }>(`${API}/tweets/${encodeURIComponent(id)}?${params}`, auth());
  await chargeX("search", r.data ? 1 : 0, r.includes?.users?.length ?? 0);
  const t = r.data;
  const u = r.includes?.users?.find((x) => x.id === t?.author_id);
  if (!t || !u) return null;
  const media = new Map((r.includes?.media ?? []).map((m) => [m.media_key, m]));
  const kinds = (t.attachments?.media_keys ?? []).map((k) => media.get(k)).filter(Boolean);
  const video = kinds.find((m) => m!.type === "video");
  const contentType: ContentType = video ? ((video.duration_ms ?? 0) >= 180_000 ? "long" : "short") : kinds.length ? "image" : "text";
  return {
    externalId: t.id, authorExternalId: t.author_id, authorHandle: u.username, authorUsername: u.username,
    url: `https://x.com/${u.username}/status/${t.id}`, text: t.text, postedAt: new Date(t.created_at),
    contentType, metrics: metricsOf(t),
    authorFollowers: u.public_metrics.followers_count, authorCreatedAt: new Date(u.created_at),
  };
}

