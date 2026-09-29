# $SHILL backend

The backend for the $SHILL launchpad on Robinhood Chain. It creates launch wallets, deploys tokens on
Pons, tracks shill posts across platforms, scores them, runs the anti-bot trust system, settles
payout cycles (80% to shillers, 20% to $SHILL buyback and burn), and serves the API the website uses.

## How it fits together

```
Website ──HTTP──▶ API server (src/server.ts)
                     │
                     ▼
                 Postgres ◀── Worker (src/workers/index.ts)
                                ├─ discover  every 4s   auto-list any Pons v2 token whose fees go to the fee wallet
                                ├─ fees      every 10m  sweep each token's creator fees into the fee wallet, per token
                                ├─ tracker   every 1m   find new X posts about any token, refresh engagement every 5m
                                ├─ trust     every 15m  recompute trust scores
                                ├─ cycles    every 1m   sweep + claim → rank → split 80/20 → move funds → queue payouts
                                ├─ payouts   every 5m   send queued payouts (when an automated provider is set)
                                └─ burns     every 30m  buy back and burn $SHILL (when a buyback provider is set)
```

The scoring, trust, cycle and payout-split rules are pure functions in `src/scoring` and
`src/payouts`, and they match the published docs exactly. They're covered by tests.

## Run it locally

```bash
npm install
cp .env.example .env          # fill it in (see below)
createdb shill                # or use any Postgres 14+
npm run migrate               # creates/updates database tables (safe to run every deploy)
npm test                      # scoring, trust, payouts, budget, crypto
npm run dev                   # API on :8080
npm run dev:worker            # background jobs
```

Generate `ADMIN_TOKEN` with `openssl rand -hex 32`. Put the fee wallet's private key or seed phrase in
`FEE_WALLET_PRIVATE_KEY` or `FEE_WALLET_MNEMONIC` yourself, in your host's secret settings.

Point the website at the API by setting `CONFIG.API_BASE` in the site to your `PUBLIC_BASE_URL`, and
`DEMO: false`.

## Full offline simulation

`npm run test:sim` (Node 22+) runs the real backend end to end with no database, blockchain or API keys:
SQLite stands in for Postgres (running the real migrations and queries), a simulated Robinhood Chain implements
Pons v2's launch, curve fees, sweeps and escrow claims, and X / DexScreener / Blockscout / DeFiLlama are mocked.
It covers startup checks, migrations, launch verification, auto-listing, market data, post submission, tracking,
trust, leaderboards, per-token fee collection, 80/20 payout cycles, admin payouts, manual tokens, the X budget
cap, moderation and the fee wallet safety check (87 checks).

## What's finished, and what needs you

**Finished and tested**
- Launch flow (Pons v2): the launcher connects their wallet, the site derives a fresh launch wallet from their
  signature (only they can open it), they fund it, and it launches on Pons with the platform fee wallet as the
  creator-fee recipient. The backend verifies every launch on chain before listing it.
- Fee collection: one platform fee wallet for all launches, with per-token attribution (each token is swept on
  its own and the escrow increase is recorded), so each token's shillers are paid from that token's fees.
- Scoring (interaction points × content bonus × trust), daily limits, caps, the 7-day window, and
  per-cycle crediting so each cycle only pays for new engagement.
- Trust score with every published signal, trust levels, and protection for established accounts.
- Cycles on a fixed grid from launch, the 80/20 split, top-N payouts by points, small-payout carry-over.
- Automatic X tracking with no sign-in: any public post that mentions a token's $TICKER or contract address is
  found within a minute or two and credited to its author. Pasting a post link on the token page is a backup.
- Market data read straight from the Pons contracts before graduation (price, market cap, graduation progress, 24h volume and change), DexScreener after graduation, holders from Blockscout, ETH price from DeFiLlama.
- Pons v2 launching and fee claiming, using the functions published in the official Pons docs.
- Adding tokens launched elsewhere (like $SHILL via Proxima) and settling their cycles from fees you claim yourself.
- Public API matching the website, admin endpoints, CSV payout export.

