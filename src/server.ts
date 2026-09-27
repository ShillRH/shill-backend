import "./boot/api.js";
import { createServer } from "node:http";
import { config } from "./config.js";
import { dispatch } from "./http/router.js";
import { log } from "./lib/log.js";
import "./http/routes.js";
import "./http/submit.js";
import "./http/admin.js";

createServer((req, res) => { void dispatch(req, res); }).listen(config.port, () => {
  log.info("api listening", { port: config.port });
});
