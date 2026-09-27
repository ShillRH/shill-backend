-- Every token launched through the site shares the one platform fee wallet, so the fee wallet column
-- can't be unique. (The original schema required a unique launch wallet per token.)
ALTER TABLE launches DROP CONSTRAINT IF EXISTS launches_wallet_address_key;
CREATE INDEX IF NOT EXISTS launches_wallet_idx ON launches(lower(wallet_address));
