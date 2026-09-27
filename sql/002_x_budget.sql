-- X API spend tracking (pay-per-use) and incremental search state.
CREATE TABLE IF NOT EXISTS api_usage (
  month        TEXT NOT NULL,              -- 'YYYY-MM' (UTC), matches X's monthly billing cycle closely enough
  platform     TEXT NOT NULL,
  purpose      TEXT NOT NULL,              -- search | refresh | signin
  post_reads   BIGINT NOT NULL DEFAULT 0,
  user_reads   BIGINT NOT NULL DEFAULT 0,
  cost_usd     NUMERIC(12,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (month, platform, purpose)
);

CREATE TABLE IF NOT EXISTS tracker_state (
  platform   TEXT NOT NULL,
  launch_id  TEXT NOT NULL REFERENCES launches(id) ON DELETE CASCADE,
  since_id   TEXT,                         -- newest post id already seen
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, launch_id)
);
