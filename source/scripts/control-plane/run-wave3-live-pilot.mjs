import { spawnSync } from "node:child_process";
import path from "node:path";

const command = process.execPath;
const playwrightCli = path.join(process.cwd(), "node_modules", "@playwright", "test", "cli.js");
const providerArgument = process.argv.find((argument) => argument.startsWith("--provider="));
const provider = providerArgument?.slice("--provider=".length) ?? null;
if (provider !== null && provider !== "codex" && provider !== "claude") {
  throw new Error("--provider must be codex or claude.");
}
const playwrightArguments = [
  playwrightCli,
  "test",
  "tests/e2e/wave3-live-pilot.spec.ts",
  "--project=chromium",
];
if (provider) playwrightArguments.push("--grep", `${provider}: live start`);
const result = spawnSync(
  command,
  playwrightArguments,
  {
    cwd: process.cwd(),
    env: { ...process.env, AGENT_OS_RUN_LIVE_PROVIDER_TESTS: "1" },
    encoding: "utf8",
    stdio: "inherit",
    windowsHide: true,
  },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
