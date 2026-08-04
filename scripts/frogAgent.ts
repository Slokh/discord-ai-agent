import { spawnSync } from "node:child_process";
import path from "node:path";
import { loadConfig } from "../src/config/env.js";

const config = loadConfig([]);
const result = spawnSync(
  process.execPath,
  [path.resolve("node_modules/frog/dist/bin.js"), ...process.argv.slice(2)],
  {
    env: {
      ...process.env,
      DATABASE_URL: config.databaseUrl,
      FROG_NAMESPACE: "discord-ai-agent",
    },
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
if (result.signal) throw new Error(`Frog exited after signal ${result.signal}.`);
process.exitCode = result.status ?? 1;
