// Pure budget rules (no database), shared by lib/budget.ts and the tests.
export const X_PRICES = { postRead: 0.005, userRead: 0.01 };
export type Purpose = "search" | "refresh" | "signin";

/** May we make a call that could cost up to `estimate`? Searches may only use `share` of the budget. */
export function canSpend(spent: number, budget: number, estimate: number, purpose: Purpose, share = 0.8): boolean {
  const limit = purpose === "search" ? budget * share : budget;
  return spent + estimate <= limit + 1e-9;
}

export function costOf(postReads: number, userReads: number): number {
  return postReads * X_PRICES.postRead + userReads * X_PRICES.userRead;
}
