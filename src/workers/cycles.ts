// Settles each token's payout cycles on a fixed grid from launch.
//
// Two kinds of tokens:
//  - managed: launched through the site. Creator fees go to the platform fee wallet; the backend sweeps,
//    claims and pays out each token's own fees (see workers/fees.ts).
//  - external: added by an admin (e.g. $SHILL launched via Proxima). The fee wallet is yours, so when a
//    cycle ends it waits in "awaiting_fees". You claim the fees yourself, then call
//    POST /admin/tokens/:id/settle with the amount, and the backend ranks shillers and builds the payout list.
//
// Safety rules (managed tokens):
//  - The split is written to the database BEFORE any transfer.
//  - A failed transfer marks the cycle "failed" and pauses the token until an operator resolves it.
//    Transfers are never retried automatically, so nobody can be paid twice.
import { type Address } from "viem";
import { config } from "../config.js";
import { q, one, tx } from "../db.js";
import { decimalsOf, sendFromFeeWallet } from "../chain/pons.js";
import { sweepAndRecord, claimAll } from "./fees.js";
import { feeWalletAddress } from "../chain/feeWallet.js";
import { dueCycles } from "../payouts/cycles.js";
import { splitFees } from "../payouts/split.js";
import { toUsd, usdPrice } from "../payouts/providers.js";
import { standings } from "../scoring/standings.js";
import { refreshLaunchPosts } from "./tracker.js";
import { log, errMsg } from "../lib/log.js";

export interface LiveToken { id: string; ticker: string; token_address: Address; pair: string; pair_address: Address | null; top_n: number; cycle_seconds: number;
  launched_at: Date; wallet_address: Address; wallet_key_enc: string | null; managed: boolean }

const LIVE_SQL = `SELECT l.id, l.ticker, l.token_address, l.pair, l.pair_address, l.top_n, l.cycle_seconds, l.launched_at, l.wallet_address, l.wallet_key_enc, l.managed
                    FROM launches l WHERE l.status = 'live'`;

export async function runCycles() {
  const live = await q<LiveToken>(`${LIVE_SQL}
      AND NOT EXISTS (SELECT 1 FROM cycles c WHERE c.launch_id = l.id AND c.status IN ('failed','settling','awaiting_fees'))`);
  for (const l of live) {
    const last = await one<{ idx: number }>("SELECT COALESCE(MAX(idx), -1) AS idx FROM cycles WHERE launch_id=$1 AND status='settled'", [l.id]);
    const next = dueCycles(new Date(l.launched_at), l.cycle_seconds, new Date(), last?.idx ?? -1)[0];
    if (!next) continue;
    if (!l.managed) {
      await q(`INSERT INTO cycles (launch_id, idx, starts_at, ends_at, status) VALUES ($1,$2,$3,$4,'awaiting_fees')
               ON CONFLICT (launch_id, idx) DO NOTHING`, [l.id, next.idx, next.startsAt, next.endsAt]);
      log.info("cycle ended, waiting for fee amount", { launch: l.id, cycle: next.idx });
      continue;
    }
    await settleManaged(l, next.idx, next.startsAt, next.endsAt);
  }
}

async function settleManaged(l: LiveToken, idx: number, startsAt: Date, endsAt: Date) {
  if (!config.treasuryAddress || !config.payoutFundingAddress) {
    log.error("TREASURY_ADDRESS and PAYOUT_FUNDING_ADDRESS must be set before cycles can settle");
    return;
  }
  const cycle = await one<{ id: string }>(
    `INSERT INTO cycles (launch_id, idx, starts_at, ends_at, status) VALUES ($1,$2,$3,$4,'settling')
     ON CONFLICT (launch_id, idx) DO UPDATE SET status='settling', error=NULL WHERE cycles.status = 'open' RETURNING id`,
    [l.id, idx, startsAt, endsAt]);
  if (!cycle) return;
  const fail = async (msg: string) => {
    await q("UPDATE cycles SET status='failed', error=$2 WHERE id=$1", [cycle.id, msg]);
    log.error("cycle failed, needs operator review", { launch: l.id, cycle: idx, error: msg });
  };
  try {
    // 1. collect this token's latest fees and move the escrow into the fee wallet
    await sweepAndRecord(l.id, l.token_address);
    await claimAll(true);

    // 2. this cycle pays out everything recorded for this token that hasn't been paid yet
    const open = await q<{ id: string; amount_raw: string }>(
      "SELECT id, amount_raw FROM fee_ledger WHERE launch_id=$1 AND cycle_id IS NULL AND asset='ETH'", [l.id]);
    const fees = open.reduce((s, r) => s + BigInt(r.amount_raw), 0n);

    const { burn, newlyAllocated } = await recordSplit(l, cycle.id, endsAt, fees, null);
    await q("UPDATE fee_ledger SET cycle_id=$2 WHERE id = ANY($1::bigint[])", [open.map((r) => r.id), cycle.id]);

    // 3. move money from the fee wallet (recorded above first, so a failure can't cause double payment)
    try {
      // If the treasury or payout wallet IS the fee wallet, the money is already there: skip the transfer.
      const self = feeWalletAddress().toLowerCase();
      if (burn > 0n && config.treasuryAddress.toLowerCase() !== self) await sendFromFeeWallet(config.treasuryAddress as Address, burn, null);
      if (newlyAllocated > 0n && config.payoutFundingAddress.toLowerCase() !== self)
        await sendFromFeeWallet(config.payoutFundingAddress as Address, newlyAllocated, null);
    } catch (e) {
      return fail(`Transfer failed after the split was recorded: ${errMsg(e)}`);
    }
    await q("UPDATE cycles SET status='settled', settled_at=now() WHERE id=$1", [cycle.id]);
    log.info("cycle settled", { launch: l.id, cycle: idx, fees: fees.toString() });
  } catch (e) {
    await fail(errMsg(e));
  }
}

