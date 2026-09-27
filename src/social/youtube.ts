// YouTube Data API v3. Free with quota limits (search costs 100 units per call).
import { config } from "../config.js";
import type { ContentType, Metrics } from "../scoring/scoring.js";
import { getJson, chunk } from "./http.js";
import type { FoundPost, SocialAdapter } from "./types.js";

const API = "https://www.googleapis.com/youtube/v3";

interface Video {
  id: string;
  snippet: { title: string; description: string; channelId: string; channelTitle: string; publishedAt: string };
  statistics: { viewCount?: string; likeCount?: string; commentCount?: string };
  contentDetails: { duration: string };
}

function seconds(iso: string): number {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
}
function metricsOf(v: Video): Metrics {
  return {
    likes: Number(v.statistics.likeCount ?? 0),
    comments: Number(v.statistics.commentCount ?? 0),
    shares: 0, // YouTube doesn't expose shares
    saves: 0,
    views: Number(v.statistics.viewCount ?? 0),
  };
}

async function videos(ids: string[]): Promise<Video[]> {
  const out: Video[] = [];
  for (const batch of chunk(ids, 50)) {
    const p = new URLSearchParams({ part: "snippet,statistics,contentDetails", id: batch.join(","), key: config.youtubeKey });
    out.push(...((await getJson<{ items: Video[] }>(`${API}/videos?${p}`)).items ?? []));
  }
  return out;
}

export const youtubeAdapter: SocialAdapter = {
  platform: "youtube",
  enabled: () => Boolean(config.youtubeKey),

  async searchMentions({ ticker, contract, since }) {
    const q = [`$${ticker}`, contract].filter(Boolean).join("|");
    const p = new URLSearchParams({ part: "id", q, type: "video", order: "date", maxResults: "50", publishedAfter: since.toISOString(), key: config.youtubeKey });
    const r = await getJson<{ items: { id: { videoId: string } }[] }>(`${API}/search?${p}`);
    const found = await videos(r.items.map((i) => i.id.videoId));
    return found.map((v): FoundPost => {
      const secs = seconds(v.contentDetails.duration);
      const contentType: ContentType = secs >= 180 ? "long" : "short";
      return {
        externalId: v.id,
        authorExternalId: v.snippet.channelId,
        authorHandle: v.snippet.channelTitle,
        url: `https://www.youtube.com/watch?v=${v.id}`,
        text: `${v.snippet.title}\n${v.snippet.description}`,
        postedAt: new Date(v.snippet.publishedAt),
        contentType,
        metrics: metricsOf(v),
      };
    });
  },

  async refreshMetrics(ids) {
    return new Map((await videos(ids)).map((v) => [v.id, metricsOf(v)]));
  },

  async getProfile(handle) {
    const p = new URLSearchParams({ part: "snippet,statistics", forHandle: handle.startsWith("@") ? handle : `@${handle}`, key: config.youtubeKey });
    const r = await getJson<{ items?: { id: string; snippet: { title: string; description: string; publishedAt: string }; statistics: { subscriberCount?: string } }[] }>(`${API}/channels?${p}`);
    const c = r.items?.[0];
    if (!c) return null;
    return { externalId: c.id, handle, bio: c.snippet.description, followers: Number(c.statistics.subscriberCount ?? 0), createdAt: new Date(c.snippet.publishedAt) };
  },
};
