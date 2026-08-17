import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const sourceRoot = process.cwd();
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL?.startsWith("file:")
    ) {
      const url = new URL(specifier, context.parentURL);
      const candidate = decodeURIComponent(url.pathname).replace(
        /^\/(?=[A-Za-z]:\/)/u,
        "",
      );
      const target = existsSync(candidate) ? candidate : `${candidate}.ts`;
      if (existsSync(target)) {
        return { shortCircuit: true, url: pathToFileURL(target).href };
      }
    }
    if (specifier.startsWith("@/")) {
      const candidate = path.resolve(sourceRoot, "src", specifier.slice(2));
      const target = existsSync(candidate) ? candidate : `${candidate}.ts`;
      if (existsSync(target)) {
        return { shortCircuit: true, url: pathToFileURL(target).href };
      }
    }
    return nextResolve(specifier, context);
  },
});

const { CodexNdjsonStreamNormalizer, createCodexNdjsonStreamNormalizer } =
  await import("./codexStream.ts");

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const PROMPT = "PROMPT_SENTINEL_must_never_reach_events";
const SECRET = "sk-SUPER_SECRET_VALUE_1234567890";

function line(value) {
  return `${JSON.stringify(value)}\n`;
}

function threadStarted(threadId = SESSION_ID) {
  return { type: "thread.started", thread_id: threadId };
}

function item(eventType, itemType, text, extra = {}) {
  return {
    type: eventType,
    item: {
      id: "item-1",
      type: itemType,
      ...(text === undefined ? {} : { text }),
      ...extra,
    },
  };
}

function normalizer(overrides = {}) {
  return createCodexNdjsonStreamNormalizer({
    prompt: PROMPT,
    sensitiveValues: [SECRET],
    ...overrides,
  });
}

async function captureError(operation) {
  let caught;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, "operation must reject");
  return caught;
}

function assertFailure(error, failureClass) {
  assert.equal(error.name, "DurableExecutionError");
  assert.equal(error.failure?.failureClass, failureClass);
  assert.equal(error.message.includes(PROMPT), false);
  assert.equal(error.message.includes(SECRET), false);
}

test("incrementally decodes split UTF-8 chunks and partial NDJSON lines", () => {
  const stream = normalizer();
  const payload = [
    line(threadStarted()),
    line({ type: "turn.started" }),
    line(item("item.completed", "reasoning", "בודק בבטחה")),
    line(item("item.completed", "agent_message", "תשובה סופית")),
    line({
      type: "turn.completed",
      usage: { input_tokens: 4, output_tokens: 2 },
    }),
  ].join("");
  const bytes = new TextEncoder().encode(payload);
  const events = [];
  const splits = [1, 2, 7, 13, 29, 31, 67, 113, bytes.length];
  let offset = 0;
  for (const end of splits) {
    if (end <= offset) continue;
    events.push(...stream.pushStdout(bytes.slice(offset, end)));
    offset = end;
  }
  if (offset < bytes.length)
    events.push(...stream.pushStdout(bytes.slice(offset)));
  events.push(...stream.finish());

  assert.equal(stream.sessionId, SESSION_ID);
  assert.deepEqual(events, [
    { type: "session", sessionId: SESSION_ID },
    { type: "reasoning", text: "בודק בבטחה" },
    { type: "assistant", text: "תשובה סופית" },
  ]);
});

test("captures one session and suppresses started, user, prompt, and raw NDJSON", () => {
  const stream = normalizer();
  const rawLines = [
    line(threadStarted()),
    line(item("item.started", "agent_message", `partial ${PROMPT}`)),
    line(item("item.completed", "user_message", PROMPT)),
    line(item("item.completed", "agent_message", `safe final ${SECRET}`)),
  ];
  const events = rawLines.flatMap((chunk) => stream.pushStdout(chunk));
  events.push(...stream.finish());

  assert.deepEqual(events, [
    { type: "session", sessionId: SESSION_ID },
    { type: "assistant", text: "safe final [REDACTED_INPUT]" },
  ]);
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes(PROMPT), false);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes("thread.started"), false);
  assert.equal(serialized.includes("item.completed"), false);
  assert.equal(serialized.includes("partial"), false);
});

test("completed assistant and reasoning outputs remain separate and redact prompt echoes", () => {
  const stream = normalizer();
  const events = stream.pushStdout(
    [
      line(threadStarted()),
      line(item("item.completed", "reasoning", `reasoning about ${PROMPT}`)),
      line(item("item.completed", "agent_message", `answer ${PROMPT}`)),
    ].join(""),
  );

  assert.deepEqual(events, [
    { type: "session", sessionId: SESSION_ID },
    { type: "reasoning", text: "reasoning about [REDACTED_INPUT]" },
    { type: "assistant", text: "answer [REDACTED_INPUT]" },
  ]);
});

