// Cycle math. Cycles run on a fixed grid from the moment a token launched.
export interface CycleWindow { idx: number; startsAt: Date; endsAt: Date }

export function cycleAt(launchedAt: Date, cycleSeconds: number, at: Date): CycleWindow {
  const len = cycleSeconds * 1000;
  const elapsed = Math.max(0, at.getTime() - launchedAt.getTime());
  const idx = Math.floor(elapsed / len);
  const startsAt = new Date(launchedAt.getTime() + idx * len);
  return { idx, startsAt, endsAt: new Date(startsAt.getTime() + len) };
}

/** Every cycle that has fully ended at `now` and whose index is > lastSettledIdx. */
export function dueCycles(launchedAt: Date, cycleSeconds: number, now: Date, lastSettledIdx: number): CycleWindow[] {
  const current = cycleAt(launchedAt, cycleSeconds, now);
  const out: CycleWindow[] = [];
  for (let i = lastSettledIdx + 1; i < current.idx; i++) {
    const startsAt = new Date(launchedAt.getTime() + i * cycleSeconds * 1000);
    out.push({ idx: i, startsAt, endsAt: new Date(startsAt.getTime() + cycleSeconds * 1000) });
  }
  return out;
}
