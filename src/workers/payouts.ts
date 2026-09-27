// Sends queued payouts through the configured payout provider (manual CSV queue by default).
import { q } from "../db.js";
import { payoutProvider } from "../payouts/providers.js";
import { log, errMsg } from "../lib/log.js";

export async function runPayouts() {
  if (payoutProvider.name === "manual") return; // handled via /admin/payouts.csv
  const queued = await q<{ id: string; x_user_id: string; x_handle: string; amount_usd: number | null; ticker: string; idx: number }>(
    `SELECT p.id, u.x_user_id, u.x_handle, p.amount_usd, l.ticker, c.idx
       FROM payouts p JOIN users u ON u.id = p.user_id JOIN launches l ON l.id = p.launch_id JOIN cycles c ON c.id = p.cycle_id
      WHERE p.status = 'queued' AND p.amount_usd IS NOT NULL AND NOT u.banned ORDER BY p.created_at LIMIT 200`);
  for (const p of queued) {
    try {
      const ref = await payoutProvider.send({ payoutId: Number(p.id), xUserId: p.x_user_id, xHandle: p.x_handle,
        amountUsd: p.amount_usd!, memo: `$SHILL payout: $${p.ticker} cycle ${p.idx}` });
      if (ref) await q("UPDATE payouts SET status='sent', sent_at=now(), provider_ref=$2 WHERE id=$1", [p.id, ref]);
    } catch (e) {
      await q("UPDATE payouts SET status='failed' WHERE id=$1", [p.id]);
      log.error("payout failed", { payout: p.id, error: errMsg(e) });
    }
  }
}
