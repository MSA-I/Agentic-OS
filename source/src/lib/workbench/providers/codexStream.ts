import { redactText } from "../redaction";
import { DurableExecutionError, type RetryFailureClass } from "../retryPolicy";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEFAULT_MAX_LINE_BYTES = 256 * 1024;
const DEFAULT_MAX_TEXT_BYTES = 128 * 1024;
const DEFAULT_MAX_DIAGNOSTIC_BYTES = 16 * 1024;
const DEFAULT_MAX_EVENTS = 10_000;
const MAX_CONFIGURED_BOUND = 4 * 1024 * 1024;

const ALLOWED_LIFECYCLE_EVENTS = new Set([
  "thread.started",
  "turn.started",
  "turn.completed",
]);
const ALLOWED_ITEM_TYPES = new Set([
  "agent_message",
  "reasoning",
  "user_message",
  "error",
]);
const TOOL_LIKE_EVENT =
  /(?:tool|command|shell|web|browser|computer|image|function|mcp|apply[_-]?patch|file[_-]?change)/iu;

export type CodexDiagnosticCategory =
  "authentication" | "quota" | "rate_limit" | "configuration" | "runtime";

export type CodexNormalizedStreamEvent =
  | {
      type: "session";
      sessionId: string;
    }
  | {
      type: "assistant";
      text: string;
    }
  | {
      type: "reasoning";
      text: string;
    }
  | {
      type: "diagnostic";
      channel: "stdout" | "stderr";
      category: CodexDiagnosticCategory;
      severity: "warning" | "error";
      message: string;
    };

export interface CodexStreamNormalizerOptions {
  /** Resume target. A different thread.started identity is rejected. */
  expectedSessionId?: string | null;
  /** Exact prompt bytes are suppressed from every normalized output channel. */
  prompt: string;
  /** Additional server-owned values that must never reach the event ledger. */
  sensitiveValues?: readonly string[];
  maxLineBytes?: number;
  maxTextBytes?: number;
  maxDiagnosticBytes?: number;
  maxEvents?: number;
}

export interface CodexStreamFinishOptions {
  /** Successful provider completion must capture thread.started. */
  requireSession?: boolean;
}

interface ChannelState {
  buffer: string;
  decoder: TextDecoder;
  mode: "text" | "bytes" | null;
  finished: boolean;
}

function durableError(
  failureClass: RetryFailureClass,
  message: string,
): DurableExecutionError {
  return new DurableExecutionError({ failureClass, message });
}

function boundedOption(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved <= 0 ||
    resolved > MAX_CONFIGURED_BOUND
  ) {
    throw durableError(
      "invalid_request",
      `Codex stream ${name} must be a positive safe bound no larger than ${MAX_CONFIGURED_BOUND} bytes.`,
    );
  }
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function diagnosticCategory(message: string): CodexDiagnosticCategory {
  if (
    /(?:unauthori[sz]ed|authentication|authenticate|api[ _-]?key|login|sign in|credential)/iu.test(
      message,
    )
  ) {
    return "authentication";
  }
  if (
    /(?:quota|usage limit|weekly limit|credit balance|billing limit|insufficient credits)/iu.test(
      message,
    )
  ) {
    return "quota";
  }
  if (/(?:rate[ _-]?limit|too many requests|\b429\b)/iu.test(message)) {
    return "rate_limit";
  }
  if (
    /(?:config|configuration|unknown field|invalid value|strict-config|not recognized)/iu.test(
      message,
    )
  ) {
    return "configuration";
  }
  return "runtime";
}

function diagnosticSeverity(message: string): "warning" | "error" {
  return /(?:\bwarn(?:ing)?\b|deprecated)/iu.test(message)
    ? "warning"
    : "error";
}

/**
 * Incremental Codex 0.144.6 NDJSON normalizer for the restricted Wave 3 pilot.
 *
 * It never forwards raw provider JSON. Only completed assistant/reasoning
 * items, a verified session identity, and bounded redacted diagnostics are
 * returned. Any tool-like or unknown item is a policy violation until the
 * Tool Gateway is available in Wave 4.
 */
