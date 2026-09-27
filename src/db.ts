import pg from "pg";
import { config } from "./config.js";

// NUMERIC columns come back as strings; we convert explicitly with BigInt() where needed.
let _pool: pg.Pool | null = null;
/** Created on first use, so a missing setting is reported by the startup check instead of crashing on import. */
export function getPool(): pg.Pool {
  return (_pool ??= new pg.Pool({ connectionString: config.databaseUrl(), max: 10 }));
}
export const pool = {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<pg.QueryResult<T>> {
    return getPool().query<T>(text, params);
  },
  connect: () => getPool().connect(),
  end: () => getPool().end(),
};

export async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await pool.query<T>(text, params);
  return r.rows;
}
export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T | null> {
  return (await q<T>(text, params))[0] ?? null;
}

/** Run a function inside a transaction. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

/**
 * Advisory lock so only one worker instance runs a job at a time,
 * even if you scale workers horizontally.
 */
export async function withLock<T>(key: number, fn: () => Promise<T>): Promise<T | undefined> {
  const c = await pool.connect();
  try {
    const got = await c.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [key]);
    if (!got.rows[0]?.ok) return undefined;
    try { return await fn(); } finally { await c.query("SELECT pg_advisory_unlock($1)", [key]); }
  } finally {
    c.release();
  }
}
