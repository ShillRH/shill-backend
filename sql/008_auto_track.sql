-- X bills each post and each user once per UTC day, however many times it's read that day.
-- The budget remembers what it was already billed for today so it only counts first reads.
CREATE TABLE IF NOT EXISTS x_billed (
  day   TEXT NOT NULL,              -- 'YYYY-MM-DD' (UTC)
  kind  TEXT NOT NULL,              -- post | user
  id    TEXT NOT NULL,
  PRIMARY KEY (day, kind, id)
);
