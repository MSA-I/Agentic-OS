const REDACTED = "[REDACTED]";
const MAX_INPUT_LOOKAHEAD = 64 * 1024;
const SECRET_KEY_WORDS = new Set([
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "passwd",
  "password",
  "privatekey",
  "secret",
  "setcookie",
  "signature",
  "token",
]);
const SECRET_KEY_PHRASES = [
  "accesskey",
  "accesstoken",
  "apikey",
  "authtoken",
  "clientsecret",
  "refreshtoken",
  "sessioncookie",
  "sessionsecret",
  "sessiontoken",
  "webhooksecret",
];
const NON_SECRET_DIGEST_KEYS = new Set([
  "checksum", "commit", "digest", "etag", "hash", "sha", "sha1", "sha256", "sha512", "version",
]);
const PATH_VALUE_KEYS = new Set([
  "absolutepath", "artifactpath", "cwd", "file", "filename", "filepath", "path", "relpath", "root", "source", "uri", "url",
]);
const SENSITIVE_PATH_SEGMENTS = new Set([".git", ".gnupg", ".ssh", "secret-data", "secrets", "vault-data"]);
const SENSITIVE_PATH_BASENAMES = new Set([
  ".env", ".git-credentials", ".netrc", ".npmrc", ".pypirc", "auth.json", "credentials.json", "secrets.json",
]);

