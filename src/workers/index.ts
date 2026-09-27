// Worker process: runs every background job on its own interval.
// Advisory locks make it safe to run more than one worker instance.
import "../boot/worker.js";
import { withLock } from "../db.js";
import { log, errMsg } from "../lib/log.js";
import { runTracker } from "./tracker.js";
import { runTrust } from "./trust.js";
import { runCycles } from "./cycles.js";
import { runPayouts } from "./payouts.js";
import { runBurns } from "./burns.js";
import { runMarket } from "./market.js";
import { runFees } from "./fees.js";
import { runDiscover } from "./discover.js";

const jobs: { name: string; everyMs: number; lock: number; fn: () => Promise<void> }[] = [
  { name: "discover", everyMs: 4_000, lock: 1008, fn: runDiscover },  // new tokens appear within seconds
  { name: "tracker", everyMs: 5 * 60_000, lock: 1002, fn: runTracker },
  { name: "trust", everyMs: 15 * 60_000, lock: 1003, fn: runTrust },
  { name: "cycles", everyMs: 60_000, lock: 1004, fn: runCycles },
  // shares the cycles lock: both move money from the fee wallet, so they never run at the same time
  { name: "fees", everyMs: 10 * 60_000, lock: 1004, fn: runFees },
  { name: "payouts", everyMs: 5 * 60_000, lock: 1005, fn: runPayouts },
  { name: "burns", everyMs: 30 * 60_000, lock: 1006, fn: runBurns },
  { name: "market", everyMs: 60_000, lock: 1007, fn: runMarket },
];

for (const job of jobs) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await withLock(job.lock, job.fn); }
    catch (e) { log.error("job crashed", { job: job.name, error: errMsg(e) }); }
    finally { running = false; }
  };
  void tick();
  setInterval(tick, job.everyMs);
}
log.info("worker started", { jobs: jobs.map((j) => j.name) });
