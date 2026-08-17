const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const MAX_DELTA_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;

export interface ClaudeStreamSessionEvent {
  type: "session";
  sessionId: string;
}

export interface ClaudeStreamAssistantDeltaEvent {
  type: "assistant_delta";
  text: string;
}

export interface ClaudeStreamReasoningDeltaEvent {
  type: "reasoning_delta";
  text: string;
}

export interface ClaudeStreamResultEvent {
  type: "result";
  isError: boolean;
  failureClass: "auth" | "quota" | "rate_limit" | "permanent" | null;
  sessionId: string | null;
  textFallback: string | null;
  metadata: {
    durationMs: number | null;
    durationApiMs: number | null;
    turns: number | null;
    totalCostUsd: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadInputTokens: number | null;
    cacheCreationInputTokens: number | null;
  };
}

function resultFailureClass(record: Record<string, unknown>): ClaudeStreamResultEvent["failureClass"] {
  if (record.is_error !== true) return null;
  const message = typeof record.result === "string" ? record.result : "";
  if (/(?:unauthori[sz]ed|authentication|authenticate|api[ _-]?key|login|sign in|credential)/iu.test(message)) {
    return "auth";
  }
  if (/(?:quota|usage limit|weekly limit|credit balance|billing limit|insufficient credits)/iu.test(message)) {
    return "quota";
  }
  if (/(?:rate[ _-]?limit|too many requests|\b429\b)/iu.test(message)) return "rate_limit";
  return "permanent";
}

export interface ClaudeStreamFatalEvent {
  type: "fatal";
  code:
    | "invalid_json"
    | "invalid_session_identity"
    | "line_too_large"
    | "session_identity_mismatch"
    | "tool_event_observed"
    | "truncated_json";
  failureClass: "identity" | "policy" | "resource_exhausted" | "invalid_request";
  message: string;
}

export type ClaudeNormalizedStreamEvent =
  | ClaudeStreamSessionEvent
  | ClaudeStreamAssistantDeltaEvent
  | ClaudeStreamReasoningDeltaEvent
  | ClaudeStreamResultEvent
  | ClaudeStreamFatalEvent;

export interface ClaudeStreamJsonParserOptions {
  /** Server-owned session identity chosen for start or resume. */
  expectedSessionId?: string;
  maxLineBytes?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boundedUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let output = value.slice(0, low);
  if (output && /[\uD800-\uDBFF]$/u.test(output)) output = output.slice(0, -1);
  return output;
}

function textBlocks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || entry.type !== "text" || typeof entry.text !== "string") return [];
    return [entry.text];
  });
}

function containsToolSignal(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => containsToolSignal(entry, depth + 1));
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  const subtype = typeof record.subtype === "string" ? record.subtype.toLowerCase() : "";
  if (["input_json_delta", "tool", "tool_result", "tool_use", "server_tool_use"].includes(type)) return true;
  if (type === "system" && (subtype.startsWith("task_") || subtype.includes("hook"))) return true;
  if (typeof record.tool_use_id === "string" && record.tool_use_id) return true;
  if (typeof record.parent_tool_use_id === "string" && record.parent_tool_use_id) return true;
  if (Array.isArray(record.tools) && record.tools.length > 0) return true;
  if (Array.isArray(record.mcp_servers) && record.mcp_servers.length > 0) return true;
  return Object.values(record).some((entry) => containsToolSignal(entry, depth + 1));
}

function resultMetadata(record: Record<string, unknown>): ClaudeStreamResultEvent["metadata"] {
  const usage = isRecord(record.usage) ? record.usage : {};
  return {
    durationMs: finiteNumber(record.duration_ms),
    durationApiMs: finiteNumber(record.duration_api_ms),
    turns: finiteNumber(record.num_turns),
    totalCostUsd: finiteNumber(record.total_cost_usd),
    inputTokens: finiteNumber(usage.input_tokens),
    outputTokens: finiteNumber(usage.output_tokens),
    cacheReadInputTokens: finiteNumber(usage.cache_read_input_tokens),
    cacheCreationInputTokens: finiteNumber(usage.cache_creation_input_tokens),
  };
}

/**
 * Incremental parser for Claude Code `--output-format=stream-json` NDJSON.
 *
 * User-message events and unknown provider records are intentionally dropped.
 * Fatal events contain only stable server text, never the rejected raw line.
 */
export class ClaudeStreamJsonParser {
  private readonly expectedSessionId: string | null;
  private readonly maxLineBytes: number;
  private buffer = "";
  private observedSessionId: string | null = null;
  private assistantTextObserved = false;
  private failed = false;

