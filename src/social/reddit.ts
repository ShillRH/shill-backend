// Reddit API (OAuth, app-only). Tracks posts; comment search isn't offered by the official API.
import { config } from "../config.js";
import type { ContentType, Metrics } from "../scoring/scoring.js";
import { getJson, chunk } from "./http.js";
import type { FoundPost, SocialAdapter } from "./types.js";

let token: { value: string; exp: number } | null = null;
async function bearer(): Promise<string> {
  if (token && token.exp > Date.now() + 60_000) return token.value;
  const basic = Buffer.from(`${config.reddit.clientId}:${config.reddit.clientSecret}`).toString("base64");
  const r = await getJson<{ access_token: string; expires_in: number }>("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", "User-Agent": config.reddit.userAgent },
    body: "grant_type=client_credentials",
  });
  token = { value: r.access_token, exp: Date.now() + r.expires_in * 1000 };
  return token.value;
}
async function api<T>(path: string): Promise<T> {
  return getJson<T>(`https://oauth.reddit.com${path}`, { headers: { Authorization: `Bearer ${await bearer()}`, "User-Agent": config.reddit.userAgent } });
}

interface RPost { data: { name: string; id: string; author: string; author_fullname?: string; title: string; selftext: string; permalink: string; created_utc: number;
  score: number; num_comments: number; num_crossposts: number; is_video: boolean; post_hint?: string; removed_by_category?: string | null } }

function metricsOf(p: RPost["data"]): Metrics {
  return { likes: Math.max(0, p.score), comments: p.num_comments, shares: p.num_crossposts, saves: 0, views: 0 };
}
function typeOf(p: RPost["data"]): ContentType {
  if (p.is_video) return "short";
  if (p.post_hint === "image") return "image";
  return p.selftext.split(/\s+/).length > 120 ? "thread" : "text";
}

export const redditAdapter: SocialAdapter = {
  platform: "reddit",
  enabled: () => Boolean(config.reddit.clientId && config.reddit.clientSecret),

  async searchMentions({ ticker, contract, since }) {
    const q = [`"$${ticker}"`, contract ? `"${contract}"` : null].filter(Boolean).join(" OR ");
    const r = await api<{ data: { children: RPost[] } }>(`/search?${new URLSearchParams({ q, sort: "new", limit: "100", type: "link" })}`);
    return r.data.children
      .map((c) => c.data)
      .filter((p) => p.created_utc * 1000 >= since.getTime() && !p.removed_by_category)
      .map((p): FoundPost => ({
        externalId: p.name,
        authorExternalId: p.author_fullname ?? p.author,
        authorHandle: p.author,
        url: `https://www.reddit.com${p.permalink}`,
        text: `${p.title}\n${p.selftext}`,
        postedAt: new Date(p.created_utc * 1000),
        contentType: typeOf(p),
        metrics: metricsOf(p),
      }));
  },

  async refreshMetrics(ids) {
    const out = new Map<string, Metrics>();
    for (const batch of chunk(ids, 100)) {
      const r = await api<{ data: { children: RPost[] } }>(`/api/info?id=${batch.join(",")}`);
      for (const c of r.data.children) if (!c.data.removed_by_category) out.set(c.data.name, metricsOf(c.data));
    }
    return out;
  },

  async getProfile(handle) {
    try {
      const r = await api<{ data: { id: string; name: string; created_utc: number; subreddit?: { public_description?: string; subscribers?: number } } }>(
        `/user/${encodeURIComponent(handle.replace(/^u\//, ""))}/about`);
      return { externalId: `t2_${r.data.id}`, handle: r.data.name, bio: r.data.subreddit?.public_description ?? "",
        followers: r.data.subreddit?.subscribers, createdAt: new Date(r.data.created_utc * 1000) };
    } catch { return null; }
  },
};
