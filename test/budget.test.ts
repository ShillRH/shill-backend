import { test } from "node:test";
import assert from "node:assert/strict";
import { canSpend, costOf } from "../src/lib/budget-rules.js";
import { packQueries, tokenTerm } from "../src/social/xquery.js";

test("pricing matches X pay-per-use rates", () => {
  assert.equal(costOf(100, 0), 0.5);
  assert.equal(costOf(0, 1), 0.01);
});

test("searches stop at 80% of the budget, refreshes run to 100%", () => {
  assert.equal(canSpend(39.6, 50, 0.5, "search"), false);
  assert.equal(canSpend(39.5, 50, 0.5, "search"), true);
  assert.equal(canSpend(49.5, 50, 0.5, "refresh"), true);
  assert.equal(canSpend(49.6, 50, 0.5, "refresh"), false);
  assert.equal(canSpend(50, 50, 0.01, "signin"), false);
});

test("token search terms: cashtag and contract address", () => {
  const ca = "0x" + "ab".repeat(20);
  assert.equal(tokenTerm("RDOG", ca), `$RDOG OR "${ca}"`);
  assert.equal(tokenTerm("RDOG", null), "$RDOG");
  assert.equal(tokenTerm("my coin", ca), `"${ca}"`);      // not a valid cashtag: contract address only
  assert.equal(tokenTerm("9LIVES", null), null);
});

test("tokens are packed into queries that fit the limit", () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ key: i, term: tokenTerm(`TOKEN${i}`, "0x" + String(i).padStart(40, "0"))! }));
  const qs = packQueries(items, 512);
  assert.ok(qs.length > 1);
  for (const q of qs) {
    assert.ok(q.query.length <= 512, `query too long: ${q.query.length}`);
    assert.ok(q.query.endsWith("-is:retweet"));
    for (const k of q.keys) assert.ok(q.query.includes(`$TOKEN${k} `));
  }
  assert.deepEqual(qs.flatMap((q) => q.keys), items.map((i) => i.key));   // every token searched exactly once
  assert.deepEqual(packQueries([], 512), []);
});
