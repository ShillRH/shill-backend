// How a cycle's creator fees are divided. All amounts are bigint base units of the pair asset.
//  1. platformFeePct (20%) → buyback & burn
//  2. the rest → shillers' pool
//  3. pool split among the top N by points: share = points / total points of the paid spots
//  4. shares below the minimum are carried to that user's next payout instead of sent now
//  5. rounding dust stays in the launch wallet and is included in the next cycle

export interface RankedUser { userId: number | string; points: number }

export interface SplitResult {
  burn: bigint;
  pool: bigint;
  payouts: { userId: RankedUser["userId"]; rank: number; points: number; amount: bigint; status: "queued" | "carried" }[];
  dust: bigint;
}

const SCALE = 1_000_000_000n; // precision for points → bigint shares

export function splitFees(
  fees: bigint,
  ranked: RankedUser[],
  opts: { platformFeePct: number; topN: number; minAmount: bigint; carryIn?: Map<RankedUser["userId"], bigint> },
): SplitResult {
  if (fees < 0n) throw new Error("fees must be >= 0");
  const burn = (fees * BigInt(Math.round(opts.platformFeePct * 100))) / 10_000n;
  const pool = fees - burn;

  const paid = ranked
    .filter((u) => u.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, opts.topN);
  const totalPts = paid.reduce((s, u) => s + u.points, 0);

  const payouts: SplitResult["payouts"] = [];
  let distributed = 0n;
  if (totalPts > 0 && pool > 0n) {
    const totalScaled = BigInt(Math.round(totalPts * Number(SCALE)));
    paid.forEach((u, i) => {
      const scaled = BigInt(Math.round(u.points * Number(SCALE)));
      const amount = (pool * scaled) / totalScaled;
      distributed += amount;
      const withCarry = amount + (opts.carryIn?.get(u.userId) ?? 0n);
      payouts.push({
        userId: u.userId,
        rank: i + 1,
        points: u.points,
        amount: withCarry,
        status: withCarry >= opts.minAmount ? "queued" : "carried",
      });
    });
  }
  // Nobody eligible: the whole pool stays for the next cycle.
  const dust = pool - distributed;
  return { burn, pool, payouts, dust };
}
