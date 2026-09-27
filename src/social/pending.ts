// Platforms without a usable public API for this yet. Each needs a data provider or partnership.
//  - TikTok: Research API is restricted to approved researchers; commercial access needs a partner/data vendor.
//  - Instagram: Graph API hashtag search only works for Business/Creator accounts connected to a Facebook app.
//  - Facebook: public post search isn't available through the Graph API.
//  - pump.fun and FOMO: no official public API; use a vendor or an agreement with the platform.
// Plug a real implementation in by replacing the adapter below; the rest of the system already handles it.
import type { Platform, SocialAdapter } from "./types.js";
import { NotSupportedError } from "./types.js";

function pending(platform: Platform, why: string): SocialAdapter {
  const fail = async (): Promise<never> => { throw new NotSupportedError(`${platform}: ${why}`); };
  return { platform, enabled: () => false, searchMentions: fail, refreshMetrics: fail, getProfile: fail };
}

export const tiktokAdapter = pending("tiktok", "needs TikTok Research API access or a data vendor");
export const instagramAdapter = pending("instagram", "needs an Instagram Graph API app with hashtag search approval");
export const facebookAdapter = pending("facebook", "public post search isn't available via the Graph API");
export const pumpfunAdapter = pending("pumpfun", "no official public API");
export const fomoAdapter = pending("fomo", "no official public API");
