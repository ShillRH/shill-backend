// X (Twitter) API v2, pay-per-use. Every call goes through the monthly budget in lib/budget.ts.
//
// Cost controls:
//  - Several tokens share one search query, and each search starts after the newest post already
//    seen (since_id), so each post is found once.
//  - X bills a post or user once per UTC day however often it's read, and the budget counts it the
//    same way, so frequent engagement refreshes don't multiply the cost.
import { config } from "../config.js";
import type { ContentType, Metrics } from "../scoring/scoring.js";
import { reserveX, chargeX, costOf, type Purpose } from "../lib/budget.js";
import { getJson, chunk } from "./http.js";
import { tokenTerm } from "./xquery.js";
import type { XAuthor } from "./xshillers.js";
import type { FoundPost, Profile, SocialAdapter } from "./types.js";

const API = "https://api.x.com/2";
const auth = () => ({ headers: { Authorization: `Bearer ${config.x.bearer}` } });
const PAGE = 100;
const MAX_PAGES = Math.max(1, Number(process.env.X_SEARCH_MAX_PAGES ?? 5));

interface Tweet {
  id: string; text: string; author_id: string; created_at: string;
  public_metrics: { like_count: number; reply_count: number; retweet_count: number; quote_count: number; bookmark_count?: number; impression_count?: number };
  attachments?: { media_keys?: string[] };
}
interface XUser { id: string; username: string; created_at: string; public_metrics: { followers_count: number } }
interface Media { media_key: string; type: string; duration_ms?: number }
interface SearchResp {
  data?: Tweet[];
  includes?: { users?: XUser[]; media?: Media[] };
  meta?: { next_token?: string; newest_id?: string };
}

function metricsOf(t: Tweet): Metrics {
  const m = t.public_metrics;
  return { likes: m.like_count, comments: m.reply_count, shares: m.retweet_count + m.quote_count, saves: m.bookmark_count ?? 0, views: m.impression_count ?? 0 };
}

function contentTypeOf(t: Tweet, media: Map<string, Media>): ContentType {
  const kinds = (t.attachments?.media_keys ?? []).map((k) => media.get(k)).filter(Boolean);
  const video = kinds.find((m) => m!.type === "video");
  if (video) return (video.duration_ms ?? 0) >= 180_000 ? "long" : "short";
  return kinds.length ? "image" : "text";
}

const authorOf = (u: XUser): XAuthor =>
  ({ id: u.id, username: u.username, followers: u.public_metrics?.followers_count ?? 0, createdAt: new Date(u.created_at) });

export interface XFound extends FoundPost { author?: XAuthor }

/** One search query, newest first, up to MAX_PAGES pages. Returns the posts and the newest id seen. */
export async function searchX(query: string, from: { sinceId?: string; startTime?: Date }): Promise<{ posts: XFound[]; newestId?: string }> {
  const posts: XFound[] = [];
  let next: string | undefined, newestId: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      query, max_results: String(PAGE),
      "tweet.fields": "created_at,public_metrics,author_id,attachments",
      expansions: "author_id,attachments.media_keys",
      "user.fields": "username,created_at,public_metrics",
      "media.fields": "type,duration_ms",
    });
    if (from.sinceId) params.set("since_id", from.sinceId);
    else if (from.startTime) params.set("start_time", from.startTime.toISOString());
    if (next) params.set("next_token", next);
    await reserveX(costOf(PAGE, PAGE), "search");
    const r = await getJson<SearchResp>(`${API}/tweets/search/recent?${params}`, auth());
    await chargeX("search", (r.data ?? []).map((t) => t.id), (r.includes?.users ?? []).map((u) => u.id));
    const media = new Map((r.includes?.media ?? []).map((m) => [m.media_key, m]));
    const users = new Map((r.includes?.users ?? []).map((u) => [u.id, u]));
    for (const t of r.data ?? []) {
      if (!newestId || BigInt(t.id) > BigInt(newestId)) newestId = t.id;
      const u = users.get(t.author_id);
      posts.push({
        externalId: t.id, authorExternalId: t.author_id, authorHandle: u?.username ?? "",
        url: u ? `https://x.com/${u.username}/status/${t.id}` : `https://x.com/i/status/${t.id}`,
        text: t.text, postedAt: new Date(t.created_at), contentType: contentTypeOf(t, media), metrics: metricsOf(t),
        author: u ? authorOf(u) : undefined,
      });
    }
    next = r.meta?.next_token;
    if (!next) break;
  }
  return { posts, newestId };
}

export const xAdapter: SocialAdapter = {
  platform: "x",
  enabled: () => Boolean(config.x.bearer),

  // The tracker searches X for many tokens at once with searchX; this is the one-token version.
  async searchMentions({ ticker, contract, since, sinceId }) {
    const term = tokenTerm(ticker, contract);
    if (!term) return [];
    return (await searchX(`(${term}) -is:retweet`, { sinceId, startTime: since })).posts;
  },

  async refreshMetrics(ids) {
    const out = new Map<string, Metrics>();
    for (const batch of chunk(ids, 100)) {
      const params = new URLSearchParams({ ids: batch.join(","), "tweet.fields": "public_metrics" });
      await reserveX(costOf(batch.length, 0), "refresh");
      const r = await getJson<{ data?: Tweet[] }>(`${API}/tweets?${params}`, auth());
      await chargeX("refresh", (r.data ?? []).map((t) => t.id));
      for (const t of r.data ?? []) out.set(t.id, metricsOf(t));
    }
    return out;
  },

  // Shillers are identified by the author of their posts, so profile lookups aren't needed.
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
  const r = await getJson<{ data?: Tweet; includes?: { users?: XUser[]; media?: Media[] } }>(`${API}/tweets/${encodeURIComponent(id)}?${params}`, auth());
  await chargeX("search", r.data ? [r.data.id] : [], (r.includes?.users ?? []).map((u) => u.id));
  const t = r.data;
  const u = r.includes?.users?.find((x) => x.id === t?.author_id);
  if (!t || !u) return null;
  const media = new Map((r.includes?.media ?? []).map((m) => [m.media_key, m]));
  return {
    externalId: t.id, authorExternalId: t.author_id, authorHandle: u.username, authorUsername: u.username,
    url: `https://x.com/${u.username}/status/${t.id}`, text: t.text, postedAt: new Date(t.created_at),
    contentType: contentTypeOf(t, media), metrics: metricsOf(t),
    authorFollowers: u.public_metrics.followers_count, authorCreatedAt: new Date(u.created_at),
  };
}