  constructor(options: ClaudeStreamJsonParserOptions = {}) {
    const expected = options.expectedSessionId ?? null;
    if (expected !== null && !UUID_PATTERN.test(expected)) {
      throw new TypeError("Claude stream parser requires a valid expected session UUID.");
    }
    const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
      throw new TypeError("Claude stream parser maxLineBytes must be a positive safe integer.");
    }
    this.expectedSessionId = expected;
    this.maxLineBytes = maxLineBytes;
  }

  push(text: string): readonly ClaudeNormalizedStreamEvent[] {
    if (this.failed || !text) return [];
    this.buffer += text;
    const events: ClaudeNormalizedStreamEvent[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0 && !this.failed) {
      const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newline + 1);
      events.push(...this.parseLine(line));
      newline = this.buffer.indexOf("\n");
    }
    if (this.failed) {
      this.buffer = "";
      return events;
    }
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxLineBytes) {
      events.push(this.fatal(
        "line_too_large",
        "resource_exhausted",
        "Claude stream record exceeded its configured byte limit.",
      ));
      this.buffer = "";
      return events;
    }

    // Claude normally emits NDJSON with a trailing newline. Accept a complete
    // final record even when the transport delivers it without that delimiter.
    if (this.buffer.trim()) {
      try {
        const candidate = JSON.parse(this.buffer) as unknown;
        if (isRecord(candidate)) {
          this.buffer = "";
          events.push(...this.normalize(candidate));
        }
      } catch {
        // The record may be split across later stdout chunks.
      }
    }
    return events;
  }

  finish(): readonly ClaudeNormalizedStreamEvent[] {
    if (this.failed || !this.buffer.trim()) {
      this.buffer = "";
      return [];
    }
    const line = this.buffer;
    this.buffer = "";
    try {
      const candidate = JSON.parse(line) as unknown;
      if (!isRecord(candidate)) {
        return [this.fatal(
          "invalid_json",
          "invalid_request",
          "Claude stream emitted a non-object JSON record.",
        )];
      }
      return this.normalize(candidate);
    } catch {
      return [this.fatal(
        "truncated_json",
        "invalid_request",
        "Claude stream ended with an incomplete JSON record.",
      )];
    }
  }

  private parseLine(line: string): ClaudeNormalizedStreamEvent[] {
    if (!line.trim()) return [];
    if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) {
      return [this.fatal(
        "line_too_large",
        "resource_exhausted",
        "Claude stream record exceeded its configured byte limit.",
      )];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [this.fatal(
        "invalid_json",
        "invalid_request",
        "Claude stream emitted malformed JSON.",
      )];
    }
    if (!isRecord(parsed)) {
      return [this.fatal(
        "invalid_json",
        "invalid_request",
        "Claude stream emitted a non-object JSON record.",
      )];
    }
    return this.normalize(parsed);
  }

  private normalize(record: Record<string, unknown>): ClaudeNormalizedStreamEvent[] {
    const events: ClaudeNormalizedStreamEvent[] = [];
    const session = this.sessionEvent(record);
    if (session) events.push(session);
    if (this.failed) return events;

    if (containsToolSignal(record)) {
      events.push(this.fatal(
        "tool_event_observed",
        "policy",
        "Claude emitted a tool, MCP, hook, or subagent event while native tools were disabled.",
      ));
      return events;
    }

    const type = typeof record.type === "string" ? record.type : "";
    if (type === "stream_event") {
      const streamEvent = isRecord(record.event) ? record.event : null;
      if (streamEvent?.type === "content_block_delta") {
        const delta = isRecord(streamEvent.delta) ? streamEvent.delta : null;
        if (typeof delta?.text === "string" && delta.text) {
          const text = boundedUtf8(delta.text, MAX_DELTA_BYTES);
          if (text) {
            this.assistantTextObserved = true;
            events.push({ type: "assistant_delta", text });
          }
        } else if (typeof delta?.thinking === "string" && delta.thinking) {
          const text = boundedUtf8(delta.thinking, MAX_DELTA_BYTES);
          if (text) events.push({ type: "reasoning_delta", text });
        }
      }
      return events;
    }

    if (type === "assistant" && !this.assistantTextObserved) {
      const message = isRecord(record.message) ? record.message : null;
      const text = boundedUtf8(textBlocks(message?.content).join(""), MAX_RESULT_BYTES);
      if (text) {
        this.assistantTextObserved = true;
        events.push({ type: "assistant_delta", text });
      }
      return events;
    }

    if (type === "result") {
      const fallback = !this.assistantTextObserved && typeof record.result === "string"
        ? boundedUtf8(record.result, MAX_RESULT_BYTES)
        : null;
      if (fallback) this.assistantTextObserved = true;
      events.push({
        type: "result",
        isError: record.is_error === true,
        failureClass: resultFailureClass(record),
        sessionId: this.observedSessionId,
        textFallback: fallback || null,
        metadata: resultMetadata(record),
      });
    }
    return events;
  }

  private sessionEvent(record: Record<string, unknown>): ClaudeStreamSessionEvent | ClaudeStreamFatalEvent | null {
    if (!("session_id" in record)) return null;
    if (typeof record.session_id !== "string" || !UUID_PATTERN.test(record.session_id)) {
      return this.fatal(
        "invalid_session_identity",
        "identity",
        "Claude stream emitted an invalid native session identity.",
      );
    }
    if (
      (this.expectedSessionId !== null && record.session_id !== this.expectedSessionId)
      || (this.observedSessionId !== null && record.session_id !== this.observedSessionId)
    ) {
      return this.fatal(
        "session_identity_mismatch",
        "identity",
        "Claude stream native session identity did not match the server-owned target.",
      );
    }
    if (this.observedSessionId === record.session_id) return null;
    this.observedSessionId = record.session_id;
    return { type: "session", sessionId: record.session_id };
  }

  private fatal(
    code: ClaudeStreamFatalEvent["code"],
    failureClass: ClaudeStreamFatalEvent["failureClass"],
    message: string,
  ): ClaudeStreamFatalEvent {
    this.failed = true;
    return { type: "fatal", code, failureClass, message };
  }
}
