// Public API used by the website. Response shapes match what the frontend already expects.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { config, CYCLE_SECONDS } from "../config.js";
import { q, one } from "../db.js";
import { feeWalletAddress } from "../chain/feeWallet.js";
import { verifyLaunch } from "../chain/pons.js";
import { erc20Abi } from "../chain/ponsAbi.js";
import { publicClient } from "../chain/client.js";
import { standings } from "../scoring/standings.js";
import { cycleAt } from "../payouts/cycles.js";
import { route, HttpError, send, str, isAddress } from "./router.js";
import { rateLimit } from "../lib/ratelimit.js";

const UPLOADS = join(process.cwd(), "uploads");
const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}


// ---------- health ----------
route("GET", "/health", async () => ({ ok: true }));

// ---------- tokens ----------
interface TokenRow {
  id: string; name: string; ticker: string; description: string; image_path: string | null; pair: string;
  top_n: number; cycle_seconds: number; token_address: string; wallet_address: string; launched_at: Date; links: Record<string, string>;
  mcap_usd: number | null; change_24h: number | null; volume_usd: number | null; holders: number | null;
  price_usd: number | null; liquidity_usd: number | null; pair_url: string | null; managed: boolean; phase: number | null; progress: number | null;
  paid: number | null; posts: string | null; shillers: string | null;
}
const TOKEN_SQL = `
  SELECT l.id, l.name, l.ticker, l.description, l.image_path, l.pair, l.top_n, l.cycle_seconds,
         l.token_address, l.wallet_address, l.launched_at, l.links, l.managed,
         m.mcap_usd, m.change_24h, m.volume_usd, m.holders, m.price_usd, m.liquidity_usd, m.pair_url, m.phase, m.progress,
         (SELECT COALESCE(SUM(amount_usd),0) FROM payouts p WHERE p.launch_id = l.id AND p.status = 'sent') AS paid,
         (SELECT COUNT(*) FROM posts p WHERE p.launch_id = l.id AND NOT p.deleted) AS posts,
         (SELECT COUNT(DISTINCT user_id) FROM posts p WHERE p.launch_id = l.id AND NOT p.deleted) AS shillers
    FROM launches l LEFT JOIN token_market m ON m.launch_id = l.id
   WHERE l.status = 'live'`;

const scheduleLabel = (s: number) => Object.entries(CYCLE_SECONDS).find(([, v]) => v === s)?.[0] ?? `${s}s`;

