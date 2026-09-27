// Offline end-to-end simulation of the whole $SHILL backend.
// Real backend code runs against: SQLite (via the pg stand-in), a simulated Robinhood Chain + Pons v2,
// and mocked X / DexScreener / Blockscout / DeFiLlama responses.
//
//   node --import tsx --import ./test/sim/register.mjs test/sim/e2e.ts
import { spawn } from "node:child_process";

// ---------- environment (what you'd set in Railway) ----------
const PORT = 18733;
Object.assign(process.env, {
  PORT: String(PORT), DATABASE_URL: "sqlite://simulated", ADMIN_TOKEN: "test-admin-token",
  PUBLIC_BASE_URL: `http://127.0.0.1:${PORT}`, FRONTEND_ORIGIN: "null",
  TEST_FEE_WALLET_KEY: "0xtest-fee-wallet-key", FEE_WALLET_PRIVATE_KEY: "0xtest-fee-wallet-key",
  TREASURY_ADDRESS: "0x1111111111111111111111111111111111111111", PAYOUT_FUNDING_ADDRESS: "0x2222222222222222222222222222222222222222",
  X_BEARER_TOKEN: "test-bearer", X_MONTHLY_BUDGET_USD: "50", AUTO_LIST_START_BLOCK: "50000000",
});

