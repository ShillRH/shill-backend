// Market data for every token, read the same way the Pons app does: straight from the chain.
//  - Before graduation (on the Pons curve): price and graduation progress from the curve contract,
//    24h volume from the curve's own buy/sell events. Tokens show up immediately after launch.
//  - After graduation (Uniswap v4 pool): DexScreener (free, no key), which lists graduated pools.
//  - Holders: Blockscout, Robinhood Chain's official explorer.
//  - ETH/USD: DeFiLlama.
import { formatUnits, type Address } from "viem";
import { q, one } from "../db.js";
import { publicClient } from "../chain/client.js";
import { launchRecord } from "../chain/pons.js";
import { curveAbi, erc20Abi } from "../chain/ponsAbi.js";
import { usdPrice } from "../payouts/providers.js";
import { getJson, chunk } from "../social/http.js";
import { log, errMsg } from "../lib/log.js";

const DEX = "https://api.dexscreener.com/tokens/v1/robinhood";
const BLOCKSCOUT = process.env.BLOCKSCOUT_API ?? "https://robinhoodchain.blockscout.com/api/v2";
const LOG_CHUNK = 20_000n;          // the public RPC times out on wide log ranges
const MAX_SCAN_PER_RUN = 400_000n;  // catch up gradually instead of all at once

interface T { id: string; token_address: Address; pair: string; launched_at: Date }

export async function runMarket() {
  const live = await q<T>("SELECT id, token_address, pair, launched_at FROM launches WHERE status='live' AND token_address IS NOT NULL");
  if (!live.length) return;
  const head = await publicClient.getBlockNumber();
  const secsPerBlock = await blockTime(head);
  const graduated: T[] = [];

  for (const t of live) {
    try {
      const rec = await launchRecord(t.token_address);
      if (!rec.exists) { graduated.push(t); continue; }          // not a Pons v2 launch: use DexScreener
      if (rec.phase === 2 || rec.phase === 3) {
        await q("INSERT INTO token_market (launch_id, phase, progress) VALUES ($1,$2,1) ON CONFLICT (launch_id) DO UPDATE SET phase=EXCLUDED.phase, progress=1", [t.id, rec.phase]);
        graduated.push(t);
        continue;
      }
      await q("UPDATE launches SET curve_address = $2 WHERE id = $1 AND curve_address IS NULL", [t.id, rec.curve]);
      await curveMarket(t, rec.curve, rec.phase, head, secsPerBlock);
    } catch (e) {
      log.warn("curve market read failed", { token: t.id, error: errMsg(e) });
    }
  }
  await dexMarket(graduated);
  await holders(live);
}

async function blockTime(head: bigint): Promise<number> {
  const [a, b] = await Promise.all([publicClient.getBlock({ blockNumber: head }), publicClient.getBlock({ blockNumber: head - 10_000n })]);
  return Math.max(0.01, Number(a.timestamp - b.timestamp) / 10_000);
}