test("resume session mismatch and mid-stream identity changes fail closed", async (t) => {
  await t.test("resume mismatch", async () => {
    const stream = normalizer({ expectedSessionId: SESSION_ID });
    const error = await captureError(() =>
      stream.pushStdout(line(threadStarted(OTHER_SESSION_ID))),
    );
    assertFailure(error, "identity");
    assert.equal(stream.sessionId, null);
  });

  await t.test("mid-stream identity change", async () => {
    const stream = normalizer();
    stream.pushStdout(line(threadStarted()));
    const error = await captureError(() =>
      stream.pushStdout(line(threadStarted(OTHER_SESSION_ID))),
    );
    assertFailure(error, "identity");
    assert.equal(stream.sessionId, SESSION_ID);
  });

  await t.test("item before identity", async () => {
    const stream = normalizer();
    const error = await captureError(() =>
      stream.pushStdout(
        line(item("item.completed", "agent_message", "unsafe")),
      ),
    );
    assertFailure(error, "identity");
  });

  await t.test("successful finish requires identity", async () => {
    const stream = normalizer();
    stream.pushStdout(line({ type: "turn.started" }));
    const error = await captureError(() => stream.finish());
    assertFailure(error, "identity");
  });

  await t.test(
    "failed provider finish may preserve diagnostics without fake identity",
    () => {
      const stream = normalizer();
      const events = [
        ...stream.pushStderr("authentication failed\n"),
        ...stream.finish({ requireSession: false }),
      ];
      assert.equal(stream.sessionId, null);
      assert.deepEqual(events, [
        {
          type: "diagnostic",
          channel: "stderr",
          category: "authentication",
          severity: "error",
          message: "authentication failed",
        },
      ]);
    },
  );
});

test("every command, tool, MCP, web, browser, computer, image, and unknown item violates Wave 3 policy", async (t) => {
  const forbiddenTypes = [
    "command_execution",
    "shell_command",
    "mcp_tool_call",
    "tool_call",
    "function_call",
    "web_search",
    "browser_use",
    "computer_use",
    "image_generation",
    "apply_patch",
    "file_change",
    "future_unclassified_item",
  ];

  for (const itemType of forbiddenTypes) {
    await t.test(itemType, async () => {
      const stream = normalizer();
      stream.pushStdout(line(threadStarted()));
      const error = await captureError(() =>
        stream.pushStdout(
          line(item("item.started", itemType, undefined, { command: SECRET })),
        ),
      );
      assertFailure(error, "policy");
      assert.equal(error.message.includes(itemType), false);
    });
  }
});

test("tool-like top-level events and unknown version events fail closed", async (t) => {
  for (const eventType of [
    "tool.started",
    "command.completed",
    "web_search.completed",
    "future.unknown",
  ]) {
    await t.test(eventType, async () => {
      const stream = normalizer();
      stream.pushStdout(line(threadStarted()));
      const error = await captureError(() =>
        stream.pushStdout(line({ type: eventType, payload: SECRET })),
      );
      assertFailure(error, "policy");
    });
  }
});

test("stderr is incrementally classified, bounded, and stripped of prompts and secrets", () => {
  const stream = normalizer();
  const events = [];
  events.push(...stream.pushStderr("warning: deprecated config uses api_"));
  events.push(
    ...stream.pushStderr(
      `key=${SECRET}\nweekly quota for ${PROMPT} exceeded\n`,
    ),
  );
  events.push(...stream.finish({ requireSession: false }));

  assert.deepEqual(events, [
    {
      type: "diagnostic",
      channel: "stderr",
      category: "authentication",
      severity: "warning",
      message: "warning: deprecated config uses api_key=[REDACTED]",
    },
    {
      type: "diagnostic",
      channel: "stderr",
      category: "quota",
      severity: "error",
      message: "weekly quota for [REDACTED_INPUT] exceeded",
    },
  ]);
  assert.equal(JSON.stringify(events).includes(PROMPT), false);
  assert.equal(JSON.stringify(events).includes(SECRET), false);
});

test("structured stdout errors are diagnostics rather than raw JSON", () => {
  const stream = normalizer();
  const raw = line({
    type: "error",
    message: `Unauthorized api_key=${SECRET} prompt=${PROMPT}`,
  });
  const events = stream.pushStdout(raw);

  assert.deepEqual(events, [
    {
      type: "diagnostic",
      channel: "stdout",
      category: "authentication",
      severity: "error",
      message: "Unauthorized api_key=[REDACTED] prompt=[REDACTED_INPUT]",
    },
  ]);
  assert.equal(JSON.stringify(events).includes(raw.trim()), false);
});

