// Imported first by the worker entry point, so settings are checked before anything else loads.
import { checkEnvOrExit, SetupError } from "./check.js";
try { checkEnvOrExit("worker"); }
catch (e) { if (e instanceof SetupError) await new Promise(() => {}); else throw e; }
