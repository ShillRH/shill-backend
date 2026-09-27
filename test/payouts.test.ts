import { test } from "node:test";
import assert from "node:assert/strict";
import { splitFees } from "../src/payouts/split.js";
import { cycleAt, dueCycles } from "../src/payouts/cycles.js";

test("docs example: $1,000 fees, 20% burn, 5% share = $40", () => {
  const fees = 1000_000000n; // $1,000 in 6-decimal units
  const ranked = [{ userId: "me", points: 2500 }, { userId: "rest", points: 47500 }];
  const r = splitFees(fees, ranked, { platformFeePct: 20, topN: 25, minAmount: 100_000n });
  assert.equal(r.burn, 200_000000n);
  assert.equal(r.pool, 800_000000n);
  assert.equal(r.payouts.find((p) => p.userId === "me")!.amount, 40_000000n);
  assert.equal(r.dust, 0n);
});

test("only the top N are paid", () => {
  const ranked = Array.from({ length: 30 }, (_, i) => ({ userId: i, points: 100 - i }));
  const r = splitFees(10_000n, ranked, { platformFeePct: 20, topN: 25, minAmount: 0n });
  assert.equal(r.payouts.length, 25);
  assert.ok(!r.payouts.some((p) => p.userId === 29));
});

test("tiny shares are carried, and carry-ins are added", () => {
  const r = splitFees(1000n, [{ userId: "a", points: 999 }, { userId: "b", points: 1 }],
    { platformFeePct: 20, topN: 10, minAmount: 10n, carryIn: new Map([["b", 5n]]) });
  const b = r.payouts.find((p) => p.userId === "b")!;
  assert.equal(b.status, "carried");
  assert.equal(b.amount, 5n); // 0 new + 5 carried, still under the minimum
});

test("no eligible shillers keeps the pool as dust", () => {
  const r = splitFees(1000n, [], { platformFeePct: 20, topN: 10, minAmount: 0n });
  assert.equal(r.dust, 800n);
});

test("cycles run on a fixed grid from launch", () => {
  const launched = new Date("2026-09-26T02:00:00Z");
  const c = cycleAt(launched, 4 * 3600, new Date("2026-09-26T07:30:00Z"));
  assert.equal(c.idx, 1);
  assert.equal(c.endsAt.toISOString(), "2026-09-26T10:00:00.000Z");
  assert.deepEqual(dueCycles(launched, 4 * 3600, new Date("2026-09-26T15:00:00Z"), -1).map((d) => d.idx), [0, 1, 2]);
});
