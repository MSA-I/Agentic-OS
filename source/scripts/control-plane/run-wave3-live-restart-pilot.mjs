import { spawnSync } from "node:child_process";
import path from "node:path";

const providerArgument = process.argv.find((argument) => argument.startsWith("--provider="));
const provider = providerArgument?.slice("--provider=".length) ?? null;
if (provider !== null && provider !== "codex" && provider !== "claude") {
  throw new Error("--provider must be codex or claude.");
}

const portArgument = process.argv.find((argument) => argument.startsWith("--port="));
const portText = portArgument?.slice("--port=".length) ?? "3113";
const port = Number(portText);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
  throw new Error("--port must be an unprivileged TCP port from 1024 through 65535.");
}

const playwrightCli = path.join(process.cwd(), "node_modules", "@playwright", "test", "cli.js");
const result = spawnSync(
  process.execPath,
  [playwrightCli, "test", "tests/e2e/wave3-live-restart.spec.ts", "--project=chromium"],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_OS_RUN_LIVE_PROVIDER_TESTS: "1",
      PLAYWRIGHT_BASE_URL: `http://127.0.0.1:${port}`,
      WAVE3_LIVE_PROVIDER_FILTER: provider ?? "",
      WAVE3_RESTART_PORT: String(port),
    },
    encoding: "utf8",
    stdio: "inherit",
    windowsHide: true,
  },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
