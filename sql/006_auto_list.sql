-- Auto-listing: every Pons v2 launch whose creator fees go to the platform fee wallet is listed automatically.
CREATE TABLE IF NOT EXISTS discovery_state (
  id          SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_block  BIGINT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lets you take a token off the site without deleting its history.
ALTER TABLE launches DROP CONSTRAINT IF EXISTS launches_status_check;
ALTER TABLE launches ADD CONSTRAINT launches_status_check
  CHECK (status IN ('waiting','deploying','live','failed','refunded','expired','hidden'));
