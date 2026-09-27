-- $SHILL backend schema (Postgres 14+)

CREATE TABLE IF NOT EXISTS launches (
  id               TEXT PRIMARY KEY,                 -- url-safe slug, usually the lowercased ticker
  name             TEXT NOT NULL,
  ticker           TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  image_path       TEXT,                             -- served from /media/<file>
  links            JSONB NOT NULL DEFAULT '{}',
  pair             TEXT NOT NULL,                    -- 'ETH' or a stock token symbol
  pair_address     TEXT,                             -- null for ETH
  creator_fee_bps  INTEGER NOT NULL CHECK (creator_fee_bps BETWEEN 100 AND 500),
  top_n            INTEGER NOT NULL CHECK (top_n IN (10,25,50,100)),
  cycle_seconds    INTEGER NOT NULL,
  initial_buy_wei  NUMERIC(78,0) NOT NULL DEFAULT 0,
  receiver         TEXT NOT NULL,                    -- launcher's address for initial-buy tokens + leftover ETH
  wallet_address   TEXT NOT NULL UNIQUE,             -- launch wallet = token creator = fee recipient
  wallet_key_enc   TEXT NOT NULL,                    -- AES-256-GCM encrypted private key
  amount_wei       NUMERIC(78,0) NOT NULL,           -- exact deposit required
  status           TEXT NOT NULL DEFAULT 'waiting'   -- waiting | deploying | live | failed | refunded | expired
                   CHECK (status IN ('waiting','deploying','live','failed','refunded','expired')),
  error            TEXT,
  token_address    TEXT UNIQUE,
  deploy_tx        TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deadline_at      TIMESTAMPTZ NOT NULL,
  launched_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS launches_status_idx ON launches(status);
CREATE UNIQUE INDEX IF NOT EXISTS launches_live_ticker_idx ON launches(lower(ticker)) WHERE status = 'live';

-- Market data cache, refreshed by an indexer (Bitquery / DexScreener / your own).
CREATE TABLE IF NOT EXISTS token_market (
  launch_id   TEXT PRIMARY KEY REFERENCES launches(id) ON DELETE CASCADE,
  mcap_usd    DOUBLE PRECISION NOT NULL DEFAULT 0,
  change_24h  DOUBLE PRECISION NOT NULL DEFAULT 0,
  volume_usd  DOUBLE PRECISION NOT NULL DEFAULT 0,
  holders     INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id           BIGSERIAL PRIMARY KEY,
  x_user_id    TEXT NOT NULL UNIQUE,                 -- payout identity (X Money)
  x_handle     TEXT NOT NULL,
  banned       BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_handle_idx ON users(lower(x_handle));

CREATE TABLE IF NOT EXISTS linked_accounts (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform        TEXT NOT NULL,                     -- x | tiktok | instagram | youtube | reddit | facebook | pumpfun | fomo
  handle          TEXT NOT NULL,
  external_id     TEXT,                              -- platform's stable id once verified
  followers       INTEGER,
  account_created TIMESTAMPTZ,
  code            TEXT,                              -- one-time verification code
  code_expires_at TIMESTAMPTZ,
  verified_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, platform)
);
-- one account can only belong to one profile
CREATE UNIQUE INDEX IF NOT EXISTS linked_unique_verified
  ON linked_accounts(platform, lower(handle)) WHERE verified_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS posts (
  id              BIGSERIAL PRIMARY KEY,
  platform        TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  launch_id       TEXT NOT NULL REFERENCES launches(id) ON DELETE CASCADE,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url             TEXT,
  text            TEXT NOT NULL DEFAULT '',
  content_type    TEXT NOT NULL DEFAULT 'text',      -- text | image | thread | short | long
  posted_at       TIMESTAMPTZ NOT NULL,
  likes           INTEGER NOT NULL DEFAULT 0,
  comments        INTEGER NOT NULL DEFAULT 0,
  shares          INTEGER NOT NULL DEFAULT 0,
  saves           INTEGER NOT NULL DEFAULT 0,
  views           BIGINT  NOT NULL DEFAULT 0,
  deleted         BOOLEAN NOT NULL DEFAULT false,
  last_fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, external_id, launch_id)
);
CREATE INDEX IF NOT EXISTS posts_launch_user_idx ON posts(launch_id, user_id);
CREATE INDEX IF NOT EXISTS posts_recent_idx ON posts(posted_at);

-- Points a post had already been credited with at the end of the previous cycle,
-- so each cycle only pays for engagement that arrived during it.
CREATE TABLE IF NOT EXISTS post_credit (
  post_id       BIGINT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  credited_raw  DOUBLE PRECISION NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS trust (
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  launch_id   TEXT NOT NULL REFERENCES launches(id) ON DELETE CASCADE,
  score       DOUBLE PRECISION NOT NULL DEFAULT 1,
  level       TEXT NOT NULL DEFAULT 'clear',
  signals     JSONB NOT NULL DEFAULT '[]',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, launch_id)
);

CREATE TABLE IF NOT EXISTS cycles (
  id            BIGSERIAL PRIMARY KEY,
  launch_id     TEXT NOT NULL REFERENCES launches(id) ON DELETE CASCADE,
  idx           INTEGER NOT NULL,
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','settling','settled','failed')),
  fees_raw      NUMERIC(78,0) NOT NULL DEFAULT 0,   -- in pair asset base units
  burn_raw      NUMERIC(78,0) NOT NULL DEFAULT 0,
  pool_raw      NUMERIC(78,0) NOT NULL DEFAULT 0,
  claim_tx      TEXT,
  error         TEXT,
  settled_at    TIMESTAMPTZ,
  UNIQUE (launch_id, idx)
);

CREATE TABLE IF NOT EXISTS payouts (
  id            BIGSERIAL PRIMARY KEY,
  cycle_id      BIGINT NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  launch_id     TEXT NOT NULL REFERENCES launches(id) ON DELETE CASCADE,
  user_id       BIGINT NOT NULL REFERENCES users(id),
  rank          INTEGER NOT NULL,
  points        DOUBLE PRECISION NOT NULL,
  amount_raw    NUMERIC(78,0) NOT NULL,             -- pair asset base units
  amount_usd    DOUBLE PRECISION,                   -- valuation at settlement
  status        TEXT NOT NULL DEFAULT 'queued'      -- queued | sent | failed | held | carried | merged
                CHECK (status IN ('queued','sent','failed','held','carried','merged')),
  provider_ref  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS payouts_status_idx ON payouts(status);
CREATE INDEX IF NOT EXISTS payouts_user_idx ON payouts(user_id);

-- Leaderboard snapshot for each settled cycle (public history).
CREATE TABLE IF NOT EXISTS cycle_ranks (
  cycle_id      BIGINT NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  user_id       BIGINT NOT NULL REFERENCES users(id),
  rank          INTEGER NOT NULL,
  points        DOUBLE PRECISION NOT NULL,
  interactions  BIGINT NOT NULL,
  PRIMARY KEY (cycle_id, user_id)
);

-- Burn allocation waiting to be swapped into $SHILL and burned, per asset.
CREATE TABLE IF NOT EXISTS burn_queue (
  id          BIGSERIAL PRIMARY KEY,
  launch_id   TEXT NOT NULL REFERENCES launches(id),
  asset       TEXT NOT NULL,                        -- 'ETH' or token address
  amount_raw  NUMERIC(78,0) NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  swap_tx     TEXT,
  burn_tx     TEXT,
  shill_burned NUMERIC(78,0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