**Needs your input before launch (the code refuses to run these until configured)**

| Area | What to do | Where |
| --- | --- | --- |
| Pons access | Pons v2 only lets whitelisted addresses launch right now. The site checks `canLaunch` before anyone pays, so launches wait until Pons opens publicly or approves your setup (contact@ponsfamily.com). | Pons |
| Fee wallet | Create a dedicated wallet, put its key in `FEE_WALLET_PRIVATE_KEY` (or seed in `FEE_WALLET_MNEMONIC`), and keep ~0.01 ETH in it for gas. | host settings |
| X Money payouts | We couldn't confirm a public API for automated bulk payouts. Until then payouts are queued, exported as CSV, sent by your team and marked sent. Plug in a provider when one exists. | `src/payouts/providers.ts`, `/admin/payouts.csv` |
| Converting fees to USD | Fees arrive in ETH or stock tokens and are sent to `PAYOUT_FUNDING_ADDRESS`. Converting them for X Money is an off-chain/business step. | your treasury operations |
| Stock-token prices | ETH/USD is automatic (DeFiLlama). Stock-token pairs need a price source or `PRICE_OVERRIDES`. | `src/payouts/providers.ts` |
| Buyback & burn | Implement `buyAndBurn()` with the treasury signer and a swap route | `src/payouts/providers.ts` |
| Stock pairs | Fill in `PAIR_ADDRESSES` with Robinhood stock-token addresses | `.env` |
| Platforms | X, YouTube and Reddit are implemented. TikTok, Instagram, Facebook, pump.fun and FOMO need API access or a data vendor. | `src/social/pending.ts` |

**Other platforms:** without sign-in, only X is tracked for now. Linking TikTok, YouTube, Reddit and the
rest needs a way to prove both accounts belong to the same person; add it when you turn those on.

