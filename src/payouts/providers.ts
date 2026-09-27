// Payout, pricing and buyback plug-ins.
//
// X Money: at the time of writing we couldn't confirm a public API for automated bulk payouts.
// Until you have one, payouts are queued and exported as CSV (GET /admin/payouts.csv),
// sent by your team, then marked as sent (POST /admin/payouts/mark-sent).
// When X Money (or another payout rail) gives you an API, implement PayoutProvider and
// switch `payoutProvider` below. Nothing else needs to change.

import { config } from "../config.js";

export interface PayoutRequest { payoutId: number; xUserId: string; xHandle: string; amountUsd: number; memo: string }
export interface PayoutProvider {
  name: string;
  /** Return a provider reference if sent, or null to leave it queued for manual handling. */
  send(p: PayoutRequest): Promise<string | null>;
}

export const manualQueue: PayoutProvider = {
  name: "manual",
  async send() { return null; },
};

export const payoutProvider: PayoutProvider = manualQueue;

// ---------- pricing ----------
// ETH/USD comes from DeFiLlama (free, no key; the Pons app uses it too), cached for a minute.
// Other assets (stock tokens) can be pinned with PRICE_OVERRIDES={"TSLA":250} until a feed is added.
let ethCache: { at: number; px: number } | null = null;
export async function usdPrice(asset: string): Promise<number | null> {
  try {
    const overrides = JSON.parse(process.env.PRICE_OVERRIDES ?? "{}") as Record<string, number>;
    if (overrides[asset] !== undefined) return overrides[asset]!;
  } catch { /* ignore malformed overrides */ }
  if (asset !== "ETH") return null;
  if (ethCache && Date.now() - ethCache.at < 60_000) return ethCache.px;
  try {
    const r = await fetch("https://coins.llama.fi/prices/current/coingecko:ethereum");
    const j = (await r.json()) as { coins?: Record<string, { price: number }> };
    const px = j.coins?.["coingecko:ethereum"]?.price;
    if (px) { ethCache = { at: Date.now(), px }; return px; }
  } catch { /* fall through */ }
  return ethCache?.px ?? null;
}

export async function toUsd(asset: string, raw: bigint, decimals: number): Promise<number | null> {
  const px = await usdPrice(asset);
  if (px === null) return null;
  return (Number(raw) / 10 ** decimals) * px;
}

// ---------- buyback & burn ----------
// Each cycle's burn share is sent to TREASURY_ADDRESS and queued in burn_queue.
// Implement buyAndBurn with the treasury's signer and your route of choice (the Pons curve while
// $SHILL is on its bonding curve, its Uniswap v4 pool after graduation), then send the bought
// $SHILL to BURN_ADDRESS. Until then, burns stay "pending" and are listed at /admin/burns.
export interface BuybackProvider {
  buyAndBurn(asset: string, amountRaw: bigint): Promise<{ swapTx: string; burnTx: string; shillBurned: bigint } | null>;
}
export const buyback: BuybackProvider = {
  async buyAndBurn() { return null; },
};

export function burnConfigured(): boolean {
  return Boolean(config.shillToken && config.treasuryAddress);
}
