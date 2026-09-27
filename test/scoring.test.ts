import { test } from "node:test";
import assert from "node:assert/strict";
import { interactionPoints, rawPostPoints, scorePosts, userCycleScores, SCORING, type ScorablePost } from "../src/scoring/scoring.js";

const now = new Date("2026-09-26T12:00:00Z");
const post = (o: Partial<ScorablePost>): ScorablePost => ({
  id: 1, userId: "u1", platform: "x", postedAt: new Date("2026-09-26T10:00:00Z"), realWords: 8, deleted: false,
  contentType: "text", metrics: { likes: 0, comments: 0, shares: 0, saves: 0, views: 0 }, creditedRaw: 0, ...o,
});

test("interaction points follow the published table", () => {
  assert.equal(interactionPoints({ likes: 300, comments: 40, shares: 25, saves: 15, views: 20_000 }), 300 + 120 + 125 + 30 + 20);
});

test("content bonus multiplies and the cap applies", () => {
  assert.equal(rawPostPoints({ likes: 100, comments: 0, shares: 0, saves: 0, views: 0 }, "long"), 200);
  assert.equal(rawPostPoints({ likes: 50_000, comments: 0, shares: 0, saves: 0, views: 0 }, "text"), SCORING.postCap);
});

test("matches the docs calculator example (short video)", () => {
  // 595 interaction points × 1.5 = 892.5 → 893 after rounding at the user level
  const s = scorePosts([post({ contentType: "short", metrics: { likes: 300, comments: 40, shares: 25, saves: 15, views: 20_000 } })], now);
  const u = userCycleScores(s, new Map([["u1", 1]]));
  assert.equal(u[0]!.points, 893);
});

test("short posts and deleted posts earn nothing", () => {
  const s = scorePosts([
    post({ id: 1, realWords: 2, metrics: { likes: 100, comments: 0, shares: 0, saves: 0, views: 0 } }),
    post({ id: 2, deleted: true, metrics: { likes: 100, comments: 0, shares: 0, saves: 0, views: 0 } }),
  ], now);
  assert.deepEqual(s.map((x) => x.reason), ["too_short", "deleted"]);
});

test("each cycle only pays for new engagement", () => {
  const s = scorePosts([post({ metrics: { likes: 150, comments: 0, shares: 0, saves: 0, views: 0 }, creditedRaw: 100 })], now);
  assert.equal(s[0]!.rawDelta, 50);
});

test("engagement after 7 days stops counting", () => {
  const s = scorePosts([post({ postedAt: new Date("2026-09-10T00:00:00Z"), metrics: { likes: 500, comments: 0, shares: 0, saves: 0, views: 0 } })], now);
  assert.equal(s[0]!.rawDelta, 0);
});

test("only the best 10 posts per platform per day count", () => {
  const posts = Array.from({ length: 12 }, (_, i) => post({ id: i, metrics: { likes: i + 1, comments: 0, shares: 0, saves: 0, views: 0 } }));
  const s = scorePosts(posts, now);
  const dropped = s.filter((x) => x.reason === "daily_limit").map((x) => x.id).sort();
  assert.deepEqual(dropped, [0, 1]);
});

test("trust below 0.5 blocks, trust multiplies otherwise", () => {
  const s = scorePosts([post({ userId: "a", metrics: { likes: 100, comments: 0, shares: 0, saves: 0, views: 0 } }),
                        post({ id: 2, userId: "b", metrics: { likes: 100, comments: 0, shares: 0, saves: 0, views: 0 } })], now);
  const u = userCycleScores(s, new Map([["a", 0.75], ["b", 0.4]]));
  assert.deepEqual(u, [{ userId: "a", points: 75, interactions: 0 }]);
});
