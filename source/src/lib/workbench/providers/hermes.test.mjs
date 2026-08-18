import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sourceRoot = process.cwd();

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: "data:text/javascript,export default undefined" };
    }
    let candidate = null;
    if (specifier.startsWith("@/")) {
      candidate = path.resolve(sourceRoot, "src", specifier.slice(2));
    } else if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
      candidate = new URL(specifier, context.parentURL);
      candidate = decodeURIComponent(candidate.pathname).replace(/^\/(?=[A-Za-z]:\/)/u, "");
    }
    if (candidate) {
      for (const target of [`${candidate}.ts`, candidate, path.join(candidate, "index.ts")]) {
        if (existsSync(target) && statSync(target).isFile()) {
          return { shortCircuit: true, url: pathToFileURL(target).href };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const {
  HermesStreamNormalizer,
  HERMES_SESSION_ID_PATTERN,
  stripTerminalControls,
} = await import("./hermesStream.ts");
const {
  createHermesRestrictedExecutionSpecResolver,
  HERMES_RESTRICTED_EXECUTION_CONTRACT,
} = await import("./hermes.ts");

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

// ---------------------------------------------------------------- stream

test("the session id Hermes actually prints is the one we accept", () => {
  // Measured from the installed CLI: `session_id: 20260818_152040_d0c64b`.
  assert.ok(HERMES_SESSION_ID_PATTERN.test("20260818_152040_d0c64b"));
  assert.ok(!HERMES_SESSION_ID_PATTERN.test("50742ae3-3ff6-577e-9531-5cdc279a1bfc"));
  assert.ok(!HERMES_SESSION_ID_PATTERN.test("20260818_152040_D0C64B"));
  assert.ok(!HERMES_SESSION_ID_PATTERN.test("../../etc/passwd"));
});

test("terminal control sequences are stripped from stored text", () => {
  assert.equal(stripTerminalControls(`${ESC}[32mgreen${ESC}[0m`), "green");
  assert.equal(stripTerminalControls(`${ESC}]0;window title${BEL}body`), "body");
  assert.equal(stripTerminalControls("plain"), "plain");
});

test("stdout becomes one assistant message and stderr yields the session", () => {
  const parser = new HermesStreamNormalizer();
  assert.deepEqual(parser.pushStdout("The plan "), []);
  assert.deepEqual(parser.pushStdout("is ready."), []);
  const fromStderr = parser.pushStderr("session_id: 20260818_152040_d0c64b\n");
  assert.deepEqual(fromStderr, [{ type: "session", sessionId: "20260818_152040_d0c64b" }]);

  const events = parser.finish({ requireSession: true });
  const assistant = events.filter((event) => event.type === "assistant");
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0].text, "The plan is ready.");
});

test("the session is announced only once, however many chunks arrive", () => {
  const parser = new HermesStreamNormalizer();
  parser.pushStderr("session_id: 20260818_152040_d0c64b\n");
  assert.deepEqual(parser.pushStderr("more noise\n"), []);
  const sessions = parser.finish().filter((event) => event.type === "session");
  assert.equal(sessions.length, 0);
});

test("resuming a different session is reported as an error, not accepted", () => {
  const parser = new HermesStreamNormalizer({ expectedSessionId: "20260818_111111_aaaaaa" });
  const events = parser.pushStderr("session_id: 20260818_222222_bbbbbb\n");
  assert.equal(events[0].type, "diagnostic");
  assert.equal(events[0].severity, "error");
});

test("a malformed session id is refused rather than bound", () => {
  const parser = new HermesStreamNormalizer();
  const events = parser.pushStderr("session_id: not-a-session\n");
  assert.equal(events[0].type, "diagnostic");
  assert.equal(events[0].severity, "error");
});

test("an empty answer is an explicit error, never a silent success", () => {
  const parser = new HermesStreamNormalizer();
  parser.pushStderr("session_id: 20260818_152040_d0c64b\n");
  const events = parser.finish({ requireSession: true });
  assert.ok(events.some((event) => event.type === "diagnostic" && event.severity === "error"));
  assert.ok(!events.some((event) => event.type === "assistant"));
});

test("stderr noise is kept as a diagnostic and never becomes the answer", () => {
  const parser = new HermesStreamNormalizer();
  parser.pushStdout("answer");
  parser.pushStderr("Warning: Unknown toolsets: messaging\nsession_id: 20260818_152040_d0c64b\n");
  const events = parser.finish();
  const assistant = events.filter((event) => event.type === "assistant");
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0].text, "answer");
  const noise = events.find((event) => event.type === "diagnostic" && event.severity === "info");
  assert.match(noise.message, /Unknown toolsets/);
  assert.doesNotMatch(noise.message, /session_id/);
});