export class CodexNdjsonStreamNormalizer {
  private readonly stdout: ChannelState = {
    buffer: "",
    decoder: new TextDecoder("utf-8", { fatal: true }),
    mode: null,
    finished: false,
  };
  private readonly stderr: ChannelState = {
    buffer: "",
    decoder: new TextDecoder("utf-8", { fatal: true }),
    mode: null,
    finished: false,
  };
  private readonly expectedSessionId: string | null;
  private readonly sensitiveValues: readonly string[];
  private readonly maxLineBytes: number;
  private readonly maxTextBytes: number;
  private readonly maxDiagnosticBytes: number;
  private readonly maxEvents: number;
  private capturedSessionId: string | null = null;
  private emittedEvents = 0;
  private terminalFailure: DurableExecutionError | null = null;
  private finished = false;

  constructor(options: CodexStreamNormalizerOptions) {
    if (
      !options ||
      typeof options.prompt !== "string" ||
      options.prompt.includes("\0")
    ) {
      throw durableError(
        "invalid_request",
        "Codex stream normalization requires the admitted prompt for suppression.",
      );
    }
    const expected = options.expectedSessionId ?? null;
    if (expected !== null && !UUID_PATTERN.test(expected)) {
      throw durableError(
        "identity",
        "Codex stream expected session identity is invalid.",
      );
    }
    const extraSensitive = options.sensitiveValues ?? [];
    if (
      !Array.isArray(extraSensitive) ||
      extraSensitive.some(
        (value) => typeof value !== "string" || value.includes("\0"),
      )
    ) {
      throw durableError(
        "invalid_request",
        "Codex stream sensitive-value configuration is invalid.",
      );
    }

    this.expectedSessionId = expected;
    this.sensitiveValues = [...new Set([options.prompt, ...extraSensitive])]
      .filter((value) => value.length > 0)
      .sort((left, right) => right.length - left.length);
    this.maxLineBytes = boundedOption(
      options.maxLineBytes,
      DEFAULT_MAX_LINE_BYTES,
      "line limit",
    );
    this.maxTextBytes = boundedOption(
      options.maxTextBytes,
      DEFAULT_MAX_TEXT_BYTES,
      "text limit",
    );
    this.maxDiagnosticBytes = boundedOption(
      options.maxDiagnosticBytes,
      DEFAULT_MAX_DIAGNOSTIC_BYTES,
      "diagnostic limit",
    );
    this.maxEvents = boundedOption(
      options.maxEvents,
      DEFAULT_MAX_EVENTS,
      "event limit",
    );
  }

  get sessionId(): string | null {
    return this.capturedSessionId;
  }

  pushStdout(
    chunk: string | Uint8Array,
  ): readonly CodexNormalizedStreamEvent[] {
    return this.guard(() => this.pushChannel("stdout", chunk));
  }

  pushStderr(
    chunk: string | Uint8Array,
  ): readonly CodexNormalizedStreamEvent[] {
    return this.guard(() => this.pushChannel("stderr", chunk));
  }

  finish(
    options: CodexStreamFinishOptions = {},
  ): readonly CodexNormalizedStreamEvent[] {
    return this.guard(() => {
      const requireSession = options.requireSession ?? true;
      if (this.finished) {
        if (requireSession) this.assertSessionCaptured();
        return [];
      }
      const events = [
        ...this.finishChannel("stdout"),
        ...this.finishChannel("stderr"),
      ];
      this.finished = true;
      if (requireSession) this.assertSessionCaptured();
      return events;
    });
  }

  assertSessionCaptured(): string {
    if (!this.capturedSessionId) {
      this.raise(
        "identity",
        "Codex completed without a verified thread.started session identity.",
      );
    }
    return this.capturedSessionId;
  }

  private guard<T>(operation: () => T): T {
    if (this.terminalFailure) throw this.terminalFailure;
    try {
      return operation();
    } catch (error) {
      const failure =
        error instanceof DurableExecutionError
          ? error
          : durableError(
              "invalid_request",
              "Codex stream could not be decoded safely.",
            );
      this.terminalFailure = failure;
      throw failure;
    }
  }

  private raise(failureClass: RetryFailureClass, message: string): never {
    throw durableError(failureClass, message);
  }

