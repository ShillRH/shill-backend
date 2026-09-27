// Test stand-in for the "pg" package: runs the backend's real SQL (migrations and queries) on SQLite,
// translating the Postgres-only bits. Only for the offline simulation.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const db = new DatabaseSync(":memory:");
const iso = (d: Date) => d.toISOString();
let clockOffsetMs = 0; // lets tests move time forward
export function advanceClock(ms: number) { clockOffsetMs += ms; }
export const nowDate = () => new Date(Date.now() + clockOffsetMs);
db.function("now", () => iso(nowDate()));
db.function("to_ts", (s: number | bigint) => iso(new Date(Number(s) * 1000)));
db.function("shift_now", (spec: string) => {
  const m = /^([+-])\s*(\d+)\s*(second|minute|hour|day)s?$/i.exec(String(spec).trim());
  if (!m) throw new Error(`bad interval ${spec}`);
  const unit = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5 }[m[3]!.toLowerCase() as "day"];
  return iso(new Date(nowDate().getTime() + (m[1] === "-" ? -1 : 1) * Number(m[2]) * unit));
});

// Columns whose NOT NULL a later migration drops (SQLite can't ALTER COLUMN).
const relaxed = new Set<string>();
const notUnique = new Set<string>();
for (const f of readdirSync(join(process.cwd(), "sql"))) {
  const s = readFileSync(join(process.cwd(), "sql", f), "utf8");
  for (const m of s.matchAll(/ALTER COLUMN (\w+) (?:DROP NOT NULL|SET DEFAULT)/gi)) relaxed.add(m[1]!);
  for (const m of s.matchAll(/DROP CONSTRAINT IF EXISTS launches_(\w+)_key/gi)) notUnique.add(m[1]!);
}