// ---------------------------------------------------------------- resolver

const CWD = Object.freeze({
  schemaVersion: 1,
  provider: "hermes",
  projectId: "setup-center",
  absolutePath: "C:\\folders\\setup-center",
  device: 1,
  inode: 2,
  modifiedMs: 3,
});

function resolver(overrides = {}) {
  return createHermesRestrictedExecutionSpecResolver({
    configuredExecutable: "C:\\hermes\\hermes.exe",
    baseEnvironment: { Path: "C:\\Windows" },
    dependencies: {
      resolveProjectLaunchDirectory: async () => CWD,
      verifyExecutableIdentity: async () => ({
        schemaVersion: 2,
        provider: "hermes",
        sha256: "a".repeat(64),
        version: "hermes 0.17.0",
        observedAt: new Date(0).toISOString(),
        launchPath: "C:\\hermes\\hermes.exe",
        launchArgsPrefix: [],
        files: [],
      }),
      buildChildEnvironment: () => ({ Path: "C:\\Windows" }),
      ...overrides,
    },
  });
}

function command(payload, operation = "start") {
  return { provider: "hermes", operation, payload };
}

const BASE = { schemaVersion: 1, provider: "hermes", operation: "start", prompt: "plan this", projectId: "setup-center" };

test("a start command produces the restricted argv with the prompt last", async () => {
  const spec = await resolver()(command(BASE), new AbortController().signal);
  assert.deepEqual([...spec.args], [
    "chat", "-Q", "--ignore-rules", "-t", "clarify",
    "--max-turns", "1", "--source", "agent-os",
    "-q", "plan this",
  ]);
  // The prompt is in argv, so stdin must stay empty: the attestation binds on
  // exactly this shape.
  assert.equal(spec.input, "");
});

test("a resume command carries the session before the prompt", async () => {
  const spec = await resolver()(
    command({ ...BASE, operation: "resume", nativeSessionId: "20260818_152040_d0c64b" }, "resume"),
    new AbortController().signal,
  );
  assert.deepEqual([...spec.args].slice(-4), ["--resume", "20260818_152040_d0c64b", "-q", "plan this"]);
});

test("the single-toolset restriction is not optional", async () => {
  const spec = await resolver()(command(BASE), new AbortController().signal);
  const toolsetIndex = spec.args.indexOf("-t");
  assert.notEqual(toolsetIndex, -1);
  assert.equal(spec.args[toolsetIndex + 1], HERMES_RESTRICTED_EXECUTION_CONTRACT.restrictedToolset);
  assert.ok(spec.args.includes("--ignore-rules"));
  // Measured: both of these leave the terminal toolset live, so neither may be
  // relied on as the restriction.
  assert.ok(!spec.args.includes("--safe-mode"));
  assert.ok(!spec.args.includes("--ignore-user-config"));
});

test("approval bypass flags can never be produced", async () => {
  const spec = await resolver()(command(BASE), new AbortController().signal);
  assert.ok(!spec.args.includes("--yolo"));
  assert.ok(!spec.args.includes("--accept-hooks"));
});

test("a payload with an unexpected field is refused", async () => {
  await assert.rejects(
    () => resolver()(command({ ...BASE, model: "gpt-5" }), new AbortController().signal),
    /unsupported fields/i,
  );
});

test("start cannot target an existing session and resume cannot invent one", async () => {
  await assert.rejects(
    () => resolver()(command({ ...BASE, nativeSessionId: "20260818_152040_d0c64b" }), new AbortController().signal),
    /existing native session/i,
  );
  await assert.rejects(
    () => resolver()(command({ ...BASE, operation: "resume", nativeSessionId: "nope" }, "resume"), new AbortController().signal),
    /valid native session identifier/i,
  );
});

test("a prompt too large for a Windows command line is refused", async () => {
  await assert.rejects(
    () => resolver()(command({ ...BASE, prompt: "x".repeat(25 * 1024) }), new AbortController().signal),
    /byte limit/i,
  );
});

test("the contract records that the prompt travels in argv", () => {
  assert.equal(HERMES_RESTRICTED_EXECUTION_CONTRACT.promptTransport, "argv");
});