test("Codex 0.144.6 completed error items are sanitized diagnostics, not tool violations", () => {
  const stream = normalizer();
  const raw = line({
    type: "item.completed",
    item: {
      id: "item_0",
      type: "error",
      message: `Exceeded skills context budget while processing ${PROMPT} ${SECRET}`,
    },
  });
  const events = stream.pushStdout(`${line(threadStarted())}${raw}`);

  assert.deepEqual(events, [
    { type: "session", sessionId: SESSION_ID },
    {
      type: "diagnostic",
      channel: "stdout",
      category: "runtime",
      severity: "error",
      message:
        "Exceeded skills context budget while processing [REDACTED_INPUT] [REDACTED_INPUT]",
    },
  ]);
  assert.equal(JSON.stringify(events).includes(raw.trim()), false);
  assert.equal(JSON.stringify(events).includes(PROMPT), false);
  assert.equal(JSON.stringify(events).includes(SECRET), false);
});

test("malformed JSON, invalid UTF-8, partial final JSON, and mixed chunk modes fail safely", async (t) => {
  await t.test("malformed JSON", async () => {
    const stream = normalizer();
    const error = await captureError(() => stream.pushStdout(`${PROMPT}\n`));
    assertFailure(error, "invalid_request");
  });

  await t.test("partial final JSON", async () => {
    const stream = normalizer();
    stream.pushStdout('{"type":"thread.started"');
    const error = await captureError(() => stream.finish());
    assertFailure(error, "invalid_request");
  });

  await t.test("invalid UTF-8", async () => {
    const stream = normalizer();
    const error = await captureError(() =>
      stream.pushStdout(Uint8Array.from([0xc3, 0x28])),
    );
    assertFailure(error, "invalid_request");
  });

  await t.test("mixed text and byte chunks", async () => {
    const stream = normalizer();
    stream.pushStdout(new TextEncoder().encode(line(threadStarted())));
    const error = await captureError(() => stream.pushStdout("\n"));
    assertFailure(error, "invalid_request");
  });

  await t.test("failure is terminal", async () => {
    const stream = normalizer();
    const first = await captureError(() => stream.pushStdout("not-json\n"));
    const second = await captureError(() =>
      stream.pushStdout(line(threadStarted())),
    );
    assert.equal(second, first);
  });
});

test("line, text, diagnostic, and event bounds are enforced", async (t) => {
  await t.test("stdout line bound", async () => {
    const stream = normalizer({ maxLineBytes: 32 });
    const error = await captureError(() =>
      stream.pushStdout(`${"x".repeat(33)}\n`),
    );
    assertFailure(error, "resource_exhausted");
  });

  await t.test("partial stdout line bound", async () => {
    const stream = normalizer({ maxLineBytes: 32 });
    const error = await captureError(() => stream.pushStdout("x".repeat(33)));
    assertFailure(error, "resource_exhausted");
  });

  await t.test("completed text bound", async () => {
    const stream = normalizer({ maxTextBytes: 16, maxLineBytes: 1024 });
    stream.pushStdout(line(threadStarted()));
    const error = await captureError(() =>
      stream.pushStdout(
        line(item("item.completed", "agent_message", "א".repeat(9))),
      ),
    );
    assertFailure(error, "resource_exhausted");
  });

  await t.test("stderr diagnostic bound", async () => {
    const stream = normalizer({ maxDiagnosticBytes: 16 });
    const error = await captureError(() =>
      stream.pushStderr(`${"x".repeat(17)}\n`),
    );
    assertFailure(error, "resource_exhausted");
  });

  await t.test("event count bound", async () => {
    const stream = normalizer({ maxEvents: 1 });
    stream.pushStdout(line(threadStarted()));
    const error = await captureError(() =>
      stream.pushStdout(
        line(item("item.completed", "agent_message", "second")),
      ),
    );
    assertFailure(error, "resource_exhausted");
  });
});

test("invalid options and data after finish are rejected", async (t) => {
  for (const options of [
    null,
    {},
    { prompt: "bad\0prompt" },
    { prompt: PROMPT, expectedSessionId: "not-a-uuid" },
    { prompt: PROMPT, sensitiveValues: ["ok", 123] },
    { prompt: PROMPT, maxLineBytes: 0 },
    { prompt: PROMPT, maxEvents: 5_000_000 },
  ]) {
    await t.test(JSON.stringify(options), () => {
      assert.throws(
        () => new CodexNdjsonStreamNormalizer(options),
        (error) =>
          error?.name === "DurableExecutionError" &&
          ["invalid_request", "identity"].includes(error.failure?.failureClass),
      );
    });
  }

  await t.test("push after finish", async () => {
    const stream = normalizer();
    stream.pushStdout(line(threadStarted()));
    stream.finish();
    const error = await captureError(() => stream.pushStdout("\n"));
    assertFailure(error, "invalid_request");
  });
});