async function curveMarket(t: T, curve: Address, phase: number, head: bigint, secsPerBlock: number) {
  const [[quoteReserve, tokenReserve], raised, threshold, supply] = await Promise.all([
    publicClient.readContract({ address: curve, abi: curveAbi, functionName: "getReserves" }),
    publicClient.readContract({ address: curve, abi: curveAbi, functionName: "realQuoteReserve" }),
    publicClient.readContract({ address: curve, abi: curveAbi, functionName: "graduationThreshold" }),
    publicClient.readContract({ address: t.token_address, abi: erc20Abi, functionName: "totalSupply" }),
  ]);
  const quoteUsd = (await usdPrice(t.pair)) ?? 0;
  // Both sides use 18 decimals for ETH launches; stock-token pairs may differ, so scale properly.
  const priceQuote = Number(formatUnits(quoteReserve, 18)) / Number(formatUnits(tokenReserve, 18));
  const priceUsd = priceQuote * quoteUsd;
  const mcap = priceUsd * Number(formatUnits(supply, 18));
  const progress = threshold > 0n ? Math.min(1, Number(raised) / Number(threshold)) : 0;

  // index new buys/sells for volume
  const scan = await one<{ last_block: string }>("SELECT last_block FROM curve_scan WHERE launch_id=$1", [t.id]);
  const dayBlocks = BigInt(Math.ceil(86_400 / secsPerBlock));
  // First scan: start at whichever is later, 24 hours ago or the token's launch, so new tokens show volume at once.
  const sinceLaunch = BigInt(Math.max(0, Math.ceil((Date.now() - new Date(t.launched_at).getTime()) / 1000 / secsPerBlock) + 50));
  let from = scan ? BigInt(scan.last_block) + 1n : head - (sinceLaunch < dayBlocks ? sinceLaunch : dayBlocks);
  const until = from + MAX_SCAN_PER_RUN < head ? from + MAX_SCAN_PER_RUN : head;
  for (; from <= until; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n < until ? from + LOG_CHUNK - 1n : until;
    const logs = await publicClient.getLogs({ address: curve, events: curveAbi.filter((x: { type: string }) => x.type === "event"), fromBlock: from, toBlock: to });
    for (const l of logs as unknown as { eventName: string; args: Record<string, bigint>; transactionHash: string; logIndex: number; blockNumber: bigint }[]) {
      const quote = l.eventName === "CurveBuy" ? l.args.quoteIn! : l.args.quoteOut!;
      const at = new Date(Date.now() - Number(head - l.blockNumber) * secsPerBlock * 1000);
      await q(`INSERT INTO curve_trades (launch_id, tx_hash, log_index, block, side, quote_raw, at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [t.id, l.transactionHash, l.logIndex, l.blockNumber.toString(), l.eventName === "CurveBuy" ? "buy" : "sell", quote.toString(), at]);
    }
    await q(`INSERT INTO curve_scan (launch_id, last_block) VALUES ($1,$2) ON CONFLICT (launch_id) DO UPDATE SET last_block=EXCLUDED.last_block`, [t.id, to.toString()]);
  }
  const vol = await one<{ raw: string }>("SELECT COALESCE(SUM(quote_raw),0) AS raw FROM curve_trades WHERE launch_id=$1 AND at > now() - interval '24 hours'", [t.id]);
  const volumeUsd = Number(formatUnits(BigInt(vol?.raw ?? "0"), 18)) * quoteUsd;

  // 24h change from our own price history (snapshot every 5 minutes)
  const last = await one<{ recent: boolean }>("SELECT max(at) > now() - interval '5 minutes' AS recent FROM price_history WHERE launch_id=$1", [t.id]);
  if (!last?.recent && priceUsd > 0) await q("INSERT INTO price_history (launch_id, price_usd) VALUES ($1,$2) ON CONFLICT DO NOTHING", [t.id, priceUsd]);
  const old = await one<{ price_usd: number }>(
    "SELECT price_usd FROM price_history WHERE launch_id=$1 AND at <= now() - interval '23 hours' ORDER BY at DESC LIMIT 1", [t.id]);
  const first = await one<{ price_usd: number }>("SELECT price_usd FROM price_history WHERE launch_id=$1 ORDER BY at LIMIT 1", [t.id]);
  const base = old?.price_usd ?? first?.price_usd ?? 0;
  const change = base > 0 ? ((priceUsd - base) / base) * 100 : 0;

  await q(
    `INSERT INTO token_market (launch_id, mcap_usd, change_24h, volume_usd, price_usd, phase, progress, source, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'curve',now())
     ON CONFLICT (launch_id) DO UPDATE SET mcap_usd=EXCLUDED.mcap_usd, change_24h=EXCLUDED.change_24h, volume_usd=EXCLUDED.volume_usd,
       price_usd=EXCLUDED.price_usd, phase=EXCLUDED.phase, progress=EXCLUDED.progress, source='curve', updated_at=now()`,
    [t.id, mcap, change, volumeUsd, priceUsd, phase, progress]);
}

interface Pair { url: string; baseToken: { address: string }; priceUsd?: string; marketCap?: number; fdv?: number;
  priceChange?: { h24?: number }; volume?: { h24?: number }; liquidity?: { usd?: number } }

async function dexMarket(tokens: T[]) {
  const byAddr = new Map(tokens.map((t) => [t.token_address.toLowerCase(), t]));
  for (const batch of chunk(tokens, 30)) {
    try {
      const pairs = await getJson<Pair[]>(`${DEX}/${batch.map((t) => t.token_address).join(",")}`);
      const grouped = new Map<string, Pair[]>();
      for (const p of pairs ?? []) {
        const k = p.baseToken.address.toLowerCase();
        if (byAddr.has(k)) grouped.set(k, [...(grouped.get(k) ?? []), p]);
      }
      for (const [addr, ps] of grouped) {
        const main = ps.slice().sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0]!;
        await q(
          `INSERT INTO token_market (launch_id, mcap_usd, change_24h, volume_usd, price_usd, liquidity_usd, pair_url, source, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'dexscreener',now())
           ON CONFLICT (launch_id) DO UPDATE SET mcap_usd=EXCLUDED.mcap_usd, change_24h=EXCLUDED.change_24h, volume_usd=EXCLUDED.volume_usd,
             price_usd=EXCLUDED.price_usd, liquidity_usd=EXCLUDED.liquidity_usd, pair_url=EXCLUDED.pair_url, source='dexscreener', updated_at=now()`,
          [byAddr.get(addr)!.id, main.marketCap ?? main.fdv ?? 0, main.priceChange?.h24 ?? 0,
           ps.reduce((s, p) => s + (p.volume?.h24 ?? 0), 0), Number(main.priceUsd ?? 0), main.liquidity?.usd ?? 0, main.url]);
        // keep the token page chart going after graduation (snapshot every 5 minutes, like the curve)
        const id = byAddr.get(addr)!.id, price = Number(main.priceUsd ?? 0);
        const last = await one<{ recent: boolean }>("SELECT max(at) > now() - interval '5 minutes' AS recent FROM price_history WHERE launch_id=$1", [id]);
        if (!last?.recent && price > 0) await q("INSERT INTO price_history (launch_id, price_usd) VALUES ($1,$2) ON CONFLICT DO NOTHING", [id, price]);
      }
    } catch (e) {
      log.warn("dexscreener fetch failed", { error: errMsg(e) });
    }
  }
}

async function holders(tokens: T[]) {
  const stale = await q<{ launch_id: string }>(
    "SELECT l.id AS launch_id FROM launches l LEFT JOIN token_market m ON m.launch_id = l.id WHERE l.id = ANY($1) AND (m.holders_updated_at IS NULL OR m.holders_updated_at < now() - interval '15 minutes')",
    [tokens.map((t) => t.id)]);
  const want = new Set(stale.map((s) => s.launch_id));
  for (const t of tokens.filter((x) => want.has(x.id))) {
    try {
      const info = await getJson<{ holders_count?: string; holders?: string }>(`${BLOCKSCOUT}/tokens/${t.token_address}`);
      await q(`INSERT INTO token_market (launch_id, holders, holders_updated_at) VALUES ($1,$2,now())
               ON CONFLICT (launch_id) DO UPDATE SET holders=EXCLUDED.holders, holders_updated_at=now()`,
        [t.id, Number(info.holders_count ?? info.holders ?? 0)]);
    } catch (e) {
      log.warn("blockscout holders fetch failed", { token: t.id, error: errMsg(e) });
    }
  }
}