  private pushChannel(
    channel: "stdout" | "stderr",
    chunk: string | Uint8Array,
  ): readonly CodexNormalizedStreamEvent[] {
    if (this.finished) {
      this.raise(
        "invalid_request",
        "Codex stream received data after completion.",
      );
    }
    const state = channel === "stdout" ? this.stdout : this.stderr;
    if (state.finished) {
      this.raise(
        "invalid_request",
        `Codex ${channel} received data after completion.`,
      );
    }
    const mode = typeof chunk === "string" ? "text" : "bytes";
    if (state.mode && state.mode !== mode) {
      this.raise(
        "invalid_request",
        `Codex ${channel} cannot mix text and byte chunks in one stream.`,
      );
    }
    state.mode = mode;
    let decoded: string;
    try {
      decoded =
        typeof chunk === "string"
          ? chunk
          : state.decoder.decode(chunk, { stream: true });
    } catch {
      this.raise("invalid_request", `Codex ${channel} is not valid UTF-8.`);
    }
    return this.consumeDecoded(channel, state, decoded);
  }

  private finishChannel(
    channel: "stdout" | "stderr",
  ): readonly CodexNormalizedStreamEvent[] {
    const state = channel === "stdout" ? this.stdout : this.stderr;
    if (state.finished) return [];
    let decoderTail = "";
    if (state.mode === "bytes") {
      try {
        decoderTail = state.decoder.decode();
      } catch {
        this.raise(
          "invalid_request",
          `Codex ${channel} ended with invalid UTF-8.`,
        );
      }
    }
    const events = [...this.consumeDecoded(channel, state, decoderTail)];
    if (state.buffer.length > 0) {
      const line = state.buffer.endsWith("\r")
        ? state.buffer.slice(0, -1)
        : state.buffer;
      state.buffer = "";
      if (line.trim()) events.push(...this.consumeLine(channel, line));
    }
    state.finished = true;
    return events;
  }

  private consumeDecoded(
    channel: "stdout" | "stderr",
    state: ChannelState,
    decoded: string,
  ): readonly CodexNormalizedStreamEvent[] {
    state.buffer += decoded;
    const events: CodexNormalizedStreamEvent[] = [];
    while (true) {
      const newline = state.buffer.indexOf("\n");
      if (newline < 0) break;
      let line = state.buffer.slice(0, newline);
      state.buffer = state.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.assertLineBound(channel, line);
      if (line.trim()) events.push(...this.consumeLine(channel, line));
    }
    this.assertLineBound(channel, state.buffer);
    return events;
  }

  private assertLineBound(channel: "stdout" | "stderr", line: string): void {
    const maximum =
      channel === "stdout" ? this.maxLineBytes : this.maxDiagnosticBytes;
    if (byteLength(line) > maximum) {
      this.raise(
        "resource_exhausted",
        `Codex ${channel} line exceeded its configured byte limit.`,
      );
    }
  }

  private consumeLine(
    channel: "stdout" | "stderr",
    line: string,
  ): readonly CodexNormalizedStreamEvent[] {
    if (channel === "stderr") {
      return [
        this.emit({
          type: "diagnostic",
          channel,
          category: diagnosticCategory(line),
          severity: diagnosticSeverity(line),
          message: this.sanitize(line, this.maxDiagnosticBytes),
        }),
      ];
    }
    return this.consumeStdoutLine(line);
  }

