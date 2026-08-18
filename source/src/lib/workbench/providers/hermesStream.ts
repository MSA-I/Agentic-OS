/**
 * Normalizes what `hermes chat -Q` actually emits.
 *
 * Unlike Claude and Codex there is no structured stream to parse: quiet mode
 * prints the assistant's final answer to stdout as plain text, and announces
 * the session on stderr as a single `session_id: <id>` line. So this parser is
 * small on purpose — it accumulates stdout, strips terminal control sequences,
 * and watches stderr for the one line that carries identity.
 */

export const HERMES_SESSION_ID_PATTERN = /^[0-9]{8}_[0-9]{6}_[0-9a-f]{6}$/u;

const SESSION_LINE = /(?:^|\n)\s*session_id:\s*(\S+)/iu;

const ESCAPE = String.fromCharCode(0x1b);
const BELL = String.fromCharCode(0x07);
const CSI_FINAL = /[A-Za-z]/u;

/**
 * Removes CSI (`ESC [ … letter`) and OSC (`ESC ] … BEL`) sequences.
 *
 * Written as a scan rather than a regular expression because the pattern would
 * need a literal escape byte in the source, and every layer that has touched
 * this file has eaten that byte at least once. Hermes suppresses its spinner
 * under `-Q` but still colours some lines, and a raw escape stored in a
 * transcript is noise the reader has to decode.
 */
export function stripTerminalControls(value: string): string {
  if (!value.includes(ESCAPE)) return value;
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== ESCAPE) {
      out += value[index];
      continue;
    }
    const next = value[index + 1];
    if (next === "[") {
      let cursor = index + 2;
      while (cursor < value.length && !CSI_FINAL.test(value[cursor])) cursor += 1;
      index = cursor;
      continue;
    }
    if (next === "]") {
      let cursor = index + 2;
      while (cursor < value.length && value[cursor] !== BELL && value[cursor] !== ESCAPE) cursor += 1;
      // Consume a BEL terminator too; a following ESC starts its own sequence
      // and is handled by the next iteration.
      index = value[cursor] === BELL ? cursor : cursor - 1;
      continue;
    }
    // A lone escape carries no meaning here, so it is dropped.
  }
  return out;
}

export type HermesNormalizedStreamEvent =
  | { type: "session"; sessionId: string }
  | { type: "assistant"; text: string }
  | { type: "diagnostic"; channel: "stdout" | "stderr"; severity: "info" | "error"; message: string };

export interface HermesStreamNormalizerOptions {
  /** On resume the session is already known; a different one means a hijacked run. */
  expectedSessionId?: string | null;
}

export class HermesStreamNormalizer {
  readonly #expectedSessionId: string | null;
  #stdout = "";
  #stderr = "";
  #sessionEmitted = false;
  #finished = false;

  constructor(options: HermesStreamNormalizerOptions = {}) {
    this.#expectedSessionId = options.expectedSessionId?.trim() || null;
  }

  pushStdout(chunk: string): readonly HermesNormalizedStreamEvent[] {
    this.#stdout += chunk;
    // The answer is only complete at exit, so nothing is emitted per chunk.
    return [];
  }

  pushStderr(chunk: string): readonly HermesNormalizedStreamEvent[] {
    this.#stderr += chunk;
    return this.#drainSession();
  }

  #drainSession(): readonly HermesNormalizedStreamEvent[] {
    if (this.#sessionEmitted) return [];
    const match = SESSION_LINE.exec(stripTerminalControls(this.#stderr));
    if (!match) return [];
    const sessionId = match[1];
    this.#sessionEmitted = true;
    if (!HERMES_SESSION_ID_PATTERN.test(sessionId)) {
      return [{
        type: "diagnostic",
        channel: "stderr",
        severity: "error",
        message: `Hermes announced an unrecognised session identifier: ${sessionId}`,
      }];
    }
    if (this.#expectedSessionId && sessionId !== this.#expectedSessionId) {
      return [{
        type: "diagnostic",
        channel: "stderr",
        severity: "error",
        message: "Hermes resumed a different session than the one this run is bound to.",
      }];
    }
    return [{ type: "session", sessionId }];
  }

  finish(options: { requireSession?: boolean } = {}): readonly HermesNormalizedStreamEvent[] {
    if (this.#finished) return [];
    this.#finished = true;
    const events: HermesNormalizedStreamEvent[] = [...this.#drainSession()];

    const answer = stripTerminalControls(this.#stdout).trim();
    if (answer) events.push({ type: "assistant", text: answer });

    // Everything on stderr other than the session line is Hermes talking about
    // itself. Keep it as one diagnostic so a failure stays explainable, but
    // never let it masquerade as the assistant's answer.
    const noise = stripTerminalControls(this.#stderr)
      .split(/\r?\n/u)
      .filter((line) => line.trim() && !/^\s*session_id:/iu.test(line))
      .join("\n")
      .trim();
    if (noise) {
      events.push({ type: "diagnostic", channel: "stderr", severity: "info", message: noise });
    }

    if (options.requireSession && !this.#sessionEmitted) {
      events.push({
        type: "diagnostic",
        channel: "stderr",
        severity: "error",
        message: "Hermes exited without announcing a session identifier.",
      });
    }
    if (!answer) {
      events.push({
        type: "diagnostic",
        channel: "stdout",
        severity: "error",
        message: "Hermes produced no answer text.",
      });
    }
    return events;
  }
}