function stripChecks(s: string): string {
  let out = "", i = 0;
  while (i < s.length) {
    const m = /\bCHECK\s*\(/i.exec(s.slice(i));
    if (!m) { out += s.slice(i); break; }
    out += s.slice(i, i + m.index);
    let j = i + m.index + m[0].length, depth = 1;
    while (j < s.length && depth) { if (s[j] === "(") depth++; else if (s[j] === ")") depth--; j++; }
    i = j;
  }
  return out;
}

function translateDDL(sql: string): string {
  const noComments = sql.replace(/--[^\n]*/g, "");
  const stmts = noComments.split(";").map((x) => x.trim()).filter(Boolean);
  const out: string[] = [];
  for (let st of stmts) {
    if (/^ALTER TABLE \w+ (ALTER COLUMN|DROP CONSTRAINT|ADD CONSTRAINT)/i.test(st)) continue;
    st = st.replace(/ADD COLUMN IF NOT EXISTS/gi, "ADD COLUMN");
    st = stripChecks(st);
    st = st.replace(/BIGSERIAL PRIMARY KEY/gi, "INTEGER PRIMARY KEY AUTOINCREMENT").replace(/BIGSERIAL/gi, "INTEGER")
      .replace(/NUMERIC\(78,0\)/gi, "INTEGER").replace(/NUMERIC\(\d+,\d+\)/gi, "REAL").replace(/TIMESTAMPTZ/gi, "TEXT")
      .replace(/JSONB/gi, "TEXT").replace(/DOUBLE PRECISION/gi, "REAL").replace(/BOOLEAN/gi, "INTEGER")
      .replace(/DEFAULT now\(\)/gi, "DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
      .replace(/DEFAULT true/gi, "DEFAULT 1").replace(/DEFAULT false/gi, "DEFAULT 0");
    // drop NOT NULL on columns a later migration relaxes
    st = st.replace(/^(\s*)(\w+)(\s[^,\n]*?)\bNOT NULL\b/gm, (full, sp, col, rest) => relaxed.has(col) ? `${sp}${col}${rest}` : full);
    st = st.replace(/^(\s*)(\w+)([^,\n]*?)\s+UNIQUE\b/gm, (full, sp, col, rest) => notUnique.has(col) ? `${sp}${col}${rest}` : full);
    out.push(st);
  }
  return out.join(";\n") + ";";
}

function translateQuery(sql: string): string {
  return sql
    .replace(/pg_try_advisory_lock\(\$\d+\)/gi, "1").replace(/SELECT pg_advisory_unlock\(\$\d+\)/gi, "SELECT 1")
    .replace(/::[a-z]+(\[\])?/gi, "")
    .replace(/now\(\)\s*([+-])\s*interval\s*'([^']+)'/gi, (_m, op, spec) => `shift_now('${op}${spec}')`)
    .replace(/now\(\)\s*([+-])\s*\((\$\d+)\s*\|\|\s*'\s*([a-z]+)'\)/gi, (_m, op, p, unit) => `shift_now('${op}' || ${p} || ' ${unit}')`)
    .replace(/=\s*ANY\((\$\d+)\)/gi, "IN (SELECT value FROM json_each($1))")
    .replace(/GREATEST\(/gi, "max(").replace(/to_timestamp\(/gi, "to_ts(")
    .replace(/\$(\d+)/g, "?$1");
}

const INT4 = new Set(["creator_fee_bps", "top_n", "cycle_seconds", "likes", "comments", "shares", "saves", "followers", "idx", "rank", "holders", "log_index", "phase"]);
const BOOL = new Set(["banned", "deleted", "managed", "verified", "expired", "recent", "ok", "holders_stale"]);
const JSONC = new Set(["links", "signals"]);
const DATEC = (k: string) => k.endsWith("_at") || k === "t" || k === "at" || k === "account_created";

function toParam(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return iso(v);
  if (Array.isArray(v) || typeof v === "object") return JSON.stringify(v);
  return v;
}
function fromRow(r: Record<string, unknown>) {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    let x: unknown = v;
    if (typeof x === "bigint") x = INT4.has(k) ? Number(x) : BOOL.has(k) ? x !== 0n : x.toString();
    else if (BOOL.has(k) && typeof x === "number") x = x !== 0;
    if (JSONC.has(k) && typeof x === "string") { try { x = JSON.parse(x); } catch { /* keep */ } }
    if (DATEC(k) && typeof x === "string" && /^\d{4}-\d\d-\d\dT/.test(x)) x = new Date(x);
    o[k] = x;
  }
  return o;
}

let inTx = false;
export const executed: string[] = [];
function run(text: string, params: unknown[] = []) {
  const t = text.trim();
  if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(t)) {
    const w = t.toUpperCase();
    if (w === "BEGIN") { if (!inTx) { db.exec("BEGIN"); inTx = true; } }
    else if (inTx) { db.exec(w); inTx = false; }
    return { rows: [], rowCount: 0 };
  }
  const isDDL = !params.length && (/^\s*(CREATE|ALTER|DROP)\b/i.test(t) || t.replace(/--[^\n]*/g, "").split(";").filter((x) => x.trim()).length > 1);
  if (isDDL) { db.exec(translateDDL(t)); return { rows: [], rowCount: 0 }; }
  const sql = translateQuery(t);
  executed.push(sql);
  let st;
  try { st = db.prepare(sql); }
  catch (e) { throw new Error(`SQL error: ${(e as Error).message}\n--- original ---\n${t}\n--- translated ---\n${sql}`); }
  st.setReadBigInts(true);
  const ps = params.map(toParam) as (string | number | null)[];
  const obj: Record<string, unknown> = {};
  ps.forEach((p, i) => (obj[String(i + 1)] = p));
  const returns = /^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
  try {
    if (returns) { const rows = (st.all(obj as never) as Record<string, unknown>[]).map(fromRow); return { rows, rowCount: rows.length }; }
    const r = st.run(obj as never); return { rows: [], rowCount: Number(r.changes) };
  } catch (e) {
    throw new Error(`SQL run error: ${(e as Error).message}\n--- original ---\n${t}`);
  }
}

class Client {
  async query(text: string, params: unknown[] = []) { return run(text, params); }
  release() {}
}
class Pool {
  constructor(_o: unknown) {}
  async query(text: string, params: unknown[] = []) { return run(text, params); }
  async connect() { return new Client(); }
  async end() {}
}
export const rawDb = db;
export default { Pool };
