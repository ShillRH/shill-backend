-- Launches from the site: the launcher connects their own wallet, the site derives a fresh launch wallet
-- that only they can open, and every launch's creator fees go to the single platform fee wallet.
ALTER TABLE launches ADD COLUMN IF NOT EXISTS owner    TEXT;   -- launcher's connected wallet
ALTER TABLE launches ADD COLUMN IF NOT EXISTS deployer TEXT;   -- the fresh launch wallet that deployed on Pons
ALTER TABLE launches ALTER COLUMN receiver DROP NOT NULL;
ALTER TABLE launches ALTER COLUMN wallet_address DROP NOT NULL;
ALTER TABLE launches ALTER COLUMN amount_wei SET DEFAULT 0;
ALTER TABLE launches ALTER COLUMN deadline_at SET DEFAULT now();

-- Every fee sweep into the platform fee wallet's escrow balance, attributed to the token it came from.
CREATE TABLE IF NOT EXISTS fee_ledger (
  id          BIGSERIAL PRIMARY KEY,
  launch_id   TEXT REFERENCES launches(id) ON DELETE CASCADE,  -- NULL = arrived without attribution (swept by Pons)
  asset       TEXT NOT NULL DEFAULT 'ETH',
  amount_raw  NUMERIC(78,0) NOT NULL,
  source      TEXT NOT NULL,                                   -- sweep | unattributed
  tx_hash     TEXT,
  cycle_id    BIGINT REFERENCES cycles(id),                    -- set when the amount is paid out
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fee_ledger_open_idx ON fee_ledger(launch_id) WHERE cycle_id IS NULL;

CREATE TABLE IF NOT EXISTS fee_wallet_state (
  id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  escrow_known    NUMERIC(78,0) NOT NULL DEFAULT 0,   -- escrow balance we've already attributed
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO fee_wallet_state (id) VALUES (1) ON CONFLICT DO NOTHING;

-- Pons allows a creator tax of 0; the protocol cap is enforced on chain.
ALTER TABLE launches DROP CONSTRAINT IF EXISTS launches_creator_fee_bps_check;
ALTER TABLE launches ADD CONSTRAINT launches_creator_fee_bps_check CHECK (creator_fee_bps BETWEEN 0 AND 10000);
