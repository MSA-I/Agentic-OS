import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

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

const { ClaudeStreamJsonParser } = await import("./claudeStream.ts");

const EXPECTED_SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION = "22222222-2222-4222-8222-222222222222";
const SECRET_SENTINEL = "STREAM_SECRET_SENTINEL_must_not_enter_protocol_errors";

function line(value) {
  return `${JSON.stringify(value)}\n`;
}

test("normalizes split Claude NDJSON without persisting raw protocol records", () => {
  const parser = new ClaudeStreamJsonParser({ expectedSessionId: EXPECTED_SESSION });
  const init = line({ type: "system", subtype: "init", session_id: EXPECTED_SESSION, tools: [] });
  const delta = line({
    type: "stream_event",
    session_id: EXPECTED_SESSION,
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "hello" },
    },
  });
  const result = line({
    type: "result",
    session_id: EXPECTED_SESSION,
    is_error: false,
    result: "hello",
    duration_ms: 40,
    duration_api_ms: 35,
    num_turns: 1,
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 3,
    },
  });
  const wire = `${init}${delta}${result}`;
  const first = parser.push(wire.slice(0, 37));
  const second = parser.push(wire.slice(37, 111));
  const third = parser.push(wire.slice(111));
  const events = [...first, ...second, ...third, ...parser.finish()];

  assert.deepEqual(events, [
    { type: "session", sessionId: EXPECTED_SESSION },
    { type: "assistant_delta", text: "hello" },
    {
      type: "result",
      isError: false,
      failureClass: null,
      sessionId: EXPECTED_SESSION,
      textFallback: null,
      metadata: {
        durationMs: 40,
        durationApiMs: 35,
        turns: 1,
        totalCostUsd: 0.01,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 3,
      },
    },
  ]);
  assert.equal(JSON.stringify(events).includes("stream_event"), false);
});

test("classifies Claude weekly-limit results as quota without treating them as protocol failures", () => {
  const parser = new ClaudeStreamJsonParser({ expectedSessionId: EXPECTED_SESSION });
  const events = parser.push(line({
    type: "result",
    session_id: EXPECTED_SESSION,
    is_error: true,
    result: "You've hit your weekly limit - wait for renewal",
  }));
  const result = events.find((event) => event.type === "result");
  assert.ok(result);
  assert.equal(result.failureClass, "quota");
  assert.equal(result.isError, true);
});

test("accepts a complete final JSON record without a trailing newline", () => {
  const parser = new ClaudeStreamJsonParser({ expectedSessionId: EXPECTED_SESSION });
  const events = parser.push(JSON.stringify({
    type: "result",
    session_id: EXPECTED_SESSION,
    result: "fallback answer",
    is_error: false,
  }));

  assert.deepEqual(events.map((event) => event.type), ["session", "result"]);
  assert.equal(events[1].textFallback, "fallback answer");
  assert.deepEqual(parser.finish(), []);
});

test("drops user-message and unknown records so prompts are not replayed into the ledger", () => {
  const parser = new ClaudeStreamJsonParser({ expectedSessionId: EXPECTED_SESSION });
  const events = parser.push([
    line({ type: "user", session_id: EXPECTED_SESSION, message: { content: SECRET_SENTINEL } }),
    line({ type: "unknown", payload: SECRET_SENTINEL }),
  ].join(""));

  assert.deepEqual(events, [{ type: "session", sessionId: EXPECTED_SESSION }]);
  assert.equal(JSON.stringify(events).includes(SECRET_SENTINEL), false);
});

test("extracts reasoning separately from assistant text", () => {
  const parser = new ClaudeStreamJsonParser();
  const events = parser.push(line({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "thinking_delta", thinking: "private reasoning summary" },
    },
  }));
  assert.deepEqual(events, [{ type: "reasoning_delta", text: "private reasoning summary" }]);
});

test("uses full assistant content only when partial deltas were not observed", () => {
  const parser = new ClaudeStreamJsonParser();
  const events = parser.push(line({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "first" },
        { type: "text", text: " second" },
      ],
    },
  }));
  assert.deepEqual(events, [{ type: "assistant_delta", text: "first second" }]);
});

