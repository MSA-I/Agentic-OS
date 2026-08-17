import assert from "node:assert/strict";
import test from "node:test";

import {
  createRedactingTextStream,
  redactLogMessage,
  redactRecord,
  redactText,
  serializeRedactedJson,
  StreamingRedactor,
} from "./redaction.ts";

test("Workbench log messages redact assigned secrets before console output", () => {
  const sentinel = "SENTINEL_BOOTSTRAP_SECRET_MUST_NOT_LEAK_123456";
  const logged = redactLogMessage(
    new Error(`bootstrap failed: secret=${sentinel}`),
  );
  assert.equal(logged.includes(sentinel), false);
  assert.match(logged, /secret=\[REDACTED\]/u);
});

test("Workbench text redaction covers credentials, query tokens, cookies, argv and generic entropy", () => {
  const sentinels = [
    "SENTINEL_URL_PASSWORD_Aa9zQ2wE7rT4yU8i",
    "SENTINEL_QUERY_TOKEN_Zx8cV7bN6mK5jH4g",
    "SENTINEL_COOKIE_Qq2Ww3Ee4Rr5Tt6Yy",
    "SENTINEL_ARG_9pL3mN7qR2vX6zK8",
    "N7vQ2zL9pR4xK8mT6wY3cH5j",
  ];
  const input = [
    `remote=https://user:${sentinels[0]}@example.test/repo`,
    `https://example.test/callback?token=${sentinels[1]}&mode=safe`,
    `Cookie: session=${sentinels[2]}; theme=dark`,
    `command --client-secret ${sentinels[3]} --mode safe`,
    `OPAQUE_BUILD_BLOB=${sentinels[4]}`,
  ].join("\n");
  const redacted = redactText(input);
  for (const sentinel of sentinels) assert.equal(redacted.includes(sentinel), false);
  assert.match(redacted, /mode=safe/u);
  assert.match(redacted, /Cookie: \[REDACTED\]/u);
});

test("Workbench structured and export boundaries redact nested env, args, URI and sensitive paths", () => {
  const sentinel = "H8sK2pQ9vN4xT7mR5zW3cL6j";
  const value = {
    env: { UNRECOGNIZED_BLOB: sentinel, LANG: "he_IL.UTF-8" },
    argv: ["--opaque", sentinel, "--mode", "safe"],
    metadata: {
      url: `https://example.test/path?api_key=${sentinel}`,
      sourcePath: "C:\\workspace\\vault-data\\credentials.json",
    },
  };
  const redacted = redactRecord(value);
  const exported = serializeRedactedJson(value, 2);
  assert.equal(JSON.stringify(redacted).includes(sentinel), false);
  assert.equal(exported.includes(sentinel), false);
  assert.equal(exported.includes("vault-data"), false);
  assert.match(exported, /he_IL\.UTF-8/u);
  assert.match(exported, /safe/u);
});

test("Streaming redaction holds chunked, multiline assignments and private-key blocks", () => {
  const sentinel = "SENTINEL_STREAM_8kQ2mN7vR4xP9zL6";
  const privateBody = "QWxhZGRpbjpvcGVuIHNlc2FtZQ==";
  const stream = new StreamingRedactor();
  const output = [
    stream.push("safe-before\nsecret=\nSENTINEL_STREAM_8kQ2"),
    stream.push("mN7vR4xP9zL6\nsafe-middle\n-----BEGIN PRIVATE KEY-----\n"),
    stream.push(`${privateBody}\n-----END PRIVATE KEY-----\nsafe-after`),
    stream.flush(),
  ].join("");
  assert.equal(output.includes(sentinel), false);
  assert.equal(output.includes(privateBody), false);
  assert.match(output, /safe-before/u);
  assert.match(output, /safe-after/u);
});

test("Redaction preserves ordinary hashes, identifiers, URLs and prose", () => {
  const value = {
    runId: "run_9AR4mzvXQ8kT2nW7pL5cH3jF",
    checksum: "0123456789abcdef0123456789abcdef01234567",
    url: "https://example.test/docs?mode=safe",
    message: "The token count is 42 and no credential is included.",
  };
  const redacted = serializeRedactedJson(value);
  assert.match(redacted, /run_9AR4mzvXQ8kT2nW7pL5cH3jF/u);
  assert.match(redacted, /0123456789abcdef0123456789abcdef01234567/u);
  assert.match(redacted, /mode=safe/u);
  assert.match(redacted, /token count is 42/u);
});

test("Byte-stream response boundary redacts secrets split across UTF-8 chunks", async () => {
  const sentinel = "BYTE_STREAM_SENTINEL_8kQ2mN7vR4xP9zL6";
  const encoder = new TextEncoder();
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("event: tool\ndata: {\"credential\":\"BYTE_STREAM_SENTINEL_8kQ2"));
      controller.enqueue(encoder.encode("mN7vR4xP9zL6\"}\n\n"));
      controller.close();
    },
  });
  const response = new Response(source.pipeThrough(createRedactingTextStream()));
  const output = await response.text();
  assert.equal(output.includes(sentinel), false);
  assert.match(output, /event: tool/u);
});
