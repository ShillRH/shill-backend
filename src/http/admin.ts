// Admin endpoints for running payouts manually until an automated payout rail is connected.
// Every request needs:  Authorization: Bearer <ADMIN_TOKEN>
import { timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { q } from "../db.js";
import { route, HttpError, send, type Ctx } from "./router.js";
import { xUsageSummary } from "../lib/budget.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { CYCLE_SECONDS, STOCK_PAIRS } from "../config.js";
import { publicClient } from "../chain/client.js";
import { settleExternal } from "../workers/cycles.js";
import { isAddress } from "./router.js";
import { feeWalletAddress } from "../chain/feeWallet.js";
import { launchRecord } from "../chain/pons.js";
import { tokenInfoAbi } from "../chain/ponsAbi.js";

function requireAdmin(ctx: Ctx) {
  const given = Buffer.from((ctx.req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(config.adminToken());
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new HttpError(401, "Admin token required.");
}

const csv = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

// Queued payouts, ready to send through X Money.
route("GET", "/admin/payouts.csv", async (ctx) => {
  requireAdmin(ctx);
  const status = ctx.query.get("status") ?? "queued";
  const rows = await q<{ id: string; x_handle: string; x_user_id: string; ticker: string; idx: number; rank: number; points: number; amount_raw: string; pair: string; amount_usd: number | null; created_at: Date }>(
    `SELECT p.id, u.x_handle, u.x_user_id, l.ticker, c.idx, p.rank, p.points, p.amount_raw, l.pair, p.amount_usd, p.created_at
       FROM payouts p JOIN users u ON u.id = p.user_id JOIN launches l ON l.id = p.launch_id JOIN cycles c ON c.id = p.cycle_id
      WHERE p.status = $1 ORDER BY p.created_at`, [status]);
  const header = "payout_id,x_handle,x_user_id,token,cycle,rank,points,amount_raw,asset,amount_usd,created_at";
  const body = rows.map((r) => [r.id, r.x_handle, r.x_user_id, r.ticker, r.idx, r.rank, r.points, r.amount_raw, r.pair, r.amount_usd ?? "", r.created_at.toISOString()].map(csv).join(","));
  send(ctx.res, 200, [header, ...body].join("\n"), { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="payouts-${status}.csv"` });
});

// Mark payouts as sent after paying them. Body: { ids: number[], ref?: string, amountsUsd?: {id: usd} }
route("POST", "/admin/payouts/mark-sent", async (ctx) => {
  requireAdmin(ctx);
  const b = (ctx.body ?? {}) as { ids?: unknown; ref?: unknown; amountsUsd?: Record<string, number> };
  if (!Array.isArray(b.ids) || !b.ids.length) throw new HttpError(400, "ids is required.");
  const ids = b.ids.map(Number).filter(Number.isInteger);
  await q(`UPDATE payouts SET status='sent', sent_at=now(), provider_ref=$2 WHERE id = ANY($1::bigint[]) AND status IN ('queued','failed')`,
    [ids, typeof b.ref === "string" ? b.ref : null]);
  for (const [id, usd] of Object.entries(b.amountsUsd ?? {})) {
    await q("UPDATE payouts SET amount_usd = $2 WHERE id = $1", [id, usd]);
  }
  return { ok: true, updated: ids.length };
});

route("GET", "/admin/burns", async (ctx) => {
  requireAdmin(ctx);
  return q("SELECT id, launch_id, asset, amount_raw, status, swap_tx, burn_tx, shill_burned, created_at FROM burn_queue ORDER BY created_at DESC LIMIT 500");
});

route("GET", "/admin/launches", async (ctx) => {
  requireAdmin(ctx);
  return q("SELECT id, ticker, status, error, wallet_address, token_address, amount_wei, created_at, launched_at FROM launches ORDER BY created_at DESC LIMIT 200");
});

route("POST", "/admin/users/:id/ban", async (ctx) => {
  requireAdmin(ctx);
  await q("UPDATE users SET banned = true WHERE id = $1", [ctx.params.id]);
  await q("UPDATE payouts SET status = 'held' WHERE user_id = $1 AND status = 'queued'", [ctx.params.id]);
  return { ok: true };
});

// X API spend this month against the cap.
route("GET", "/admin/usage", async (ctx) => {
  requireAdmin(ctx);
  return { x: await xUsageSummary() };
});

// ---------- tokens launched outside the site (e.g. $SHILL via Proxima) ----------
// Body: { address, feeWallet, creatorFee: 1-5, topN: 10|25|50|100, schedule: "1h"|"4h"|"12h"|"24h"|"7d",
//         pair?: "ETH"|stock symbol, name?, ticker?, description?, image?: data URL, links?: {x,telegram,website}, launchedAt?: ISO date }
const nameAbi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

route("POST", "/admin/tokens", async (ctx) => {
  requireAdmin(ctx);
  const b = (ctx.body ?? {}) as Record<string, any>;
  if (!isAddress(b.address)) throw new HttpError(400, "address must be the token's contract address.");
  // Optional: the fee wallet and fee % are read from Pons when possible.
  let onchainTax: number | null = null;
  let onchainRecipient: string | null = null;
  try {
    const r = await launchRecord(b.address);
    if (r.exists) { onchainTax = Number(r.creatorTaxBps); onchainRecipient = r.creatorFeeRecipient; }
  } catch { /* not Pons v2 */ }
  if (b.feeWallet === undefined) b.feeWallet = onchainRecipient ?? feeWalletAddress();
  if (!isAddress(b.feeWallet)) throw new HttpError(400, "feeWallet must be the wallet receiving the creator fees.");
  const creatorFee = b.creatorFee !== undefined ? Number(b.creatorFee) : onchainTax !== null ? onchainTax / 100 : NaN;
  if (!Number.isFinite(creatorFee) || creatorFee < 0 || creatorFee > 100) throw new HttpError(400, "creatorFee is required for tokens not launched on Pons v2 (e.g. 2 for 2%).");
  const topN = Number(b.topN ?? 25);
  if (![10, 25, 50, 100].includes(topN)) throw new HttpError(400, "topN must be 10, 25, 50 or 100.");
  const cycleSeconds = CYCLE_SECONDS[String(b.schedule ?? "24h")];
  if (!cycleSeconds) throw new HttpError(400, "schedule must be 1h, 4h, 12h, 24h or 7d.");
  const pair = String(b.pair ?? "ETH");
  if (pair !== "ETH" && !(STOCK_PAIRS as readonly string[]).includes(pair)) throw new HttpError(400, "pair must be ETH or a supported stock token.");
  const pairAddresses = JSON.parse(process.env.PAIR_ADDRESSES ?? "{}") as Record<string, string>;

  const name = typeof b.name === "string" && b.name ? b.name
    : await publicClient.readContract({ address: b.address, abi: nameAbi, functionName: "name" }) as string;
  const ticker = (typeof b.ticker === "string" && b.ticker ? b.ticker
    : await publicClient.readContract({ address: b.address, abi: nameAbi, functionName: "symbol" }) as string).toUpperCase().replace(/^\$/, "");

  let imageFile: string | null = null;
  if (typeof b.image === "string") {
    const m = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(b.image);
    if (!m) throw new HttpError(400, "image must be a PNG, JPG, GIF or WebP data URL.");
    await mkdir(join(process.cwd(), "uploads"), { recursive: true });
    imageFile = `${randomBytes(12).toString("hex")}.${m[1] === "jpeg" ? "jpg" : m[1]}`;
    await writeFile(join(process.cwd(), "uploads", imageFile), Buffer.from(m[2]!, "base64"));
  }
  // Pull the logo, description and socials the creator set on Pons, when they weren't given here.
  const links: Record<string, string> = { ...(b.links ?? {}) };
  let description = String(b.description ?? "");
  try {
    const [, logo, desc, socials] = await publicClient.readContract({ address: b.address, abi: tokenInfoAbi, functionName: "getTokenInfo" }) as [string, string, string, { twitter: string; telegram: string; website: string }];
    const ipfs = (u: string) => u.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${u.slice(7)}` : u;
    if (!imageFile && logo) links.logo = ipfs(logo);
    if (!description && desc) description = desc;
    if (!links.x && socials.twitter) links.x = socials.twitter.startsWith("http") ? socials.twitter : `https://x.com/${socials.twitter.replace(/^@/, "")}`;
    if (!links.telegram && socials.telegram) links.telegram = socials.telegram;
    if (!links.website && socials.website) links.website = socials.website;
  } catch { /* not a Pons v2 token, or no metadata */ }

  // If this token's creator fees already go to the platform fee wallet, the backend can run it
  // fully automatically (fee collection and payouts), just like tokens launched through the site.
  let managed = false;
  try {
    const rec = await launchRecord(b.address);
    managed = rec.exists && rec.creatorFeeRecipient.toLowerCase() === feeWalletAddress().toLowerCase();
  } catch { /* not a Pons v2 token */ }

  let id = ticker.toLowerCase();
  for (let n = 2; (await q("SELECT 1 FROM launches WHERE id = $1", [id])).length; n++) id = `${ticker.toLowerCase()}-${n}`;
  const launchedAt = b.launchedAt ? new Date(b.launchedAt) : new Date();
  if (Number.isNaN(launchedAt.getTime())) throw new HttpError(400, "launchedAt must be a valid date.");

  await q(
    `INSERT INTO launches (id, name, ticker, description, image_path, links, pair, pair_address, creator_fee_bps, top_n, cycle_seconds,
                           receiver, wallet_address, wallet_key_enc, amount_wei, status, token_address, deadline_at, launched_at, managed)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,NULL,0,'live',$13,now(),$14,$15)`,
    [id, name, ticker, description.slice(0, 280), imageFile, links, pair, pair === "ETH" ? null : pairAddresses[pair] ?? null,
     Math.round(creatorFee * 100), topN, cycleSeconds, managed ? feeWalletAddress() : b.feeWallet, b.address, launchedAt, managed]);
  return { ok: true, id, name, ticker, page: `/#/token/${id}`,
    payouts: managed ? "automatic (fees go to the platform fee wallet)" : "manual (fees go to your own wallet; settle each cycle with /admin/tokens/:id/settle)" };
});

// Settle an external token's waiting cycle after you've claimed its fees yourself.
// Body: { feesRaw: "123450000000000000" }  (base units of the pair; for ETH that's wei)
// Returns the payout list. Send the burn share and the payouts yourself, then mark payouts sent.
route("POST", "/admin/tokens/:id/settle", async (ctx) => {
  requireAdmin(ctx);
  const raw = String((ctx.body as Record<string, unknown>)?.feesRaw ?? "");
  if (!/^\d+$/.test(raw)) throw new HttpError(400, "feesRaw must be a whole number in the pair's base units (wei for ETH).");
  try { return await settleExternal(ctx.params.id!, BigInt(raw)); }
  catch (e) { throw new HttpError(400, e instanceof Error ? e.message : String(e)); }
});

// Cycles waiting on you: external tokens needing a fee amount, and failed cycles needing review.
route("GET", "/admin/cycles", async (ctx) => {
  requireAdmin(ctx);
  return q(`SELECT c.id, c.launch_id, l.ticker, c.idx, c.status, c.ends_at, c.error, c.fees_raw, c.burn_raw, c.pool_raw
              FROM cycles c JOIN launches l ON l.id = c.launch_id
             WHERE c.status IN ('awaiting_fees','failed') ORDER BY c.ends_at`);
});

// After fixing a failed transfer by hand, mark the cycle settled so the token resumes.
route("POST", "/admin/cycles/:id/mark-settled", async (ctx) => {
  requireAdmin(ctx);
  const r = await q("UPDATE cycles SET status='settled', settled_at=now(), error=NULL WHERE id=$1 AND status='failed' RETURNING id", [ctx.params.id]);
  if (!r.length) throw new HttpError(404, "No failed cycle with that id.");
  return { ok: true };
});

// Fees that reached the fee wallet without being attributed to a token (Pons swept them itself).
route("GET", "/admin/fees/unattributed", async (ctx) => {
  requireAdmin(ctx);
  return q("SELECT id, amount_raw, created_at FROM fee_ledger WHERE launch_id IS NULL AND cycle_id IS NULL ORDER BY created_at");
});
// Assign one to a token; it's paid out in that token's next cycle. Body: { launchId }
route("POST", "/admin/fees/:id/assign", async (ctx) => {
  requireAdmin(ctx);
  const launchId = String((ctx.body as Record<string, unknown>)?.launchId ?? "");
  const r = await q("UPDATE fee_ledger SET launch_id=$2, source='sweep' WHERE id=$1 AND launch_id IS NULL AND cycle_id IS NULL RETURNING id", [ctx.params.id, launchId]);
  if (!r.length) throw new HttpError(404, "No unassigned fee entry with that id.");
  return { ok: true };
});

// Take a token off the site (e.g. something that pointed its fees at your wallet that you don't want listed).
route("POST", "/admin/tokens/:id/hide", async (ctx) => {
  requireAdmin(ctx);
  const r = await q("UPDATE launches SET status='hidden' WHERE id=$1 AND status='live' RETURNING id", [ctx.params.id]);
  if (!r.length) throw new HttpError(404, "No live token with that id.");
  return { ok: true };
});
route("POST", "/admin/tokens/:id/unhide", async (ctx) => {
  requireAdmin(ctx);
  const r = await q("UPDATE launches SET status='live' WHERE id=$1 AND status='hidden' RETURNING id", [ctx.params.id]);
  if (!r.length) throw new HttpError(404, "No hidden token with that id.");
  return { ok: true };
});
