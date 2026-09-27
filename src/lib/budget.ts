// Hard monthly spending cap for the X API (pay-per-use).
//
// Prices (September 2026): $0.005 per post read, $0.010 per user read. Check X's pricing page and
// update X_PRICES if they change. Spend is counted from what each response actually returned.
//
// How the budget is shared:
//   - Searching for new posts may use up to X_SEARCH_SHARE (80%) of the budget.
//   - The last 20% is kept for refreshing engagement (so cycles can still settle) and sign-ins.
//   - At 100%, every X call stops until the next month. Nothing is ever spent past the cap.

import { q, one } from "../db.js";
import { log } from "./log.js";

import { canSpend, costOf, type Purpose } from "./budget-rules.js";
export { X_PRICES, canSpend, costOf, type Purpose } from "./budget-rules.js";

export class BudgetExceededError extends Error {}

export function xBudgetUsd(): number {
  const n = Number(process.env.X_MONTHLY_BUDGET_USD ?? 50);
  return Number.isFinite(n) && n >= 0 ? n : 50;
}
function searchShare(): number {
  const n = Number(process.env.X_SEARCH_SHARE ?? 0.8);
  return n > 0 && n <= 1 ? n : 0.8;
}


const month = () => new Date().toISOString().slice(0, 7);

export async function xSpentThisMonth(): Promise<number> {
  const r = await one<{ spent: string }>("SELECT COALESCE(SUM(cost_usd),0) AS spent FROM api_usage WHERE month=$1 AND platform='x'", [month()]);
  return Number(r?.spent ?? 0);
}

/** Throws BudgetExceededError if a call costing up to `estimate` would break the cap. */
export async function reserveX(estimate: number, purpose: Purpose): Promise<void> {
  const spent = await xSpentThisMonth();
  if (!canSpend(spent, xBudgetUsd(), estimate, purpose, searchShare())) {
    throw new BudgetExceededError(
      `X budget: $${spent.toFixed(2)} of $${xBudgetUsd()} used this month; skipping ${purpose} (needs up to $${estimate.toFixed(2)}).`);
  }
}

/** Records what a call actually returned. */
export async function chargeX(purpose: Purpose, postReads: number, userReads = 0): Promise<void> {
  if (!postReads && !userReads) return;
  await q(
    `INSERT INTO api_usage (month, platform, purpose, post_reads, user_reads, cost_usd) VALUES ($1,'x',$2,$3,$4,$5)
     ON CONFLICT (month, platform, purpose) DO UPDATE SET post_reads = api_usage.post_reads + EXCLUDED.post_reads,
       user_reads = api_usage.user_reads + EXCLUDED.user_reads, cost_usd = api_usage.cost_usd + EXCLUDED.cost_usd`,
    [month(), purpose, postReads, userReads, costOf(postReads, userReads)]);
  const spent = await xSpentThisMonth();
  const budget = xBudgetUsd();
  if (spent >= budget * 0.8) log.warn("X budget running low", { spent: Number(spent.toFixed(2)), budget });
}

export async function xUsageSummary() {
  const rows = await q<{ purpose: string; post_reads: string; user_reads: string; cost_usd: string }>(
    "SELECT purpose, post_reads, user_reads, cost_usd FROM api_usage WHERE month=$1 AND platform='x'", [month()]);
  const spent = rows.reduce((s, r) => s + Number(r.cost_usd), 0);
  return {
    month: month(),
    budgetUsd: xBudgetUsd(),
    spentUsd: Number(spent.toFixed(4)),
    remainingUsd: Number(Math.max(0, xBudgetUsd() - spent).toFixed(4)),
    searchPaused: spent >= xBudgetUsd() * searchShare(),
    allPaused: spent >= xBudgetUsd(),
    byPurpose: rows.map((r) => ({ purpose: r.purpose, postReads: Number(r.post_reads), userReads: Number(r.user_reads), costUsd: Number(r.cost_usd) })),
  };
}
