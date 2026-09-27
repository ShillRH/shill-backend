// Auto-listing: watches Pons v2 for new launches and instantly lists every token whose creator fees go to
// the platform fee wallet, whether it was launched on this site, on Pons directly, or through a bundler
// like Proxima. It checks every few seconds, so a new token appears within moments of launching.
//
// Listed tokens get the default rewards settings below and run fully automatically (fee collection and
// payouts), because their fees already go to the platform fee wallet. To take one off the site, use
// POST /admin/tokens/:id/hide.
import { parseAbiItem, type Address } from "viem";
import { config, CYCLE_SECONDS } from "../config.js";
import { q, one } from "../db.js";
import { publicClient } from "../chain/client.js";
import { launchRecord } from "../chain/pons.js";
import { feeWalletAddress } from "../chain/feeWallet.js";
import { erc20Abi, tokenInfoAbi } from "../chain/ponsAbi.js";
import { log, errMsg } from "../lib/log.js";

const EVENT = parseAbiItem(
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)");
const CHUNK = 20_000n;          // the public RPC times out on wide log ranges
const MAX_PER_RUN = 200_000n;   // catch up gradually after downtime
const DEFAULT_TOP_N = Number(process.env.AUTO_LIST_TOP_N ?? 25);
const DEFAULT_CYCLE = CYCLE_SECONDS[process.env.AUTO_LIST_SCHEDULE ?? "24h"] ?? CYCLE_SECONDS["24h"]!;

export async function runDiscover() {
  const head = await publicClient.getBlockNumber();
  const state = await one<{ last_block: string }>("SELECT last_block FROM discovery_state WHERE id=1");
  let from: bigint;
  if (state) from = BigInt(state.last_block) + 1n;
  else {
    // First run: start from AUTO_LIST_START_BLOCK if set, otherwise from about the last day of blocks.
    from = process.env.AUTO_LIST_START_BLOCK ? BigInt(process.env.AUTO_LIST_START_BLOCK) : head > 1_000_000n ? head - 1_000_000n : 0n;
  }
  if (from > head) return;
  const until = from + MAX_PER_RUN < head ? from + MAX_PER_RUN : head;
  const me = feeWalletAddress().toLowerCase();

  for (let start = from; start <= until; start += CHUNK) {
    const end = start + CHUNK - 1n < until ? start + CHUNK - 1n : until;
    const logs = await publicClient.getLogs({ address: config.pons.factory as Address, event: EVENT, fromBlock: start, toBlock: end });
    for (const l of logs as unknown as { args: { token: Address; curve: Address; deployer: Address }; transactionHash: string; blockNumber: bigint }[]) {
      try { await consider(l.args.token, l.args.curve, l.args.deployer, l.transactionHash, l.blockNumber, me); }
      catch (e) { log.warn("auto-list check failed", { token: l.args.token, error: errMsg(e) }); }
    }
    await q(`INSERT INTO discovery_state (id, last_block) VALUES (1,$1)
             ON CONFLICT (id) DO UPDATE SET last_block=EXCLUDED.last_block, updated_at=now()`, [end.toString()]);
  }
}

async function consider(token: Address, curve: Address, deployer: Address, tx: string, block: bigint, me: string) {
  if (await one("SELECT 1 FROM launches WHERE lower(token_address) = lower($1)", [token])) return; // already listed
  const rec = await launchRecord(token);
  if (!rec.exists || rec.creatorFeeRecipient.toLowerCase() !== me) return; // fees don't go to us: not ours

  const [name, symbol, blk] = await Promise.all([
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: "name" }),
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    publicClient.getBlock({ blockNumber: block }),
  ]);
  const links: Record<string, string> = {};
  let description = "";
  try {
    const [, logo, desc, socials] = await publicClient.readContract({ address: token, abi: tokenInfoAbi, functionName: "getTokenInfo" }) as
      [string, string, string, { twitter: string; telegram: string; website: string }];
    if (logo) links.logo = logo.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${logo.slice(7)}` : logo;
    description = desc ?? "";
    if (socials.twitter) links.x = socials.twitter.startsWith("http") ? socials.twitter : `https://x.com/${socials.twitter.replace(/^@/, "")}`;
    if (socials.telegram) links.telegram = socials.telegram;
    if (socials.website) links.website = socials.website;
  } catch { /* no metadata */ }

  // Launches from this site keep the logo file they uploaded.
  const logoFile = /\/media\/([a-f0-9]{24}\.(?:png|jpg|gif|webp))$/.exec(links.logo ?? "")?.[1] ?? null;
  if (logoFile) delete links.logo;

  const ticker = String(symbol).toUpperCase().slice(0, 16);
  let id = ticker.toLowerCase().replace(/[^a-z0-9]/g, "") || "token";
  for (let n = 2; await one("SELECT 1 FROM launches WHERE id = $1", [id]); n++) id = `${ticker.toLowerCase().replace(/[^a-z0-9]/g, "")}-${n}`;

  await q(
    `INSERT INTO launches (id, name, ticker, description, image_path, links, pair, pair_address, creator_fee_bps, top_n, cycle_seconds,
                           wallet_address, status, token_address, curve_address, deploy_tx, launched_at, managed, deployer)
     VALUES ($1,$2,$3,$4,$5,$6,'ETH',NULL,$7,$8,$9,$10,'live',$11,$12,$13,to_timestamp($14),true,$15)
     ON CONFLICT DO NOTHING`,
    [id, String(name).slice(0, 64), ticker, description.slice(0, 280), logoFile, links, Number(rec.creatorTaxBps),
     DEFAULT_TOP_N, DEFAULT_CYCLE, feeWalletAddress(), token, curve, tx, Number(blk.timestamp), deployer]);
  log.info("auto-listed token", { id, token });
}