// ---------- tiny test reporter ----------
const results: { name: string; ok: boolean; info?: string }[] = [];
let section = "";
function sec(name: string) { section = name; console.log(`\n■ ${name}`); }
function check(name: string, cond: unknown, info?: unknown) {
  const ok = Boolean(cond);
  results.push({ name: `${section}: ${name}`, ok, info: ok ? undefined : JSON.stringify(info, (_k, v) => typeof v === "bigint" ? v.toString() : v) });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `  →  ${JSON.stringify(info, (_k, v) => typeof v === "bigint" ? v.toString() : v)}`}`);
}
async function step(name: string, fn: () => Promise<void>) {
  try { await fn(); } catch (e) { check(`${name} (threw)`, false, (e as Error).message.slice(0, 600)); }
}

// ---------- mocked external services ----------
const realFetch = globalThis.fetch;
const xTweets = new Map<string, { id: string; text: string; author_id: string; created_at: string; public_metrics: Record<string, number>; attachments?: { media_keys: string[] } }>();
const xUsers = new Map<string, { id: string; username: string; created_at: string; public_metrics: { followers_count: number } }>();
const xCalls: string[] = [];
const external: string[] = [];
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
  external.push(url.split("?")[0]!);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  if (url.startsWith("https://coins.llama.fi/")) return json({ coins: { "coingecko:ethereum": { price: 2500 } } });
  if (url.startsWith("https://api.dexscreener.com/")) return json([]);
  if (url.includes("blockscout.com/api/v2/tokens/")) return json({ holders_count: "42" });
  if (url.startsWith("https://rpc.mainnet.chain.robinhood.com")) return json({ jsonrpc: "2.0", id: 1, result: "0x1237" });
  if (url.startsWith("https://api.x.com/2/")) {
    xCalls.push(url);
    const u = new URL(url);
    if (u.pathname === "/2/tweets/search/recent") {
      const q = u.searchParams.get("query") ?? "", since = u.searchParams.get("since_id");
      const handles = [...q.matchAll(/from:(\w+)/g)].map((m) => m[1]!.toLowerCase());
      const data = [...xTweets.values()].filter((t) => handles.includes(xUsers.get(t.author_id)!.username.toLowerCase()) && (!since || BigInt(t.id) > BigInt(since)));
      return json({ data, meta: { result_count: data.length } });
    }
    if (u.pathname === "/2/tweets") {
      const ids = (u.searchParams.get("ids") ?? "").split(",");
      return json({ data: ids.map((i) => xTweets.get(i)).filter(Boolean) });
    }
    const m = /^\/2\/tweets\/(\d+)$/.exec(u.pathname);
    if (m) {
      const t = xTweets.get(m[1]!);
      if (!t) return json({ errors: [{ title: "Not Found" }] });
      return json({ data: t, includes: { users: [xUsers.get(t.author_id)] } });
    }
  }
  return json({ error: `unmocked ${url}` }, 404);
}) as typeof fetch;

const api = async (method: string, path: string, body?: unknown, admin = false) => {
  const r = await realFetch(`http://127.0.0.1:${PORT}${path}`, {
    method, headers: { "Content-Type": "application/json", Origin: "null", ...(admin ? { Authorization: "Bearer test-admin-token" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data: unknown = text; try { data = JSON.parse(text); } catch { /* csv etc */ }
  return { status: r.status, data: data as Record<string, any>, headers: r.headers };
};
const E18 = 10n ** 18n;
const eth = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

// ============================================================================================
sec("1. Startup settings check (the Railway error)");
await step("missing DATABASE_URL gives a clear message", async () => {
  const env = { ...process.env }; delete env.DATABASE_URL; delete env.ADMIN_TOKEN;
  const child = spawn(process.execPath, ["--import", "tsx", "--import", "./test/sim/register.mjs", "src/server.ts"], { env, cwd: process.cwd() });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  await new Promise((r) => setTimeout(r, 6000));
  child.kill();
  check("explains DATABASE_URL and how to fix it on Railway", err.includes("DATABASE_URL is not set") && err.includes("${{Postgres.DATABASE_URL}}"), err.slice(0, 300));
  check("also reports the missing ADMIN_TOKEN in the same message", err.includes("ADMIN_TOKEN is not set"), err.slice(0, 300));
  check("no raw crash stack trace", !err.includes("at req ("), err.slice(0, 300));
});
await step("Railway's alternative variable names are accepted", async () => {
  const { resolveDatabaseUrl } = await import("../../src/config.ts");
  const saved = process.env.DATABASE_URL; delete process.env.DATABASE_URL;
  Object.assign(process.env, { PGHOST: "db.internal", PGPORT: "5432", PGUSER: "postgres", PGPASSWORD: "p@ss", PGDATABASE: "railway" });
  check("builds a URL from PGHOST/PGUSER/...", resolveDatabaseUrl() === "postgresql://postgres:p%40ss@db.internal:5432/railway", resolveDatabaseUrl());
  for (const k of ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"]) delete process.env[k];
  process.env.DATABASE_PRIVATE_URL = "postgres://x"; check("accepts DATABASE_PRIVATE_URL", resolveDatabaseUrl() === "postgres://x");
  delete process.env.DATABASE_PRIVATE_URL; process.env.DATABASE_URL = saved;
});

// ============================================================================================
sec("2. Database setup (all migrations)");
const { rawDb: rawDbInner } = await import("./pg-sqlite.ts");
// direct DB access for assertions, reading big numbers safely
const rawDb = { prepare: (sql: string) => { const st = rawDbInner.prepare(sql); st.setReadBigInts(true);
  const fix = (r: any) => r && Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" ? (v > 9007199254740991n || v < -9007199254740991n ? v : Number(v)) : v]));
  return { all: (...a: any[]) => (st.all(...a) as any[]).map(fix), get: (...a: any[]) => fix(st.get(...a)), run: (...a: any[]) => st.run(...a) }; } };
await step("migrations apply cleanly", async () => {
  await import("../../src/migrate.ts");
  const tables = (rawDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
  for (const t of ["launches", "users", "posts", "cycles", "payouts", "fee_ledger", "fee_wallet_state", "discovery_state", "api_usage", "tracker_state", "token_market", "curve_trades"])
    check(`table ${t} exists`, tables.includes(t), tables);
  const applied = rawDb.prepare("SELECT count(*) AS n FROM schema_migrations").get() as { n: number };
  check("all 7 migration files recorded", Number(applied.n) === 7, applied);
});

// ============================================================================================
sec("3. API server boots");
const { chain, ADDR, addr } = await import("./chain.ts");
const FEE_WALLET = "0xf71a301d178686324254ddd6d1972cc839dc16d3";
chain.setEth(FEE_WALLET, eth(0.05));
await import("../../src/server.ts");
await new Promise((r) => setTimeout(r, 400));
await step("health", async () => { const r = await api("GET", "/health"); check("GET /health → ok", r.data.ok === true, r); });
await step("launch config", async () => {
  const r = await api("GET", "/launch/config");
  check("fee recipient is the platform fee wallet", r.data.feeRecipient?.toLowerCase() === FEE_WALLET, r.data);
  check("Pons factory and router addresses built in", r.data.factory?.toLowerCase() === ADDR.factory && r.data.router?.toLowerCase() === ADDR.router, r.data);
  check("CORS allows the website", r.headers.get("access-control-allow-origin") === "null");
});
await step("RPC proxy", async () => {
  const ok = await api("POST", "/rpc", { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
  check("forwards allowed methods", ok.data.result === "0x1237", ok.data);
  const bad = await api("POST", "/rpc", { jsonrpc: "2.0", id: 1, method: "eth_sendTransaction", params: [] });
  check("blocks disallowed methods", bad.status === 400, bad);
});

// ============================================================================================
sec("4. Launch through the site (browser launches on Pons, backend verifies and lists)");
let rdog = "";
const launcherWallet = addr("launcher-connected-wallet"), launchWallet = addr("derived-launch-wallet-0");
await step("logo upload", async () => {
  const png = "data:image/png;base64," + Buffer.from("fakepngbytes".repeat(10)).toString("base64");
  const r = await api("POST", "/media", { image: png });
  check("returns a permanent media URL", /\/media\/[a-f0-9]{24}\.png$/.test(r.data.url ?? ""), r.data);
  const img = await realFetch(r.data.url); check("image is served back", img.status === 200 && img.headers.get("content-type") === "image/png");
  const big = await api("POST", "/media", { image: "data:image/png;base64," + Buffer.alloc(5.5 * 1024 * 1024).toString("base64") });
  check("rejects images over 5 MB", big.status === 400 || big.status === 413, big.status);
  (globalThis as any).__logo = r.data.url;
});
await step("register a verified launch", async () => {
  const l = chain.launch({ deployer: launchWallet, feeRecipient: FEE_WALLET, name: "Robin Dog", symbol: "RDOG", tax: 200, via: "router", logo: (globalThis as any).__logo });
  const r = await api("POST", "/launch/register", { txHash: l.hash, owner: launcherWallet, description: "The dog of Robinhood Chain", links: { x: "https://x.com/rdog" }, topN: 25, schedule: "24h", logoUrl: (globalThis as any).__logo });
  check("listed with id rdog", r.data.id === "rdog", r.data);
  rdog = r.data.id;
  const t = await api("GET", "/tokens/rdog");
  check("token page data: name, ticker, fee wallet, fees locked", t.data.name === "Robin Dog" && t.data.ticker === "RDOG" && t.data.feeWallet?.toLowerCase() === FEE_WALLET && t.data.feesLocked === true, t.data);
  check("uses the uploaded logo", String(t.data.image).includes("/media/"), t.data.image);
  const again = await api("POST", "/launch/register", { txHash: l.hash, topN: 10, schedule: "4h" });
  const after = await api("GET", "/tokens/rdog");
  check("registering twice is safe (same token)", again.data.id === "rdog", again.data);
  check("nobody can change a token's payout settings after launch", after.data.topN === 25 && after.data.schedule === "24h", after.data);
});
await step("reject launches that don't pay the platform", async () => {
  const bad = chain.launch({ deployer: launchWallet, feeRecipient: addr("someone-else"), name: "Rug", symbol: "RUG", tax: 500 });
  const r = await api("POST", "/launch/register", { txHash: bad.hash, topN: 25, schedule: "24h" });
  check("rejected: fees don't go to the fee wallet", r.status === 400 && /fee wallet/i.test(r.data.error), r.data);
  const fake = await api("POST", "/launch/register", { txHash: "0x" + "ab".repeat(32), topN: 25, schedule: "24h" });
  check("rejected: unknown transaction", fake.status === 400, fake.data);
});

// ============================================================================================
sec("5. Auto-listing (e.g. $SHILL launched through Proxima)");
const { runDiscover } = await import("../../src/workers/discover.ts");
let shillToken = "";
await step("fee wallet launches are listed automatically", async () => {
  const s = chain.launch({ deployer: addr("proxima-dev"), feeRecipient: FEE_WALLET, name: "SHILL", symbol: "SHILL", tax: 200, via: "proxima", logo: "ipfs://bafyshill", twitter: "@SHILL_RH" });
  shillToken = s.token;
  const other = chain.launch({ deployer: addr("x"), feeRecipient: addr("stranger"), name: "Other", symbol: "OTHR", tax: 100 });
  await runDiscover();
  const t = await api("GET", "/tokens/shill");
  check("$SHILL appears without any command", t.status === 200 && t.data.ticker === "SHILL", t.data);
  check("runs automatically (fees locked)", t.data.feesLocked === true, t.data);
  check("logo and X link pulled from Pons", String(t.data.image).startsWith("https://ipfs.io/ipfs/") && t.data.links?.x === "https://x.com/SHILL_RH", t.data);
  const q2 = chain.launch({ deployer: launchWallet, feeRecipient: FEE_WALLET, name: "Quick", symbol: "QUIK", tax: 100, via: "factory" });
  await runDiscover();
  const pre = await api("GET", "/tokens/quik");
  await api("POST", "/launch/register", { txHash: q2.hash, owner: launcherWallet, topN: 50, schedule: "1h" });
  const post = await api("GET", "/tokens/quik");
  check("if auto-listing wins the race, the launcher's chosen settings still apply", pre.data.topN === 25 && post.data.topN === 50 && post.data.schedule === "1h", { pre: pre.data.topN, post: [post.data.topN, post.data.schedule] });
  const o = await api("GET", "/tokens/othr");
  check("tokens paying someone else are NOT listed", o.status === 404, o.status);
  void other;
  const r = await api("POST", "/launch/register", { txHash: s.hash, topN: 25, schedule: "24h" });
  check("a Proxima (non-Pons-contract) tx can't be registered by hand, but auto-listing covers it", r.status === 400, r.data);
});

// ============================================================================================
sec("6. Market data from the chain (before graduation)");
const { runMarket } = await import("../../src/workers/market.ts");
await step("price, market cap, volume, holders, progress", async () => {
  chain.buy(rdog === "rdog" ? [...chain.launches.values()].find((l) => l.symbol === "RDOG")!.token : "", eth(0.5));
  chain.buy([...chain.launches.values()].find((l) => l.symbol === "RDOG")!.token, eth(0.3));
  await runMarket();
  const t = await api("GET", "/tokens/rdog");
  check("market cap > 0 from curve reserves", t.data.mcap > 0, t.data.mcap);
  check("24h volume counted from curve trades (~$2,000 for 0.8 ETH)", Math.abs(t.data.volume - 2000) < 5, t.data.volume);
  check("holders from Blockscout", t.data.holders === 42, t.data.holders);
  check("graduation progress between 0 and 1", t.data.progress > 0 && t.data.progress < 1, t.data.progress);
});

// ============================================================================================
sec("7. Shillers: post submission (no sign-in)");
const now = Date.now();
const mkUser = (id: string, username: string, followers = 900, ageDays = 400) =>
  xUsers.set(id, { id, username, created_at: new Date(now - ageDays * 864e5).toISOString(), public_metrics: { followers_count: followers } });
const mkTweet = (id: string, author: string, text: string, hoursAgo: number, m: Partial<Record<string, number>> = {}) =>
  xTweets.set(id, { id, author_id: author, text, created_at: new Date(now - hoursAgo * 36e5).toISOString(),
    public_metrics: { like_count: 0, reply_count: 0, retweet_count: 0, quote_count: 0, bookmark_count: 0, impression_count: 0, ...m } });
mkUser("101", "degenmaya"); mkUser("102", "chartgoblin"); mkUser("103", "freshbot", 3, 2);
// the token "launched" 26 hours ago, so its first 24h payout cycle has ended
rawDb.prepare("UPDATE launches SET launched_at = ? WHERE id = 'rdog'").run(new Date(now - 26 * 36e5).toISOString());
mkTweet("1800000000000000001", "101", "Loading up on $RDOG today, the chart looks really clean", 5, { like_count: 300, reply_count: 40, retweet_count: 20, quote_count: 5, bookmark_count: 15, impression_count: 20000 });
mkTweet("1800000000000000002", "102", "Honestly $RDOG is the best meme on Robinhood Chain right now", 4, { like_count: 120, reply_count: 10, retweet_count: 8 });
mkTweet("1800000000000000003", "103", "$RDOG gm", 3, { like_count: 900 });
mkTweet("1800000000000000004", "101", "totally unrelated post about my lunch and nothing else", 3, { like_count: 50 });
await step("submit posts", async () => {
  const a = await api("POST", "/tokens/rdog/submit", { url: "https://x.com/degenmaya/status/1800000000000000001" });
  check("valid post accepted and author credited", a.status === 200 && a.data.handle === "degenmaya", a.data);
  const b = await api("POST", "/tokens/rdog/submit", { url: "https://twitter.com/chartgoblin/status/1800000000000000002" });
  check("twitter.com links work too", b.status === 200, b.data);
  const dup = await api("POST", "/tokens/rdog/submit", { url: "https://x.com/degenmaya/status/1800000000000000001" });
  check("duplicate submission handled", /already/i.test(dup.data.message ?? ""), dup.data);
  const short = await api("POST", "/tokens/rdog/submit", { url: "https://x.com/freshbot/status/1800000000000000003" });
  check("too-short post rejected (5 real words minimum)", short.status === 400 && /words/.test(short.data.error), short.data);
  const off = await api("POST", "/tokens/rdog/submit", { url: "https://x.com/degenmaya/status/1800000000000000004" });
  check("post not mentioning the token rejected", off.status === 400 && /mention/.test(off.data.error), off.data);
  const junk = await api("POST", "/tokens/rdog/submit", { url: "https://example.com/hello" });
  check("non-X link rejected", junk.status === 400, junk.data);
  const missing = await api("POST", "/tokens/rdog/submit", { url: "https://x.com/someone/status/1899999999999999999" });
  check("deleted/missing post rejected", missing.status === 404, missing.data);
});

// ============================================================================================
sec("8. Tracker finds follow-up posts; engagement refresh");
const { runTracker } = await import("../../src/workers/tracker.ts");
await step("automatic tracking", async () => {
  mkTweet("1800000000000000010", "102", "Second thread on $RDOG: why the creator fees model works so well", 2, { like_count: 60, reply_count: 12, retweet_count: 6 });
  mkTweet("1800000000000000011", "102", "Going to the gym today, feeling great about life honestly", 2, { like_count: 999 });
  const before = xCalls.length;
  await runTracker();
  const n = (rawDb.prepare("SELECT count(*) AS n FROM posts").get() as { n: number }).n;
  check("new post by a known shiller found automatically (3 posts tracked)", Number(n) === 3, n);
  const q = xCalls.slice(before).find((u) => u.includes("search/recent")) ?? "";
  check("search only asks for known shillers (from: filter)", decodeURIComponent(q).includes("from:degenmaya") && decodeURIComponent(q).includes("from:chartgoblin"), q);
  const t1 = xTweets.get("1800000000000000001")!; t1.public_metrics.like_count = 450;
  rawDb.prepare("UPDATE posts SET last_fetched_at = ?").run(new Date(now - 2 * 36e5).toISOString());
  await runTracker();
  const likes = (rawDb.prepare("SELECT likes FROM posts WHERE external_id='1800000000000000001'").get() as { likes: number }).likes;
  check("engagement refreshed (450 likes)", Number(likes) === 450, likes);
  const q2 = xCalls.filter((u) => u.includes("search/recent")).pop() ?? "";
  check("second search uses since_id (doesn't pay to re-read)", q2.includes("since_id="), q2);
});

// ============================================================================================
sec("9. Trust scores and leaderboard");
const { runTrust } = await import("../../src/workers/trust.ts");
await step("trust + live leaderboard", async () => {
  await runTrust();
  const tr = rawDb.prepare("SELECT score, level FROM trust").all() as { score: number; level: string }[];
  check("trust computed for active shillers (clear)", tr.length === 2 && tr.every((x) => x.level === "clear"), tr);
  const lb = await api("GET", "/tokens/rdog/leaderboard");
  check("leaderboard has 2 ranked shillers", Array.isArray(lb.data) && lb.data.length === 2, lb.data);
  check("degenmaya ranks #1 (more engagement)", lb.data[0]?.handle === "degenmaya", lb.data);
  // docs example: 450 likes, 40 comments, 25 shares, 15 saves, 20k views → 450+120+125+30+20 = 745 (text post, 1.0×)
  check("points follow the published formula (745)", lb.data[0]?.points === 745, lb.data[0]);
});

// ============================================================================================
sec("10. Fee collection into the platform fee wallet (per token)");
const { runFees } = await import("../../src/workers/fees.ts");
const rdogToken = [...chain.launches.values()].find((l) => l.symbol === "RDOG")!.token;
await step("sweep, attribute, claim", async () => {
  chain.buy(rdogToken, eth(2));
  const pending = chain.curves.get(chain.launches.get(rdogToken)!.curve)!.pending;
  await runFees();
  const led = rawDb.prepare("SELECT launch_id, amount_raw, source FROM fee_ledger").all() as { launch_id: string; amount_raw: number; source: string }[];
  const rdogFees = led.filter((l) => l.launch_id === "rdog").reduce((s, l) => s + BigInt(l.amount_raw), 0n);
  check("every wei of $RDOG's fees attributed to $RDOG", rdogFees === pending, { rdogFees, pending });
  check("escrow claimed into the fee wallet", (chain.escrow.get(FEE_WALLET) ?? 0n) === 0n, chain.escrow.get(FEE_WALLET));
  chain.buy(shillToken, eth(1));
  chain.operatorSweep(shillToken); // Pons sweeps it itself before we do
  const opAmount = chain.escrow.get(FEE_WALLET)!;
  await runFees();
  const un = await api("GET", "/admin/fees/unattributed", undefined, true);
  check("fees Pons swept itself show up as unattributed", Array.isArray(un.data) && un.data.length === 1 && BigInt(un.data[0].amount_raw) === opAmount, un.data);
  const as = await api("POST", `/admin/fees/${un.data[0].id}/assign`, { launchId: "shill" }, true);
  check("admin can assign them to $SHILL", as.data.ok === true, as.data);
});

// ============================================================================================
sec("11. Payout cycle (managed token): rank, split 80/20, move funds, queue payouts");
const { runCycles } = await import("../../src/workers/cycles.ts");
await step("cycle settles", async () => {
  const ledger = (rawDb.prepare("SELECT sum(amount_raw) AS s FROM fee_ledger WHERE launch_id='rdog' AND cycle_id IS NULL").get() as { s: number }).s;
  const fees = BigInt(ledger);
  const treasury0 = chain.bal(process.env.TREASURY_ADDRESS!), pay0 = chain.bal(process.env.PAYOUT_FUNDING_ADDRESS!);
  await runCycles();
  const cyc = rawDb.prepare("SELECT * FROM cycles WHERE launch_id='rdog'").all() as Record<string, unknown>[];
  check("cycle 0 settled", cyc.length === 1 && cyc[0]!.status === "settled", cyc);
  const burn = fees * 2000n / 10000n, pool = fees - burn;
  check("20% sent to the treasury on chain", chain.bal(process.env.TREASURY_ADDRESS!) - treasury0 === burn, { got: chain.bal(process.env.TREASURY_ADDRESS!) - treasury0, burn });
  const moved = chain.bal(process.env.PAYOUT_FUNDING_ADDRESS!) - pay0;
  check("shillers' pool (80%, minus rounding dust) sent to the payout wallet", moved <= pool && pool - moved < 10n, { moved, pool });
  const pays = rawDb.prepare("SELECT user_id, rank, points, amount_raw, amount_usd, status FROM payouts ORDER BY rank").all() as Record<string, any>[];
  check("2 payouts queued", pays.length === 2 && pays.every((p) => p.status === "queued"), pays);
  const total = pays.reduce((s, p) => s + BigInt(p.amount_raw), 0n);
  check("payouts add up to the pool", pool - total < 10n && total <= pool, { total, pool });
  const ratio = Number(BigInt(pays[0]!.amount_raw)) / Number(BigInt(pays[1]!.amount_raw));
  check("split proportional to points", Math.abs(ratio - pays[0]!.points / pays[1]!.points) < 0.001, { ratio, p: pays.map((p) => p.points) });
  check("USD value recorded (ETH at $2,500)", pays[0]!.amount_usd > 0, pays[0]);
  const again = rawDb.prepare("SELECT count(*) AS n FROM payouts").get() as { n: number };
  await runCycles();
  const after = rawDb.prepare("SELECT count(*) AS n FROM payouts").get() as { n: number };
  check("running again doesn't pay twice", Number(after.n) === Number(again.n), { before: again.n, after: after.n });
  const credited = rawDb.prepare("SELECT count(*) AS n FROM post_credit").get() as { n: number };
  check("posts credited so next cycle only pays new engagement", Number(credited.n) === 3, credited);
});

// ============================================================================================
sec("12. Admin: pay shillers through X Money, mark sent, public payouts");
await step("CSV → mark sent → public", async () => {
  const csv = await api("GET", "/admin/payouts.csv", undefined, true);
  const lines = String(csv.data).trim().split("\n");
  check("CSV lists both payouts with X handles", lines.length === 3 && lines[1]!.includes("degenmaya"), lines);
  const noauth = await api("GET", "/admin/payouts.csv");
  check("admin endpoints need the admin password", noauth.status === 401, noauth.status);
  const ids = (rawDb.prepare("SELECT id FROM payouts").all() as { id: number }[]).map((x) => Number(x.id));
  const ms = await api("POST", "/admin/payouts/mark-sent", { ids, ref: "xmoney-batch-1" }, true);
  check("marked sent", ms.data.updated === 2, ms.data);
  const pub = await api("GET", "/payouts");
  check("payouts page shows them", Array.isArray(pub.data) && pub.data.length === 2 && pub.data[0].amount > 0, pub.data);
  const st = await api("GET", "/stats");
  check("homepage stats show total paid", st.data.paid > 0 && st.data.launches >= 2, st.data);
});

// ============================================================================================
sec("13. Token launched with your own fee wallet (manual payouts)");
await step("add + settle manually", async () => {
  const m = chain.launch({ deployer: addr("me"), feeRecipient: addr("my-own-wallet"), name: "Manual", symbol: "MANU", tax: 300, via: "proxima" });
  const r = await api("POST", "/admin/tokens", { address: m.token, topN: 10, schedule: "24h" }, true);
  check("added; fee % read from Pons; payouts manual", r.data.ok && /manual/.test(r.data.payouts), r.data);
  const t = await api("GET", "/tokens/manu");
  check("no 'Fees locked' badge for it", t.data.feesLocked === false, t.data);
  rawDb.prepare("UPDATE launches SET launched_at = ? WHERE id='manu'").run(new Date(now - 26 * 36e5).toISOString());
  mkUser("104", "manufan");
  mkTweet("1800000000000000020", "104", "Manual payouts but $MANU is still worth shilling hard today", 3, { like_count: 80, reply_count: 5 });
  await api("POST", "/tokens/manu/submit", { url: "https://x.com/manufan/status/1800000000000000020" });
  await runCycles();
  const w = await api("GET", "/admin/cycles", undefined, true);
  check("cycle waits for you to enter the fee amount", w.data.some?.((c: any) => c.launch_id === "manu" && c.status === "awaiting_fees"), w.data);
  const s = await api("POST", "/admin/tokens/manu/settle", { feesRaw: String(eth(0.4)) }, true);
  check("settle returns burn share + payout list", s.data.burnRaw === String(eth(0.08)) && s.data.payouts?.length === 1 && s.data.payouts[0].handle === "manufan", s.data);
});

// ============================================================================================
sec("14. X API spending cap");
await step("cap enforced", async () => {
  const u = await api("GET", "/admin/usage", undefined, true);
  check("spend tracked", u.data.x.spentUsd > 0 && u.data.x.budgetUsd === 50, u.data);
  rawDb.prepare("INSERT INTO api_usage (month, platform, purpose, post_reads, user_reads, cost_usd) VALUES (?, 'x', 'refresh', 0, 0, 50) ON CONFLICT (month, platform, purpose) DO UPDATE SET cost_usd = cost_usd + 50").run(new Date().toISOString().slice(0, 7));
  mkTweet("1800000000000000030", "101", "Yet another banger about $RDOG and its amazing community vibes", 1, { like_count: 5 });
  const r = await api("POST", "/tokens/rdog/submit", { url: "https://x.com/degenmaya/status/1800000000000000030" });
  check("once $50 is used, X calls stop with a clear message", r.status === 503 && /paused/.test(r.data.error), r.data);
  const before = xCalls.length; await runTracker();
  check("tracker makes no X calls over budget", xCalls.length === before, xCalls.slice(before));
});

// ============================================================================================
sec("15. Moderation and safety");
await step("hide / unhide", async () => {
  const h = await api("POST", "/admin/tokens/manu/hide", undefined, true);
  const list = await api("GET", "/tokens");
  check("hidden token removed from the site", h.data.ok && !list.data.some((t: any) => t.id === "manu"), list.data.map?.((t: any) => t.id));
  await api("POST", "/admin/tokens/manu/unhide", undefined, true);
  await new Promise((r) => setTimeout(r, 3100));
  const list2 = await api("GET", "/tokens");
  check("unhide brings it back", list2.data.some((t: any) => t.id === "manu"), list2.data.map?.((t: any) => t.id));
});
await step("wrong fee wallet secret is caught", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "--import", "./test/sim/register.mjs", "-e",
    "process.env.TEST_FEE_WALLET_KEY='right';process.env.FEE_WALLET_PRIVATE_KEY='wrong';const {feeWallet}=await import('./src/chain/feeWallet.ts');try{feeWallet();console.log('NO ERROR')}catch(e){console.log(e.message)}"],
    { env: { ...process.env }, cwd: process.cwd() });
  let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  await new Promise((r) => child.on("exit", r));
  check("refuses a secret that doesn't unlock 0xf71a…16d3", out.includes("but the fee wallet is 0xf71a"), out.slice(0, 300));
});

// ============================================================================================
console.log("\n──────────────────────────────────────────────");
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log("\nFailed:"); failed.forEach((f) => console.log(`  ✗ ${f.name}\n      ${f.info}`)); }
console.log("\nExternal services called (all mocked):", [...new Set(external.map((u) => new URL(u).host))].join(", "));
if (process.env.KEEP_SERVER) { console.log("SERVER READY"); await new Promise((r) => setTimeout(r, Number(process.env.KEEP_SERVER))); }
process.exit(failed.length ? 1 : 0);