/** Settles an external token's oldest waiting cycle with the fee amount you claimed yourself. No funds are moved. */
export async function settleExternal(launchId: string, feesRaw: bigint) {
  const l = await one<LiveToken>(`${LIVE_SQL} AND l.id = $1`, [launchId]);
  if (!l) throw new Error("Token not found or not live.");
  if (l.managed) throw new Error("This token is managed by $SHILL and settles automatically.");
  const cycle = await one<{ id: string; idx: number; ends_at: Date }>(
    "SELECT id, idx, ends_at FROM cycles WHERE launch_id=$1 AND status='awaiting_fees' ORDER BY idx LIMIT 1", [launchId]);
  if (!cycle) throw new Error("No cycle is waiting for fees right now.");
  await q("UPDATE cycles SET status='settling' WHERE id=$1", [cycle.id]);
  try {
    const { burn, pool, payouts } = await recordSplit(l, cycle.id, new Date(cycle.ends_at), feesRaw, null);
    await q("UPDATE cycles SET status='settled', settled_at=now() WHERE id=$1", [cycle.id]);
    return { cycle: cycle.idx, feesRaw: feesRaw.toString(), burnRaw: burn.toString(), poolRaw: pool.toString(), payouts };
  } catch (e) {
    await q("UPDATE cycles SET status='awaiting_fees', error=$2 WHERE id=$1", [cycle.id, errMsg(e)]);
    throw e;
  }
}

/** Ranks shillers, splits `fees`, and records ranks, payouts, post credits and the burn allocation. */
async function recordSplit(l: LiveToken, cycleId: string, endsAt: Date, fees: bigint, claimTx: string | null) {
  await refreshLaunchPosts(l.id);
  const { standings: ranked, scores } = await standings(l.id, endsAt);

  const decimals = await decimalsOf(l.pair_address);
  const px = await usdPrice(l.pair);
  const minAmount = px ? BigInt(Math.floor((config.minPayoutUsd / px) * 10 ** decimals)) : 0n;
  const carried = await q<{ user_id: string; amount: string }>(
    "SELECT user_id, SUM(amount_raw) AS amount FROM payouts WHERE launch_id=$1 AND status='carried' GROUP BY user_id", [l.id]);
  const carryIn = new Map(carried.map((c) => [c.user_id, BigInt(c.amount)]));

  const split = splitFees(fees, ranked.map((r) => ({ userId: r.userId, points: r.points })),
    { platformFeePct: config.platformFeePct, topN: l.top_n, minAmount, carryIn });
  const newlyAllocated = split.payouts.reduce((s, p) => s + p.amount - (carryIn.get(String(p.userId)) ?? 0n), 0n);

  const payoutRows: { handle: string; rank: number; points: number; amountRaw: string; amountUsd: number | null; status: string }[] = [];
  const handles = new Map(ranked.map((r) => [r.userId, r.handle]));
  await tx(async (c) => {
    await c.query("UPDATE cycles SET fees_raw=$2, burn_raw=$3, pool_raw=$4, claim_tx=$5 WHERE id=$1",
      [cycleId, fees.toString(), split.burn.toString(), split.pool.toString(), claimTx]);
    for (const [i, r] of ranked.entries()) {
      await c.query("INSERT INTO cycle_ranks (cycle_id, user_id, rank, points, interactions) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [cycleId, r.userId, i + 1, r.points, r.interactions]);
    }
    await c.query("UPDATE payouts SET status='merged' WHERE launch_id=$1 AND status='carried' AND user_id = ANY($2::bigint[])",
      [l.id, split.payouts.map((p) => String(p.userId))]);
    for (const p of split.payouts) {
      const usd = await toUsd(l.pair, p.amount, decimals);
      await c.query(
        "INSERT INTO payouts (cycle_id, launch_id, user_id, rank, points, amount_raw, amount_usd, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [cycleId, l.id, p.userId, p.rank, p.points, p.amount.toString(), usd, p.status]);
      payoutRows.push({ handle: handles.get(String(p.userId)) ?? "", rank: p.rank, points: p.points, amountRaw: p.amount.toString(), amountUsd: usd, status: p.status });
    }
    for (const s of scores) {
      if (!s.eligible) continue;
      await c.query(
        `INSERT INTO post_credit (post_id, credited_raw) VALUES ($1,$2)
         ON CONFLICT (post_id) DO UPDATE SET credited_raw = GREATEST(post_credit.credited_raw, EXCLUDED.credited_raw)`,
        [s.id, s.rawTotal]);
    }
    if (split.burn > 0n) {
      await c.query("INSERT INTO burn_queue (launch_id, asset, amount_raw) VALUES ($1,$2,$3)",
        [l.id, l.pair_address ?? "ETH", split.burn.toString()]);
    }
  });
  return { burn: split.burn, pool: split.pool, newlyAllocated, payouts: payoutRows };
}
