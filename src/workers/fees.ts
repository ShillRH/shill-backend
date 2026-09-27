// Collects creator fees for every token launched through the site into the platform fee wallet,
// keeping a per-token record (fee_ledger) so each token's shillers are paid from that token's fees only.
//
// All launches share one fee wallet, and Pons credits that wallet's escrow as one balance. To know which
// token each amount came from, we sweep one token at a time and record how much the escrow grew.
// If Pons's own automation sweeps something first, it can't be attributed; it's recorded as
// "unattributed" for you to assign from the admin API.
import { parseEther, type Address } from "viem";
import { q, one } from "../db.js";
import { sweepToken, escrowOf, claimEscrow } from "../chain/pons.js";
import { log, errMsg } from "../lib/log.js";

const CLAIM_MIN = parseEther(process.env.FEE_CLAIM_MIN_ETH ?? "0.0005");

async function known(): Promise<bigint> {
  return BigInt((await one<{ escrow_known: string }>("SELECT escrow_known FROM fee_wallet_state WHERE id=1"))?.escrow_known ?? "0");
}
async function setKnown(v: bigint) {
  await q("UPDATE fee_wallet_state SET escrow_known=$1, updated_at=now() WHERE id=1", [v.toString()]);
}

/** Records anything that reached the escrow without us sweeping it. */
async function catchUnattributed(): Promise<bigint> {
  const escrow = await escrowOf(null);
  const k = await known();
  if (escrow > k) {
    await q("INSERT INTO fee_ledger (launch_id, amount_raw, source) VALUES (NULL,$1,'unattributed')", [(escrow - k).toString()]);
    log.warn("unattributed fees arrived in escrow", { amount: (escrow - k).toString() });
  }
  await setKnown(escrow);
  return escrow;
}

/** Sweeps one token's fees into escrow and records them. */
export async function sweepAndRecord(launchId: string, token: Address): Promise<bigint> {
  await catchUnattributed();
  const r = await sweepToken(token);
  if (r.amount > 0n) {
    await q("INSERT INTO fee_ledger (launch_id, amount_raw, source, tx_hash) VALUES ($1,$2,'sweep',$3)", [launchId, r.amount.toString(), r.tx]);
    await setKnown((await known()) + r.amount);
  }
  return r.amount;
}

/** Moves the escrow balance into the fee wallet itself. */
export async function claimAll(force = false) {
  await catchUnattributed();
  const escrow = await escrowOf(null);
  if (escrow === 0n || (!force && escrow < CLAIM_MIN)) return;
  await claimEscrow(null);
  await setKnown(0n);
  log.info("claimed escrow into fee wallet", { amount: escrow.toString() });
}

export async function runFees() {
  const live = await q<{ id: string; token_address: Address }>(
    "SELECT id, token_address FROM launches WHERE status='live' AND managed AND token_address IS NOT NULL");
  for (const t of live) {
    try { await sweepAndRecord(t.id, t.token_address); }
    catch (e) { log.warn("fee sweep failed", { launch: t.id, error: errMsg(e) }); }
  }
  try { await claimAll(); } catch (e) { log.warn("escrow claim failed", { error: errMsg(e) }); }
}
