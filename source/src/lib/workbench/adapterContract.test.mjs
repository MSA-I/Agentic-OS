import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const sourceRoot = process.cwd();
registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
      const url = new URL(specifier, context.parentURL);
      const candidate = decodeURIComponent(url.pathname).replace(/^\/(?=[A-Za-z]:\/)/u, "");
      const target = existsSync(candidate) ? candidate : `${candidate}.ts`;
      if (existsSync(target)) return { shortCircuit: true, url: pathToFileURL(target).href };
    }
    if (specifier.startsWith("@/")) {
      const candidate = path.resolve(sourceRoot, "src", specifier.slice(2));
      const target = existsSync(candidate) ? candidate : `${candidate}.ts`;
      if (existsSync(target)) return { shortCircuit: true, url: pathToFileURL(target).href };
    }
    return nextResolve(specifier, context);
  },
});

const {
  AdapterConformanceError,
  assertAdapterConformance,
  WORKBENCH_ADAPTER_API_VERSION,
  WORKBENCH_CAPABILITY_SCHEMA_VERSION,
} = await import("./adapterContract.ts");

function adapter(provider = "codex") {
  const unsupported = { status: "unsupported", reason: "Not exposed in this Wave." };
  return {
    descriptor: {
      id: provider,
      provider,
      label: provider,
      runtime: `${provider}-runtime`,
      capabilities: {
        list: { status: "supported" }, load: { status: "supported" },
        start: unsupported, resume: unsupported, queue: { status: "supported" },
        cancel: { status: "supported" }, approval: unsupported, artifacts: { status: "supported" },
      },
    },
    async list() {}, async load() {}, async start() {}, async resume() {},
    async queue() {}, async cancel() {}, async approve() {}, async artifacts() {},
  };
}

const identity = {
  apiVersion: WORKBENCH_ADAPTER_API_VERSION,
  capabilitySchemaVersion: WORKBENCH_CAPABILITY_SCHEMA_VERSION,
  provider: "codex",
};

test("versioned adapter contract accepts a complete provider adapter", () => {
  assert.doesNotThrow(() => assertAdapterConformance(adapter(), identity));
});

test("adapter version, provider, method, and capability failures are fail-closed", () => {
  assert.throws(
    () => assertAdapterConformance(adapter(), { ...identity, apiVersion: "1.0.0" }),
    AdapterConformanceError,
  );
  assert.throws(
    () => assertAdapterConformance(adapter("claude"), identity),
    /provider does not match/,
  );
  const missing = adapter();
  delete missing.cancel;
  assert.throws(() => assertAdapterConformance(missing, identity), /missing method: cancel/);
  const ambiguous = adapter();
  ambiguous.descriptor.capabilities.start = { status: "unsupported", reason: "" };
  assert.throws(() => assertAdapterConformance(ambiguous, identity), /unsupported reason/);
});

test("adapter capability map requires every known capability and rejects unknown entries", () => {
  const empty = adapter();
  empty.descriptor.capabilities = {};
  assert.throws(
    () => assertAdapterConformance(empty, identity),
    /missing capability: list/,
  );

  const missing = adapter();
  delete missing.descriptor.capabilities.approval;
  assert.throws(
    () => assertAdapterConformance(missing, identity),
    /missing capability: approval/,
  );

  const extra = adapter();
  extra.descriptor.capabilities.execute = { status: "supported" };
  assert.throws(
    () => assertAdapterConformance(extra, identity),
    /unknown capability: execute/,
  );
});
