import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTrust } from "../src/scoring/trust.js";

const now = new Date("2026-09-26T12:00:00Z");
const DAY = 86_400_000;
const oldAcct = { createdAt: new Date(now.getTime() - 400 * DAY), followers: 5000 };

test("normal user is clear", () => {
  const r = computeTrust({ now, accounts: [oldAcct], posts: [{ postedAt: now, text: "RDOG looks strong today honestly", likes: 20, comments: 3, shares: 1 }] });
  assert.equal(r.score, 1);
  assert.equal(r.level, "clear");
});

test("new low-follower account drops to limited", () => {
  const r = computeTrust({ now, accounts: [{ createdAt: new Date(now.getTime() - 5 * DAY), followers: 3 }], posts: [] });
  assert.deepEqual(r.signals.sort(), ["low_followers", "new_account"]);
  assert.equal(r.score, 0.6);
  assert.equal(r.level, "limited");
});

test("established accounts can't drop below watch for behavior alone", () => {
  const t = now.getTime();
  const posts = Array.from({ length: 5 }, (_, i) => ({ postedAt: new Date(t - i * 5000), text: "buy $RDOG now it is going up fast", likes: 1, comments: 1, shares: 0 }));
  const r = computeTrust({ now, accounts: [oldAcct], posts });
  assert.ok(r.signals.includes("burst_posting"));
  assert.ok(r.signals.includes("near_duplicates"));
  assert.equal(r.score, 0.75);
});

test("volume over 50 in 24h with a new account gets blocked", () => {
  const posts = Array.from({ length: 51 }, (_, i) => ({ postedAt: new Date(now.getTime() - i * 600_000), text: `post number ${i} about the coin`, likes: 0, comments: 0, shares: 0 }));
  const r = computeTrust({ now, accounts: [{ createdAt: new Date(now.getTime() - DAY), followers: 10 }], posts });
  assert.equal(r.level, "blocked");
});