  private consumeStdoutLine(
    line: string,
  ): readonly CodexNormalizedStreamEvent[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.raise("invalid_request", "Codex stdout contained malformed NDJSON.");
    }
    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      this.raise("invalid_request", "Codex stdout event shape is invalid.");
    }

    const eventType = parsed.type;
    if (eventType === "thread.started") {
      return this.consumeThreadStarted(parsed);
    }
    if (eventType === "error" || eventType === "turn.failed") {
      const message =
        typeof parsed.message === "string"
          ? parsed.message
          : isRecord(parsed.error) && typeof parsed.error.message === "string"
            ? parsed.error.message
            : "Codex reported a provider error.";
      return [
        this.emit({
          type: "diagnostic",
          channel: "stdout",
          category: diagnosticCategory(message),
          severity: "error",
          message: this.sanitize(message, this.maxDiagnosticBytes),
        }),
      ];
    }
    if (eventType === "item.started" || eventType === "item.completed") {
      return this.consumeItem(eventType, parsed);
    }
    if (ALLOWED_LIFECYCLE_EVENTS.has(eventType)) return [];
    if (TOOL_LIKE_EVENT.test(eventType)) {
      this.raise("policy", "Codex emitted a forbidden Wave 3 tool event.");
    }
    this.raise(
      "policy",
      "Codex emitted an event not covered by the verified 0.144.6 stream policy.",
    );
  }

  private consumeThreadStarted(
    event: Record<string, unknown>,
  ): readonly CodexNormalizedStreamEvent[] {
    const threadId = event.thread_id;
    if (typeof threadId !== "string" || !UUID_PATTERN.test(threadId)) {
      this.raise(
        "identity",
        "Codex thread.started session identity is invalid.",
      );
    }
    if (this.expectedSessionId && threadId !== this.expectedSessionId) {
      this.raise(
        "identity",
        "Codex resumed a session different from the admitted target.",
      );
    }
    if (this.capturedSessionId && threadId !== this.capturedSessionId) {
      this.raise(
        "identity",
        "Codex stream changed session identity during execution.",
      );
    }
    if (this.capturedSessionId) return [];
    this.capturedSessionId = threadId;
    return [this.emit({ type: "session", sessionId: threadId })];
  }

  private consumeItem(
    eventType: "item.started" | "item.completed",
    event: Record<string, unknown>,
  ): readonly CodexNormalizedStreamEvent[] {
    if (!this.capturedSessionId) {
      this.raise(
        "identity",
        "Codex emitted an item before establishing its session identity.",
      );
    }
    if (!isRecord(event.item) || typeof event.item.type !== "string") {
      this.raise("policy", "Codex emitted an unclassified Wave 3 item.");
    }
    const itemType = event.item.type;
    if (!ALLOWED_ITEM_TYPES.has(itemType)) {
      this.raise(
        "policy",
        TOOL_LIKE_EVENT.test(itemType)
          ? "Codex emitted a forbidden Wave 3 tool item."
          : "Codex emitted an unclassified Wave 3 item.",
      );
    }

    // Started events and user echoes are intentionally suppressed. Only a
    // completed provider answer can become transcript output.
    if (eventType !== "item.completed" || itemType === "user_message")
      return [];
    if (itemType === "error") {
      const message =
        typeof event.item.message === "string"
          ? event.item.message
          : "Codex reported a provider item error.";
      return [
        this.emit({
          type: "diagnostic",
          channel: "stdout",
          category: diagnosticCategory(message),
          severity: "error",
          message: this.sanitize(message, this.maxDiagnosticBytes),
        }),
      ];
    }
    const text = event.item.text;
    if (typeof text !== "string") {
      this.raise(
        "invalid_request",
        "Codex completed text item shape is invalid.",
      );
    }
    if (!text.trim()) return [];
    if (byteLength(text) > this.maxTextBytes) {
      this.raise(
        "resource_exhausted",
        "Codex completed text item exceeded its configured byte limit.",
      );
    }
    const sanitized = this.sanitize(text, this.maxTextBytes);
    return itemType === "agent_message"
      ? [this.emit({ type: "assistant", text: sanitized })]
      : [this.emit({ type: "reasoning", text: sanitized })];
  }

  private sanitize(value: string, maximum: number): string {
    let output = value;
    for (const sensitive of this.sensitiveValues) {
      output = output.split(sensitive).join("[REDACTED_INPUT]");
    }
    return redactText(output, maximum);
  }

  private emit<T extends CodexNormalizedStreamEvent>(event: T): T {
    this.emittedEvents += 1;
    if (this.emittedEvents > this.maxEvents) {
      this.raise(
        "resource_exhausted",
        "Codex normalized event count exceeded its configured limit.",
      );
    }
    return event;
  }
}

export function createCodexNdjsonStreamNormalizer(
  options: CodexStreamNormalizerOptions,
): CodexNdjsonStreamNormalizer {
  return new CodexNdjsonStreamNormalizer(options);
}