function normalizeKey(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function isSecretKey(value: string): boolean {
  const normalized = normalizeKey(value);
  if (SECRET_KEY_WORDS.has(normalized)) return true;
  return SECRET_KEY_PHRASES.some((phrase) => normalized === phrase || normalized.endsWith(phrase));
}

function isPathValueKey(value: string): boolean {
  const normalized = normalizeKey(value);
  return PATH_VALUE_KEYS.has(normalized) || normalized.endsWith("path") || normalized.endsWith("uri") || normalized.endsWith("url");
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function looksLikeHighEntropySecret(key: string, rawValue: string): boolean {
  const value = rawValue.replace(/^['"]|['"]$/g, "");
  if (normalizeKey(key).endsWith("id") && !isSecretKey(key)) return false;
  if (value.length < 24 || value.length > 128 * 1024 || /\s/u.test(value)) return false;
  if (/^[0-9a-f]{7,128}$/iu.test(value) && NON_SECRET_DIGEST_KEYS.has(normalizeKey(key))) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) return false;
  if (/^(?:https?|file):\/\//iu.test(value)) return false;
  const classes = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[^A-Za-z0-9]/u]
    .reduce((count, pattern) => count + Number(pattern.test(value)), 0);
  return (classes >= 3 && shannonEntropy(value) >= 3.5)
    || (classes >= 2 && shannonEntropy(value) >= 4.15);
}

function redactSecretAssignments(value: string): string {
  let output = value.replace(
    /(["'])([^"'\r\n]{1,80})\1([ \t]*:[ \t]*)(["'])([^"'\r\n]*)\4/gu,
    (match, quote: string, key: string, separator: string, valueQuote: string, assigned: string) => {
      if (!isSecretKey(key) && !looksLikeHighEntropySecret(key, assigned)) return match;
      return `${quote}${key}${quote}${separator}${valueQuote}${REDACTED}${valueQuote}`;
    },
  );
  output = output.replace(
    /(\b(?:access[-_.]?key|access[-_.]?token|api[-_.]?key|auth[-_.]?token|authorization|client[-_.]?secret|cookie|credential|credentials|passwd|password|private[-_.]?key|refresh[-_.]?token|secret|session[-_.]?(?:cookie|secret|token)|set[-_.]?cookie|signature|token|webhook[-_.]?secret)\b)([ \t]*[:=][ \t]*(?:\r?\n[ \t]*)?)(["']?)([^\s,"';&#]+)\3/giu,
    (_match, key: string, separator: string, quote: string) => `${key}${separator}${quote}${REDACTED}${quote}`,
  );
  output = output.replace(
    /\b([A-Za-z][A-Za-z0-9_.-]{0,79})([ \t]*=[ \t]*)(["']?)([^\s,"';:=]{24,})\3/gu,
    (match, key: string, separator: string, quote: string, assigned: string) => {
      if (!looksLikeHighEntropySecret(key, assigned)) return match;
      return `${key}${separator}${quote}${REDACTED}${quote}`;
    },
  );
  return output;
}

function redactSensitivePathValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return value;
  let pathCandidate = trimmed;
  try {
    const parsed = new URL(trimmed);
    pathCandidate = parsed.protocol === "file:" ? decodeURIComponent(parsed.pathname) : parsed.pathname;
  } catch {
    // Plain local path or relative artifact path.
  }
  const segments = pathCandidate.replaceAll("\\", "/").split("/").filter(Boolean).map((segment) => segment.toLowerCase());
  const basename = segments.at(-1) ?? "";
  const sensitive = segments.some((segment) => SENSITIVE_PATH_SEGMENTS.has(segment))
    || SENSITIVE_PATH_BASENAMES.has(basename)
    || basename.startsWith(".env.")
    || basename.endsWith(".credentials.json")
    || /\.(?:key|keystore|p12|pem|pfx)$/iu.test(basename);
  return sensitive ? "[REDACTED_SENSITIVE_PATH]" : value;
}

export function redactText(value: string, maxLength = 32_000): string {
  const safeMaximum = Number.isFinite(maxLength) ? Math.max(0, Math.floor(maxLength)) : 32_000;
  const bounded = value.slice(0, Math.min(value.length, safeMaximum + MAX_INPUT_LOOKAHEAD));
  let output = bounded
    .replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/gu,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replace(/\bBearer[ \t]+[A-Za-z0-9._~+/-]+=*/giu, `Bearer ${REDACTED}`)
    .replace(/\bBasic[ \t]+[A-Za-z0-9+/]+=*/giu, `Basic ${REDACTED}`)
    .replace(/(^|\r?\n)([ \t]*(?:Cookie|Set-Cookie)[ \t]*:)[^\r\n]*/giu, `$1$2 ${REDACTED}`)
    .replace(/\b(?:sk|pk|rk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{12,}\b/gu, "[REDACTED_TOKEN]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/gu, "[REDACTED_AWS_KEY]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/gu, "[REDACTED_JWT]")
    .replace(
      /([?&](?:access_token|api[-_]?key|auth|authorization|client_secret|credential|key|password|refresh_token|secret|signature|sig|token)=)[^&#\s]*/giu,
      `$1${REDACTED}`,
    )
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu, `$1[REDACTED_CREDENTIALS]@`)
    .replace(
      /(\s--?(?:access[-_]?token|api[-_]?key|authorization|client[-_]?secret|cookie|credential|password|private[-_]?key|refresh[-_]?token|secret|signature|token))(?:=|[ \t]+)([^\s]+)/giu,
      `$1=${REDACTED}`,
    );
  output = redactSecretAssignments(output);
  return output.slice(0, safeMaximum);
}

/** Dedicated server-log boundary; keep raw errors out of logging call sites. */
export function redactLogMessage(value: unknown, maxLength = 4_000): string {
  return redactText(value instanceof Error ? value.message : String(value), maxLength);
}

export function redactRecord(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const walk = (entry: unknown, depth: number, parentKey: string | null): unknown => {
    if (depth > 8) return "[TRUNCATED]";
    if (typeof entry === "string") {
      const redacted = redactText(entry);
      if (parentKey && looksLikeHighEntropySecret(parentKey, redacted)) return REDACTED;
      return parentKey && isPathValueKey(parentKey) ? redactSensitivePathValue(redacted) : redacted;
    }
    if (typeof entry === "number" || typeof entry === "boolean" || entry === null) return entry;
    if (typeof entry === "bigint") return entry.toString();
    if (Array.isArray(entry)) return entry.slice(0, 100).map((item) => walk(item, depth + 1, parentKey));
    if (!entry || typeof entry !== "object") return null;
    if (seen.has(entry)) return "[CIRCULAR]";
    seen.add(entry);

    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, child] of Object.entries(entry as Record<string, unknown>).slice(0, 100)) {
      const safeKey = redactText(key, 256);
      result[safeKey] = isSecretKey(key) ? REDACTED : walk(child, depth + 1, key);
    }
    return result;
  };
  return walk(value, 0, null);
}

/** Safe export boundary for ledgers, diagnostics and future downloadable bundles. */
export function serializeRedactedJson(value: unknown, space?: number): string {
  return JSON.stringify(redactRecord(value), null, space);
}

function incompleteSensitiveSuffixStart(value: string): number | null {
  const privateKeyStart = value.search(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u);
  if (privateKeyStart >= 0 && !/-----END [A-Z0-9 ]*PRIVATE KEY-----/u.test(value.slice(privateKeyStart))) {
    return privateKeyStart;
  }
  const assignment = /(?:^|\r?\n)([^\r\n]*\b(?:access[-_]?token|api[-_]?key|authorization|client[-_]?secret|cookie|credential|password|passwd|private[-_]?key|refresh[-_]?token|secret|signature|token)[ \t]*[:=][^\r\n]*(?:\r?\n[^\r\n]*)?)$/iu.exec(value);
  return assignment ? assignment.index + (assignment[0].startsWith("\n") || assignment[0].startsWith("\r\n") ? assignment[0].indexOf(assignment[1]) : 0) : null;
}

export class StreamingRedactor {
  private pending = "";
  private discardMode: "private-key" | "secret-line" | null = null;
  private discardTail = "";

  push(chunk: string): string {
    if (this.discardMode) {
      const candidate = `${this.discardTail}${chunk}`;
      const terminator = this.discardMode === "private-key"
        ? /-----END [A-Z0-9 ]*PRIVATE KEY-----/u.exec(candidate)
        : /\r?\n/u.exec(candidate);
      if (!terminator) {
        this.discardTail = candidate.slice(-128);
        return "";
      }
      chunk = candidate.slice(terminator.index + terminator[0].length);
      this.discardMode = null;
      this.discardTail = "";
    }
    this.pending += chunk;
    const lastLineBreak = Math.max(this.pending.lastIndexOf("\n"), this.pending.lastIndexOf("\r"));
    if (lastLineBreak >= 0) {
      let safeEnd = lastLineBreak + 1;
      const complete = this.pending.slice(0, safeEnd);
      const sensitiveStart = incompleteSensitiveSuffixStart(complete);
      if (sensitiveStart !== null) safeEnd = sensitiveStart;
      if (safeEnd > 0) {
        const ready = this.pending.slice(0, safeEnd);
        this.pending = this.pending.slice(safeEnd);
        return redactText(ready, Number.MAX_SAFE_INTEGER);
      }
    }
    if (this.pending.length > 64 * 1024) {
      const sensitiveStart = incompleteSensitiveSuffixStart(this.pending);
      if (sensitiveStart !== null) {
        const safePrefix = this.pending.slice(0, sensitiveStart);
        const sensitiveSuffix = this.pending.slice(sensitiveStart);
        this.discardMode = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u.test(sensitiveSuffix)
          ? "private-key"
          : "secret-line";
        this.pending = "";
        const marker = this.discardMode === "private-key" ? "[REDACTED_SECRET_BLOCK]" : "[REDACTED_SECRET_LINE]";
        return `${redactText(safePrefix, Number.MAX_SAFE_INTEGER)}${marker}`;
      }
      const safePrefixLength = this.pending.length - 4_096;
      const prefix = this.pending.slice(0, safePrefixLength);
      this.pending = this.pending.slice(safePrefixLength);
      return redactText(prefix, Number.MAX_SAFE_INTEGER);
    }
    return "";
  }

  flush(): string {
    const output = redactText(this.pending, Number.MAX_SAFE_INTEGER);
    this.pending = "";
    this.discardMode = null;
    this.discardTail = "";
    return output;
  }
}

/** Byte-stream boundary for stdout, stderr, SSE and future export downloads. */
export function createRedactingTextStream(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const redactor = new StreamingRedactor();
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const output = redactor.push(decoder.decode(chunk, { stream: true }));
      if (output) controller.enqueue(encoder.encode(output));
    },
    flush(controller) {
      const decoderTail = decoder.decode();
      const output = `${decoderTail ? redactor.push(decoderTail) : ""}${redactor.flush()}`;
      if (output) controller.enqueue(encoder.encode(output));
    },
  });
}