## API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/tokens`, `/tokens/:id` | Live tokens with market data, payout totals, fee wallet |
| GET | `/tokens/:id/leaderboard` | Current cycle, live, cached 60s |
| GET | `/leaderboard` | All-time, across tokens |
| GET | `/payouts`, `/tokens/:id/payouts` | Sent payouts |
| GET | `/stats` | Totals for the homepage |
| GET | `/launch/config` | Fee recipient, Pons addresses and RPC for the browser launch flow |
| POST | `/media` | Upload a token logo (data URL) → permanent URL |
| POST | `/launch/register` | `{ txHash, owner, topN, schedule, ... }` verifies the launch on chain and lists it |
| POST | `/rpc` | Limited JSON-RPC proxy to Robinhood Chain for the browser |
| GET | `/media/:file`, `/metadata/:id.json` | Token image and metadata (used as the token's metadata URI) |
| POST | `/tokens/:id/submit` | `{ url }` an X post link; credits and starts tracking its author |
| GET | `/admin/payouts.csv?status=queued` | Bearer `ADMIN_TOKEN` |
| POST | `/admin/payouts/mark-sent` | `{ ids, ref, amountsUsd }` |
| GET | `/admin/burns`, `/admin/launches` | Operations views |
| GET | `/admin/usage` | X API spend this month vs. the cap |
| POST | `/admin/tokens` | Add a token launched elsewhere (see below) |
| POST | `/admin/tokens/:id/hide`, `/unhide` | Take a token off the site, or bring it back |
| GET | `/admin/cycles` | Cycles waiting for a fee amount, and failed cycles |
| POST | `/admin/tokens/:id/settle` | `{ feesRaw }` settle an external token's cycle |
| POST | `/admin/cycles/:id/mark-settled` | Resume a token after fixing a failed transfer by hand |
| GET | `/admin/fees/unattributed` | Fees Pons swept itself, so they couldn't be matched to a token |
| POST | `/admin/fees/:id/assign` | `{ launchId }` assign one to a token's next payout |
| POST | `/admin/users/:id/ban` | Bans and holds queued payouts |

## Auto-listing

Any Pons v2 token whose creator-fee recipient is the platform fee wallet is listed automatically, within
seconds of launching, and runs fully automatically. That includes $SHILL if you launch it through Proxima with
the fee wallet as its fee recipient. Defaults: `AUTO_LIST_TOP_N` paid spots, `AUTO_LIST_SCHEDULE` cycle.

Anyone can point a token's fees at your wallet, so anyone can get a token listed this way. To remove one:
`POST /admin/tokens/<id>/hide` (and `/unhide` to bring it back).

## Adding a token you launched yourself (e.g. $SHILL via Proxima)

```bash
curl -X POST https://api.yourdomain/admin/tokens \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"address":"0xTOKEN","feeWallet":"0xYOUR_FEE_WALLET","creatorFee":2,"topN":25,"schedule":"24h",
       "description":"The launchpad that pays you to shill.","links":{"x":"https://x.com/SHILL_RH"}}'
```

Name and ticker are read from the contract if you leave them out. Add `"image":"data:image/png;base64,..."`
for the logo. The token appears on the site right away with its leaderboard and market data.

Because the fee wallet is yours (not a $SHILL launch wallet), the backend doesn't claim or move its fees.
When a cycle ends it shows up in `GET /admin/cycles`. Then:

1. Claim the creator fees on Pons from your fee wallet, and note the amount.
2. `POST /admin/tokens/<id>/settle` with `{"feesRaw":"<amount in wei>"}`. You get back the burn share and
   the payout list.
3. Send the burn share to your treasury and the payouts through X Money, then mark them sent.

## X API spending cap

X bills per resource read ($0.005 per post, $0.010 per user as of September 2026), and each post or user
is billed **once per UTC day** however many times it's read that day. The backend enforces a hard monthly
cap, `X_MONTHLY_BUDGET_USD` (default **$50**):

- Every X call is checked against the cap **before** it's made, and charged for what it actually returned.
  Ids already read today aren't counted again, matching X's billing.
- New-post searches stop at 80% of the cap. The last 20% is kept for engagement checks, so cycles can
  still settle with fresh numbers.
- At 100%, all X calls stop until the next month. Cycles still settle using the last numbers fetched.

How tracking spends it:

- Every minute, the tracker searches X for any post (retweets excluded) that mentions a live token's
  `$TICKER` or contract address. Several tokens share one query, and each search starts after the newest
  post already seen, so each post is paid for once. Authors become shillers automatically.
- Posts with fewer than 5 real words, or made before the token launched, are read (and billed) but not tracked.
- Engagement on every tracked post is re-checked every `X_REFRESH_MINUTES` (default 5) for 7 days. Because
  of X's once-a-day billing, that costs about $0.005 per post per day.

Rough guide: a tracked post costs about $0.04 over its 7 days, plus $0.01 per new author per day and
$0.005 for every junk post read (bots, other coins with the same ticker). Set the same limit in X's
Developer Console as a second safety net, and turn off auto-recharge on your credits.

Tuning: `X_REFRESH_MINUTES`, `X_SEARCH_MAX_PAGES` (pages of 100 posts per query per run, default 5),
`X_QUERY_MAX_LEN` (default 512). Check spend any time at `GET /admin/usage`.

## Money safety

- A cycle's split is written to the database **before** any funds move. If a transfer fails, the cycle
  is marked `failed` and that token pauses until someone reviews it. Transfers are never retried
  automatically, so nobody gets paid twice.
- Fee sweeps and cycle payouts share one lock, so they never move money from the fee wallet at the same time.
- A token is only listed if its on-chain creator-fee recipient is the platform fee wallet.

## Security checklist before mainnet

- The fee wallet key controls every token's collected fees. Keep it only in your host's secret settings,
  back up its seed phrase offline, and never share it (including in chat).
- Run the API and worker with least-privilege database users, behind HTTPS.
- Get the contract integration reviewed, and do a full testnet run of launch → trades → claim → payout.
- Talk to a lawyer about holding creator fees and running payouts for others.
