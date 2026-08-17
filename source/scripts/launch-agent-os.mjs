// Agent OS launcher.
//
// Starts the production server and hands the browser exactly one Workbench
// bootstrap navigation. The bootstrap secret lives only in this process and in
// the server's environment: it is never written to disk, never printed, and
// never reaches page JavaScript. Without this channel the Workbench cannot
// issue a browser session, so Codex and Claude cannot be started from the UI.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";

const port = Number(process.env.PORT ?? 3737);
const host = "127.0.0.1";
const readyTimeoutMs = 90_000;
const pollIntervalMs = 500;

const secret = process.env.AGENT_OS_WORKBENCH_BOOTSTRAP_SECRET?.trim()
  || randomBytes(32).toString("base64url");

const server = spawn(
  process.execPath,
  [path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next"), "start", "-H", host, "-p", String(port)],
  {
    stdio: "inherit",
    env: { ...process.env, AGENT_OS_WORKBENCH_BOOTSTRAP_SECRET: secret },
  },
);

let stopping = false;
const stop = (signal) => {
  if (stopping) return;
  stopping = true;
  server.kill(signal);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
server.on("exit", (code, signal) => {
  process.exitCode = typeof code === "number" ? code : signal ? 1 : 0;
});

function openBrowser(url) {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
}

async function waitForServer() {
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline && !stopping && server.exitCode === null) {
    try {
      const response = await fetch(`http://${host}:${port}/api/vitals`, { cache: "no-store" });
      if (response.ok) return true;
    } catch {
      // server not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return false;
}

if (await waitForServer()) {
  // One navigation, one exchange: the handler redirects to "/" so the token
  // does not stay in the address bar or in the page's history entry.
  openBrowser(`http://localhost:${port}/api/workbench/session/bootstrap?token=${encodeURIComponent(secret)}`);
} else if (!stopping && server.exitCode === null) {
  process.stderr.write(`Agent OS did not answer on http://${host}:${port} in time. Open it manually once it is up.\n`);
}
