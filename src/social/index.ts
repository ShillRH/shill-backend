import type { Platform, SocialAdapter } from "./types.js";
import { xAdapter } from "./x.js";
import { youtubeAdapter } from "./youtube.js";
import { redditAdapter } from "./reddit.js";
import { tiktokAdapter, instagramAdapter, facebookAdapter, pumpfunAdapter, fomoAdapter } from "./pending.js";

export const adapters: Record<Platform, SocialAdapter> = {
  x: xAdapter,
  youtube: youtubeAdapter,
  reddit: redditAdapter,
  tiktok: tiktokAdapter,
  instagram: instagramAdapter,
  facebook: facebookAdapter,
  pumpfun: pumpfunAdapter,
  fomo: fomoAdapter,
};

export function enabledAdapters(): SocialAdapter[] {
  return Object.values(adapters).filter((a) => a.enabled());
}
export * from "./types.js";
