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

const { buildConversationHref } = await import("./conversationLink.ts");

test("claude links carry the project and the native session id", () => {
  const href = buildConversationHref("claude", "50742ae3-1111-2222-3333-444455556666", "setup-center");
  assert.equal(href, "/claude?project=setup-center&session=50742ae3-1111-2222-3333-444455556666");
});

test("codex links carry the agent and environment its desktop reads", () => {
  const href = buildConversationHref("codex", "abc123", "setup-center");
  const url = new URL(href, "http://localhost");
  assert.equal(url.pathname, "/codex");
  assert.equal(url.searchParams.get("agent"), "codex");
  assert.equal(url.searchParams.get("environment"), "local");
  assert.equal(url.searchParams.get("project"), "setup-center");
  assert.equal(url.searchParams.get("session"), "abc123");
});

test("hermes links carry the profile its desktop needs to resolve the session", () => {
  const href = buildConversationHref("hermes", "sess-9", "group-1", "julian");
  const url = new URL(href, "http://localhost");
  assert.equal(url.searchParams.get("profile"), "julian");
});

test("without a session id the link is the agent page itself, not a broken query", () => {
  for (const agent of ["claude", "codex", "hermes"]) {
    assert.equal(buildConversationHref(agent, null, "setup-center"), `/${agent}`);
  }
});

test("a session id with query-unsafe characters is encoded, not injected", () => {
  const href = buildConversationHref("claude", "a b&c=d", "setup-center");
  const url = new URL(href, "http://localhost");
  assert.equal(url.searchParams.get("session"), "a b&c=d");
  assert.equal(url.searchParams.get("c"), null);
});
