import { test } from "node:test";
import assert from "node:assert/strict";
import { canSpend, costOf } from "../src/lib/budget-rules.js";
import { buildQueries } from "../src/social/xquery.js";

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

test("author filters are split to fit the query limit", () => {
  const authors = Array.from({ length: 60 }, (_, i) => `shiller_number_${i}`);
  const qs = buildQueries('($RDOG OR "0xabc") -is:retweet', authors, 512);
  assert.ok(qs.length > 1);
  for (const q of qs) assert.ok(q.length <= 512, `query too long: ${q.length}`);
  const all = qs.join(" ");
  for (const a of authors) assert.ok(all.includes(`from:${a}`));
  assert.deepEqual(buildQueries("x", []), []);
});