test("pins one server-owned session identity and rejects mismatches without echoing identifiers", () => {
  const parser = new ClaudeStreamJsonParser({ expectedSessionId: EXPECTED_SESSION });
  assert.deepEqual(parser.push(line({ type: "system", session_id: EXPECTED_SESSION })), [
    { type: "session", sessionId: EXPECTED_SESSION },
  ]);
  assert.deepEqual(parser.push(line({ type: "system", session_id: EXPECTED_SESSION })), []);
  const mismatch = parser.push(line({ type: "result", session_id: OTHER_SESSION }));
  assert.equal(mismatch.length, 1);
  assert.deepEqual(mismatch[0], {
    type: "fatal",
    code: "session_identity_mismatch",
    failureClass: "identity",
    message: "Claude stream native session identity did not match the server-owned target.",
  });
  assert.equal(JSON.stringify(mismatch).includes(OTHER_SESSION), false);
  assert.deepEqual(parser.push(line({ type: "result", session_id: EXPECTED_SESSION })), []);
});

test("rejects invalid native session identifiers", () => {
  const parser = new ClaudeStreamJsonParser();
  const events = parser.push(line({ type: "system", session_id: "not-a-uuid" }));
  assert.equal(events[0].type, "fatal");
  assert.equal(events[0].code, "invalid_session_identity");
  assert.equal(events[0].failureClass, "identity");
  assert.equal(JSON.stringify(events).includes("not-a-uuid"), false);
});

test("fails closed when Claude reports tools, MCP servers, hooks, or subagents", async (t) => {
  const cases = [
    ["tool content block", {
      type: "stream_event",
      event: { type: "content_block_start", content_block: { type: "tool_use", name: "Read" } },
    }],
    ["tool input delta", {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } },
    }],
    ["non-empty init tools", { type: "system", subtype: "init", tools: ["Read"] }],
    ["non-empty MCP list", { type: "system", subtype: "init", mcp_servers: [{ name: "server" }] }],
    ["hook event", { type: "system", subtype: "hook_started" }],
    ["subagent task", { type: "system", subtype: "task_started", task_id: "task-1" }],
  ];

  for (const [name, record] of cases) {
    await t.test(name, () => {
      const parser = new ClaudeStreamJsonParser();
      const events = parser.push(line(record));
      assert.equal(events.length, 1);
      assert.equal(events[0].type, "fatal");
      assert.equal(events[0].code, "tool_event_observed");
      assert.equal(events[0].failureClass, "policy");
    });
  }
});

test("malformed JSON errors never include rejected provider output", () => {
  const parser = new ClaudeStreamJsonParser();
  const events = parser.push(`{"type":"result","secret":"${SECRET_SENTINEL}"\n`);
  assert.equal(events[0].type, "fatal");
  assert.equal(events[0].code, "invalid_json");
  assert.equal(JSON.stringify(events).includes(SECRET_SENTINEL), false);
});

test("line and buffer byte limits fail closed", async (t) => {
  await t.test("delimited line", () => {
    const parser = new ClaudeStreamJsonParser({ maxLineBytes: 32 });
    const events = parser.push(line({ type: "result", result: "x".repeat(64) }));
    assert.equal(events[0].type, "fatal");
    assert.equal(events[0].code, "line_too_large");
    assert.equal(events[0].failureClass, "resource_exhausted");
  });

  await t.test("undelimited buffer", () => {
    const parser = new ClaudeStreamJsonParser({ maxLineBytes: 32 });
    const events = parser.push(`{"type":"result","result":"${"x".repeat(64)}`);
    assert.equal(events[0].type, "fatal");
    assert.equal(events[0].code, "line_too_large");
  });
});

test("finish reports truncated JSON without retaining raw text", () => {
  const parser = new ClaudeStreamJsonParser();
  assert.deepEqual(parser.push(`{"type":"result","secret":"${SECRET_SENTINEL}`), []);
  const events = parser.finish();
  assert.equal(events[0].type, "fatal");
  assert.equal(events[0].code, "truncated_json");
  assert.equal(JSON.stringify(events).includes(SECRET_SENTINEL), false);
});

test("constructor validates server-owned parser limits and session identity", () => {
  assert.throws(
    () => new ClaudeStreamJsonParser({ expectedSessionId: "not-a-uuid" }),
    /valid expected session UUID/u,
  );
  assert.throws(
    () => new ClaudeStreamJsonParser({ maxLineBytes: 0 }),
    /positive safe integer/u,
  );
});
