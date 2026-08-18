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
      // Some specifiers name a directory, not a file: durableControlPlane.ts
      // imports "./providers", which is src/lib/workbench/providers/. Resolve to
      // a real file or that directory's index, or the loader reads a directory.
      for (const target of [`${candidate}.ts`, candidate, path.join(candidate, "index.ts")]) {
        if (existsSync(target) && statSync(target).isFile()) {
          return { shortCircuit: true, url: pathToFileURL(target).href };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const { classifyProbeFailure } = await import("./availability.ts");

// The two codes that actually occur on this machine. Both are cleared by a
// server restart because the pin lives in a module-scope Map, so anything other
// than a restart fix here would send the user chasing the wrong thing.
test("an invalidated executable identity asks for a restart", () => {
  const result = classifyProbeFailure("claude", "Provider probe denied: executable_identity_invalidated", 40, 6000);
  assert.equal(result.blockedBy, "identity_invalidated");
  assert.equal(result.fix.kind, "restart");
  assert.match(result.reason, /Claude Code/);
});

test("a changed executable identity also asks for a restart, with its own wording", () => {
  const result = classifyProbeFailure("codex", "Provider probe denied: executable_identity_changed", 40, 6000);
  assert.equal(result.blockedBy, "identity_changed");
  assert.equal(result.fix.kind, "restart");
  assert.notEqual(
    result.reason,
    classifyProbeFailure("codex", "executable_identity_invalidated", 40, 6000).reason,
  );
});

test("a probe that ran out its budget is reported as a timeout, not a failure", () => {
  const result = classifyProbeFailure("claude", "", 5900, 6000);
  assert.equal(result.blockedBy, "probe_timeout");
  assert.equal(result.fix.kind, "wait");
});

test("any other refusal carries the provider's own first line and points at Setup Center", () => {
  const result = classifyProbeFailure("codex", "codex: command not found\nsecond line", 30, 6000);
  assert.equal(result.blockedBy, "probe_failed");
  assert.equal(result.fix.kind, "setup");
  assert.equal(result.fix.route, "/codex");
  assert.match(result.reason, /command not found/);
  assert.doesNotMatch(result.reason, /second line/);
});

test("an empty refusal still produces a usable sentence", () => {
  const result = classifyProbeFailure("claude", "   \n  ", 30, 6000);
  assert.equal(result.blockedBy, "probe_failed");
  assert.ok(result.reason.length > 0);
});

test("every classification carries a fix, so the UI never shows a dead end", () => {
  const samples = [
    ["claude", "executable_identity_invalidated", 40],
    ["claude", "executable_identity_changed", 40],
    ["claude", "", 5900],
    ["claude", "boom", 30],
  ];
  for (const [id, stderr, duration] of samples) {
    const result = classifyProbeFailure(id, stderr, duration, 6000);
    assert.ok(result.fix, `${stderr || "timeout"} has no fix`);
    assert.ok(result.fix.label.length > 0);
  }
});
