// Imported first by the api entry point, so settings are checked before anything else loads.
import { checkEnvOrExit, SetupError } from "./check.js";
try { checkEnvOrExit("api"); }
catch (e) { if (e instanceof SetupError) await new Promise(() => {}); else throw e; }
