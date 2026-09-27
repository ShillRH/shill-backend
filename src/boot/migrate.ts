// Imported first by the migrate entry point, so settings are checked before anything else loads.
import { checkEnvOrExit, SetupError } from "./check.js";
try { checkEnvOrExit("migrate"); }
catch (e) { if (e instanceof SetupError) await new Promise(() => {}); else throw e; }
