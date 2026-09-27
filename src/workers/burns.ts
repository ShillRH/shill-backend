// Runs the $SHILL buyback & burn for everything in burn_queue.
import { q } from "../db.js";
import { buyback, burnConfigured } from "../payouts/providers.js";
import { log, errMsg } from "../lib/log.js";

export async function runBurns() {
  if (!burnConfigured()) return;
  const pending = await q<{ id: string; asset: string; amount_raw: string }>(
    "SELECT id, asset, amount_raw FROM burn_queue WHERE status='pending' ORDER BY created_at LIMIT 50");
  for (const b of pending) {
    try {
      const r = await buyback.buyAndBurn(b.asset, BigInt(b.amount_raw));
      if (!r) return; // provider not implemented yet: leave everything pending
      await q("UPDATE burn_queue SET status='done', swap_tx=$2, burn_tx=$3, shill_burned=$4 WHERE id=$1",
        [b.id, r.swapTx, r.burnTx, r.shillBurned.toString()]);
      log.info("burned", { id: b.id, shill: r.shillBurned.toString() });
    } catch (e) {
      await q("UPDATE burn_queue SET status='failed' WHERE id=$1", [b.id]);
      log.error("burn failed", { id: b.id, error: errMsg(e) });
    }
  }
}
