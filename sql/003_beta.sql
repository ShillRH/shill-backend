-- Beta: tokens launched outside the site (e.g. $SHILL via Proxima), post submission, market data.
ALTER TABLE launches ALTER COLUMN wallet_key_enc DROP NOT NULL;
ALTER TABLE launches ADD COLUMN IF NOT EXISTS managed BOOLEAN NOT NULL DEFAULT true;  -- false = fee wallet is yours, not a $SHILL launch wallet

ALTER TABLE cycles DROP CONSTRAINT IF EXISTS cycles_status_check;
ALTER TABLE cycles ADD CONSTRAINT cycles_status_check
  CHECK (status IN ('open','settling','awaiting_fees','settled','failed'));

ALTER TABLE token_market ADD COLUMN IF NOT EXISTS price_usd DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE token_market ADD COLUMN IF NOT EXISTS liquidity_usd DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE token_market ADD COLUMN IF NOT EXISTS pair_url TEXT;
ALTER TABLE token_market ADD COLUMN IF NOT EXISTS holders_updated_at TIMESTAMPTZ;
