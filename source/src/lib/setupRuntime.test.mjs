import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
      const target = existsSync(candidate) ? candidate : `${candidate}.ts`;
      if (existsSync(target)) return { shortCircuit: true, url: pathToFileURL(target).href };
    }
    return nextResolve(specifier, context);
  },
});

const { spawnInvocation } = await import("./setupRuntime.ts");

function findOnPath(base) {
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ".com"] : [""];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory.replace(/^"|"$/g, ""), `${base}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function runFixed(executable, args) {
  const invocation = spawnInvocation(executable, args);
  return new Promise((resolve) => {
    let output = "";
    const child = spawn(invocation.command, invocation.args, {
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: invocation.verbatim,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", (error) => resolve({ code: -1, output: error.message }));
    child.once("close", (code) => resolve({ code, output }));
  });
}

test("a non-wrapper executable is spawned directly", () => {
  const invocation = spawnInvocation("C:\\tools\\ollama.exe", ["serve"]);
  assert.deepEqual(invocation, { command: "C:\\tools\\ollama.exe", args: ["serve"] });
  assert.equal(invocation.verbatim, undefined);
});

test("a cmd wrapper keeps its quoted path inside one extra quote pair", { skip: process.platform !== "win32" }, () => {
  const invocation = spawnInvocation("C:\\Program Files\\nodejs\\npm.cmd", ["install", "-g", "opencode-ai@1.18.16"]);
  assert.equal(invocation.verbatim, true);
  assert.deepEqual(invocation.args, [
    "/d",
    "/s",
    "/c",
    '""C:\\Program Files\\nodejs\\npm.cmd" install -g opencode-ai@1.18.16"',
  ]);
});

test("an argument outside the allowlist is refused", () => {
  assert.throws(() => spawnInvocation("C:\\Program Files\\nodejs\\npm.cmd", ["install", "&& calc"]));
});

test("a cmd-operator character in the path is refused", () => {
  assert.throws(() => spawnInvocation("C:\\a & b\\npm.cmd", ["--version"]));
});

// The regression this guards: the previous `call "<path>" <args>` form reached
// cmd.exe re-escaped by Node as \"<path>\", so every npm/npx action failed with
// "is not recognized" no matter what it was asked to do.
const npm = process.platform === "win32" ? findOnPath("npm") : null;

test("a real cmd wrapper resolves and reports success", { skip: npm ? false : "npm.cmd not on PATH" }, async () => {
  const result = await runFixed(npm, ["--version"]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /^\d+\.\d+\.\d+/);
});

test("a real cmd wrapper reports failure instead of a resolution error", { skip: npm ? false : "npm.cmd not on PATH" }, async () => {
  const result = await runFixed(npm, ["view", "agentos-probe-package-that-cannot-exist-9f3a"]);
  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.output, /is not recognized as an internal or external command/);
});
