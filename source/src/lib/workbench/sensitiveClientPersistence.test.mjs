import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const clientFiles = [
  "src/components/CodexView.tsx",
  "src/components/CodexDesktop.tsx",
  "src/components/ClaudePanel.tsx",
  "src/components/desktop/ClaudeDesktop.tsx",
  "src/components/UnifiedChat.tsx",
  "src/components/desktop/useClaudeDesktopData.ts",
  "src/components/UltracodeView.tsx",
];
const read = (file) => readFileSync(path.join(root, file), "utf8");

test("prompt, transcript, and draft content has no durable browser or vault sink", () => {
  const joined = clientFiles.map((file) => `${file}\n${read(file)}`).join("\n");
  for (const forbidden of [
    "/api/memory/log",
    "/api/codex/chats",
    "agent-conversation-renamed",
    "agentic-os-chat-v3:",
    "agentic-os-chat-draft-v1:",
    "agentic-os:codex:draft:v3:",
    "agent-os:workbench:draft:v1:",
    "agentic-os:ultracode:draft:v1",
  ]) {
    assert.doesNotMatch(joined, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"), forbidden);
  }
  assert.doesNotMatch(joined, /localStorage\.(?:setItem|getItem)\([^\n]*(?:prompt|draft|msgs|messages|turns|reply|transcript)/iu);
  assert.doesNotMatch(joined, /sessionStorage\./u);
  assert.match(joined, /writeVolatile(?:Text|Value)/u);
  assert.match(read("src/lib/workbench/volatileClientState.ts"), /LEGACY_SENSITIVE_PREFIXES/u);
});

test("legacy Codex and Ultracode routes expose read-only handlers only", () => {
  for (const file of [
    "src/app/api/codex/chats/route.ts",
    "src/app/api/codex/goals/route.ts",
    "src/app/api/codex/workspace/route.ts",
    "src/app/api/claude/workspace/route.ts",
    "src/app/api/claude/ultracode/route.ts",
  ]) {
    const source = read(file);
    assert.match(source, /export async function GET/u, file);
    assert.doesNotMatch(source, /export async function (?:POST|PATCH|DELETE)/u, file);
  }

  const surfaces = read("src/components/CodexView.tsx") + read("src/components/UltracodeView.tsx");
  assert.doesNotMatch(surfaces, /fetch\([^\n]*(?:codex\/goals|codex\/workspace|claude\/ultracode)[\s\S]{0,180}method:\s*["'](?:POST|PATCH|DELETE)/u);
  assert.match(surfaces, /ACTIVE_PROCESS_ZERO/u);
});
