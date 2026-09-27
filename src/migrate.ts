import "./boot/migrate.js";
// Applies every sql/*.sql file once, in order. Each file runs in its own transaction on ONE connection,
// so a failed file is rolled back completely and nothing is left half-applied.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pool } from "./db.js";

const dir = join(process.cwd(), "sql");
const c = await pool.connect();
try {
  await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const done = await c.query("SELECT 1 FROM schema_migrations WHERE name = $1", [f]);
    if (done.rowCount) continue;
    const sql = await readFile(join(dir, f), "utf8");
    await c.query("BEGIN");
    try {
      await c.query(sql);
      await c.query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
      await c.query("COMMIT");
      console.log(`applied ${f}`);
    } catch (e) {
      await c.query("ROLLBACK");
      console.error(`migration ${f} failed and was rolled back`);
      throw e;
    }
  }
  console.log("database is up to date");
} finally {
  c.release();
  await pool.end();
}