function shapeToken(r: TokenRow) {
  const cycle = cycleAt(new Date(r.launched_at), r.cycle_seconds, new Date());
  return {
    id: r.id, name: r.name, ticker: r.ticker, description: r.description, pair: r.pair,
    image: r.image_path ? `${config.publicBaseUrl}/media/${r.image_path}` : (r.links?.logo && /^https:\/\//.test(r.links.logo) ? r.links.logo : null),
    address: r.token_address, feeWallet: r.wallet_address, feesLocked: r.managed, links: r.links,
    price: r.price_usd ?? 0, liquidity: r.liquidity_usd ?? 0, dexUrl: r.pair_url,
    graduated: r.phase === 2, progress: r.progress ?? null,
    mcap: r.mcap_usd ?? 0, change: r.change_24h ?? 0, volume: r.volume_usd ?? 0, holders: r.holders ?? 0,
    paid: Number(r.paid ?? 0), posts: Number(r.posts ?? 0), shillers: Number(r.shillers ?? 0),
    launched: new Date(r.launched_at).getTime(), schedule: scheduleLabel(r.cycle_seconds), topN: r.top_n,
    nextPayoutAt: cycle.endsAt.getTime(),
  };
}

route("GET", "/tokens", () => cached("tokens", 3_000, async () => (await q<TokenRow>(TOKEN_SQL)).map(shapeToken)));

route("GET", "/tokens/:id", async ({ params }) => {
  const r = await one<TokenRow>(`${TOKEN_SQL} AND l.id = $1`, [params.id]);
  if (!r) throw new HttpError(404, "Token not found.");
  return shapeToken(r);
});

// Live leaderboard for the current cycle.
route("GET", "/tokens/:id/leaderboard", ({ params }) =>
  cached(`lb:${params.id}`, 60_000, async () => {
    const earned = new Map(
      (await q<{ user_id: string; usd: number }>(
        "SELECT user_id, COALESCE(SUM(amount_usd),0) AS usd FROM payouts WHERE launch_id = $1 AND status = 'sent' GROUP BY user_id",
        [params.id],
      )).map((r) => [r.user_id, Number(r.usd)]),
    );
    const { standings: s } = await standings(params.id!);
    return s.map((u) => ({ ...u, earned: earned.get(u.userId) ?? 0 }));
  }),
);

// All-time leaderboard across every token.
route("GET", "/leaderboard", () =>
  cached("lb:all", 120_000, async () =>
    (await q<{ handle: string; points: number; interactions: string; posts: string; likes: string; replies: string; reposts: string; earned: number; launches: string }>(`
      SELECT u.x_handle AS handle,
             COALESCE((SELECT SUM(points) FROM cycle_ranks cr WHERE cr.user_id = u.id),0) AS points,
             COALESCE(SUM(p.likes + p.comments + p.shares),0) AS interactions,
             COUNT(p.id) AS posts, COALESCE(SUM(p.likes),0) AS likes, COALESCE(SUM(p.comments),0) AS replies,
             COALESCE(SUM(p.shares),0) AS reposts,
             COALESCE((SELECT SUM(amount_usd) FROM payouts po WHERE po.user_id = u.id AND po.status = 'sent'),0) AS earned,
             COUNT(DISTINCT p.launch_id) AS launches
        FROM users u JOIN posts p ON p.user_id = u.id AND NOT p.deleted
       WHERE NOT u.banned
       GROUP BY u.id ORDER BY points DESC, interactions DESC LIMIT 200`)).map((r) => ({
      handle: r.handle, points: Number(r.points), interactions: Number(r.interactions), posts: Number(r.posts),
      likes: Number(r.likes), replies: Number(r.replies), reposts: Number(r.reposts), earned: Number(r.earned), launches: Number(r.launches),
    })),
  ),
);

// ---------- payouts & stats ----------
async function payoutsFor(launchId?: string) {
  return (await q<{ handle: string; amount: number; ticker: string; t: Date }>(
    `SELECT u.x_handle AS handle, p.amount_usd AS amount, l.ticker, p.sent_at AS t
       FROM payouts p JOIN users u ON u.id = p.user_id JOIN launches l ON l.id = p.launch_id
      WHERE p.status = 'sent' ${launchId ? "AND p.launch_id = $1" : ""}
      ORDER BY p.sent_at DESC LIMIT 100`,
    launchId ? [launchId] : [],
  )).map((r) => ({ handle: r.handle, amount: Number(r.amount ?? 0), ticker: r.ticker, t: new Date(r.t).getTime() }));
}
route("GET", "/payouts", () => cached("payouts", 30_000, () => payoutsFor()));
route("GET", "/tokens/:id/payouts", ({ params }) => cached(`payouts:${params.id}`, 30_000, () => payoutsFor(params.id)));

// Price chart: the market worker's 15-minute price snapshots, last 30 days, as [ms, priceUsd] pairs.
route("GET", "/tokens/:id/chart", ({ params }) =>
  cached(`chart:${params.id}`, 60_000, async () =>
    (await q<{ at: Date; price_usd: number }>(
      "SELECT at, price_usd FROM price_history WHERE launch_id = $1 AND at > now() - interval '30 days' ORDER BY at",
      [params.id],
    )).map((r) => [new Date(r.at).getTime(), Number(r.price_usd)])));

route("GET", "/stats", () =>
  cached("stats", 30_000, async () => {
    const r = await one<{ paid: number; posts: string; launches: string; burned_raw: string }>(`
      SELECT (SELECT COALESCE(SUM(amount_usd),0) FROM payouts WHERE status='sent') AS paid,
             (SELECT COUNT(*) FROM posts WHERE NOT deleted) AS posts,
             (SELECT COUNT(*) FROM launches WHERE status='live') AS launches,
             (SELECT COALESCE(SUM(shill_burned),0) FROM burn_queue WHERE status='done') AS burned_raw`);
    return { paid: Number(r?.paid ?? 0), posts: Number(r?.posts ?? 0), launches: Number(r?.launches ?? 0), shillBurnedRaw: r?.burned_raw ?? "0" };
  }),
);

// ---------- launching ----------
// The launch itself happens in the launcher's browser: they connect their wallet, the site derives a fresh
// launch wallet only they can open, they fund it, and it launches on Pons with the platform fee wallet as the
// creator fee recipient. The backend supplies the settings and verifies the result before listing it.

route("GET", "/launch/config", () =>
  cached("launch-config", 60_000, async () => ({
    chainId: config.chainId,
    factory: config.pons.factory,
    router: config.pons.launchRouter,
    feeRecipient: feeWalletAddress(),
    rpc: `${config.publicBaseUrl}/rpc`,
    explorer: config.explorerUrl,
    gasBufferEth: config.launchGasBufferEth,
  })),
);

// Token logo upload. Returns a permanent URL used as the token's on-chain logo.
route("POST", "/media", async ({ body, req }) => {
  rateLimit(req, "media", 10, 3600_000, "Too many uploads from this connection. Try again later.");
  const image = (body as Record<string, unknown>)?.image;
  if (typeof image !== "string") throw new HttpError(400, "Send the image as a data URL.");
  const m = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(image);
  if (!m) throw new HttpError(400, "Image must be a PNG, JPG, GIF or WebP.");
  const bytes = Buffer.from(m[2]!, "base64");
  if (bytes.length > 5 * 1024 * 1024) throw new HttpError(400, "Image must be 5 MB or smaller.");
  await mkdir(UPLOADS, { recursive: true });
  const file = `${randomBytes(12).toString("hex")}.${m[1] === "jpeg" ? "jpg" : m[1]}`;
  await writeFile(join(UPLOADS, file), bytes);
  return { url: `${config.publicBaseUrl}/media/${file}` };
});

// Lists a token after its launch transaction confirms. Everything important is read from the chain.
route("POST", "/launch/register", async ({ body, req }) => {
  rateLimit(req, "register", 20, 3600_000, "Too many requests from this connection. Try again later.");
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(b.txHash)) throw new HttpError(400, "txHash is required.");
  const topN = Number(b.topN);
  if (![10, 25, 50, 100].includes(topN)) throw new HttpError(400, "Paid spots must be 10, 25, 50 or 100.");
  const cycleSeconds = CYCLE_SECONDS[String(b.schedule)];
  if (!cycleSeconds) throw new HttpError(400, "Payout cycle must be 1h, 4h, 12h, 24h or 7d.");
  const owner = isAddress(b.owner) ? b.owner : null;

  let v;
  try { v = await verifyLaunch(b.txHash as `0x${string}`); }
  catch (e) { throw new HttpError(400, e instanceof Error ? e.message : "Couldn't verify that launch."); }

  const existing = await one<{ id: string }>("SELECT id FROM launches WHERE lower(token_address) = lower($1)", [v.token]);
  if (existing) {
    // Auto-listing may have found it a few seconds before the launcher's browser registered it. Apply the
    // launcher's chosen settings ONLY in that case: the first registration, within minutes of launch, before any
    // payout cycle. Launch transactions are public, so anything later could be someone changing the rules.
    await q(`UPDATE launches SET top_n=$2, cycle_seconds=$3, owner=$4, description=CASE WHEN description='' THEN $5 ELSE description END
              WHERE id=$1 AND owner IS NULL AND launched_at > now() - interval '15 minutes'
                AND NOT EXISTS (SELECT 1 FROM cycles c WHERE c.launch_id = launches.id)`,
      [existing.id, topN, cycleSeconds, owner ?? "registered", typeof b.description === "string" ? b.description.slice(0, 280) : ""]);
    cache.delete("tokens");
    return { id: existing.id };
  }

  const [name, symbol] = await Promise.all([
    publicClient.readContract({ address: v.token, abi: erc20Abi, functionName: "name" }),
    publicClient.readContract({ address: v.token, abi: erc20Abi, functionName: "symbol" }),
  ]);
  const ticker = String(symbol).toUpperCase().slice(0, 16);
  const block = await publicClient.getBlock({ blockNumber: v.block });
  const logoFile = typeof b.logoUrl === "string" ? /\/media\/([a-f0-9]{24}\.(?:png|jpg|gif|webp))$/.exec(b.logoUrl)?.[1] ?? null : null;
  const links: Record<string, string> = {};
  for (const k of ["x", "telegram", "website"]) {
    const val = (b.links as Record<string, unknown> | undefined)?.[k];
    if (typeof val === "string" && /^https:\/\//i.test(val)) links[k] = val.slice(0, 200);
  }
  let id = ticker.toLowerCase().replace(/[^a-z0-9]/g, "") || "token";
  for (let n = 2; await one("SELECT 1 FROM launches WHERE id = $1", [id]); n++) id = `${ticker.toLowerCase()}-${n}`;

  await q(
    `INSERT INTO launches (id, name, ticker, description, image_path, links, pair, pair_address, creator_fee_bps, top_n, cycle_seconds,
                           wallet_address, status, token_address, curve_address, deploy_tx, launched_at, managed, owner, deployer)
     VALUES ($1,$2,$3,$4,$5,$6,'ETH',NULL,$7,$8,$9,$10,'live',$11,$12,$13,to_timestamp($14),true,$15,$16)`,
    [id, String(name).slice(0, 64), ticker, typeof b.description === "string" ? b.description.slice(0, 280) : "", logoFile, links,
     v.creatorTaxBps, topN, cycleSeconds, feeWalletAddress(), v.token, v.curve, b.txHash, Number(block.timestamp), owner ?? "registered", v.deployer]);
  cache.delete("tokens");
  return { id };
});

// Read-only-plus-broadcast JSON-RPC proxy, so the browser can talk to Robinhood Chain without CORS issues.
const RPC_METHODS = new Set(["eth_chainId", "eth_blockNumber", "eth_call", "eth_getBalance", "eth_estimateGas", "eth_gasPrice",
  "eth_maxPriorityFeePerGas", "eth_feeHistory", "eth_getTransactionCount", "eth_sendRawTransaction", "eth_getTransactionReceipt",
  "eth_getTransactionByHash", "eth_getBlockByNumber", "eth_getCode", "net_version"]);
route("POST", "/rpc", async ({ body, req }) => {
  rateLimit(req, "rpc", 600, 60_000, "Too many requests.");
  const calls = Array.isArray(body) ? body : [body];
  if (calls.length > 20) throw new HttpError(400, "Batch too large.");
  for (const c of calls) {
    if (!c || typeof c !== "object" || !RPC_METHODS.has(String((c as Record<string, unknown>).method)))
      throw new HttpError(400, "Method not allowed.");
  }
  const r = await fetch(config.rpcUrl(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return await r.json();
});

// ---------- media & token metadata (used as the token's metadata URI on Pons) ----------
route("GET", "/media/:file", async ({ params, res }) => {
  if (!/^[a-f0-9]{24}\.(png|jpg|gif|webp)$/.test(params.file!)) throw new HttpError(404, "Not found");
  const types: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
  try {
    const data = await readFile(join(UPLOADS, params.file!));
    send(res, 200, data, { "Content-Type": types[params.file!.split(".")[1]!]!, "Cache-Control": "public, max-age=31536000, immutable" });
  } catch { throw new HttpError(404, "Not found"); }
});

route("GET", "/metadata/:id", async ({ params }) => {
  const l = await one<{ name: string; ticker: string; description: string; image_path: string; links: Record<string, string> }>(
    "SELECT name, ticker, description, image_path, links FROM launches WHERE id = $1", [params.id!.replace(/\.json$/, "")]);
  if (!l) throw new HttpError(404, "Not found");
  return { name: l.name, symbol: l.ticker, description: l.description, image: `${config.publicBaseUrl}/media/${l.image_path}`,
    external_url: `${config.frontendOrigin}/#/token/${params.id}`, ...l.links };
});
