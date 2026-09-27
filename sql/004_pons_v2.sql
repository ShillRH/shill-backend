-- Pons v2: per-launch curve address, graduation state, on-chain trade history for volume/price change.
ALTER TABLE launches ADD COLUMN IF NOT EXISTS curve_address TEXT;
ALTER TABLE token_market ADD COLUMN IF NOT EXISTS phase SMALLINT;               -- 0 curve, 1 swept, 2 pool, 3 rescued
ALTER TABLE token_market ADD COLUMN IF NOT EXISTS progress DOUBLE PRECISION;    -- 0..1 toward graduation
ALTER TABLE token_market ADD COLUMN IF NOT EXISTS source TEXT;                  -- 'curve' | 'dexscreener'

CREATE TABLE IF NOT EXISTS curve_trades (
  launch_id   TEXT NOT NULL REFERENCES launches(id) ON DELETE CASCADE,
  tx_hash     TEXT NOT NULL,
  log_index   INTEGER NOT NULL,
  block       BIGINT NOT NULL,
  side        TEXT NOT NULL,                 -- buy | sell
  quote_raw   NUMERIC(78,0) NOT NULL,        -- quote asset amount of the trade
  at          TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS curve_trades_recent_idx ON curve_trades(launch_id, at);

CREATE TABLE IF NOT EXISTS curve_scan (
  launch_id   TEXT PRIMARY KEY REFERENCES launches(id) ON DELETE CASCADE,
  last_block  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS price_history (
  launch_id   TEXT NOT NULL REFERENCES launches(id) ON DELETE CASCADE,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  price_usd   DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (launch_id, at)
);
