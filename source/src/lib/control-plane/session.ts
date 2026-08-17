import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const WORKBENCH_SESSION_COOKIE = "agent_os_workbench_session";
export const WORKBENCH_MUTATION_COOKIE = "agent_os_workbench_mutation";
export const WORKBENCH_BOOTSTRAP_HEADER = "x-agent-os-bootstrap-token";

const DEFAULT_SESSION_TTL_SECONDS = 15 * 60;
const MINIMUM_SESSION_TTL_SECONDS = 60;
const MAXIMUM_SESSION_TTL_SECONDS = 60 * 60;
const MAXIMUM_LIVE_SESSIONS = 16;
const TOKEN_PART = /^[A-Za-z0-9_-]{20,128}$/;

interface LocalSessionRecord {
  id: string;
  binding: string;
  sessionHash: Buffer;
  mutationHash: Buffer | null;
  createdAt: number;
  expiresAt: number;
}

interface LocalSessionStore {
  sessions: Map<string, LocalSessionRecord>;
}

export interface WorkbenchSessionIssue {
  sessionCookie: string;
  mutationCookie: string;
  expiresAt: string;
  maxAgeSeconds: number;
}

export class WorkbenchSessionError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

declare global {
  // Keep local browser sessions stable across development HMR. A process
  // restart intentionally invalidates every session and requires bootstrap.
  // eslint-disable-next-line no-var
  var __agentOsWorkbenchSessionStore: LocalSessionStore | undefined;
}

function store(): LocalSessionStore {
  if (!globalThis.__agentOsWorkbenchSessionStore) {
    globalThis.__agentOsWorkbenchSessionStore = { sessions: new Map() };
  }
  return globalThis.__agentOsWorkbenchSessionStore;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function secretMatches(value: string, expectedHash: Buffer): boolean {
  return timingSafeEqual(digest(value), expectedHash);
}

function configuredTtlSeconds(): number {
  const raw = process.env.AGENT_OS_WORKBENCH_SESSION_TTL_SECONDS;
  if (!raw) return DEFAULT_SESSION_TTL_SECONDS;
  const parsed = Number(raw);
  if (
    !Number.isInteger(parsed)
    || parsed < MINIMUM_SESSION_TTL_SECONDS
    || parsed > MAXIMUM_SESSION_TTL_SECONDS
  ) {
    throw new WorkbenchSessionError("Workbench session configuration is invalid.", 503);
  }
  return parsed;
}

function purgeExpired(now: number): void {
  for (const [id, session] of store().sessions) {
    if (session.expiresAt <= now) store().sessions.delete(id);
  }
}

function enforceSessionLimit(): void {
  const sessions = [...store().sessions.values()]
    .sort((left, right) => left.createdAt - right.createdAt);
  while (sessions.length >= MAXIMUM_LIVE_SESSIONS) {
    const oldest = sessions.shift();
    if (oldest) store().sessions.delete(oldest.id);
  }
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function encodeToken(id: string, secret: string): string {
  return `${id}.${secret}`;
}

function decodeToken(value: string | null, label: string): { id: string; secret: string } {
  if (!value) throw new WorkbenchSessionError(`${label} is required.`, 401);
  const parts = value.split(".");
  if (parts.length !== 2 || !TOKEN_PART.test(parts[0]) || !TOKEN_PART.test(parts[1])) {
    throw new WorkbenchSessionError(`${label} is invalid.`, 401);
  }
  return { id: parts[0], secret: parts[1] };
}

function cookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  const values: string[] = [];
  for (const item of cookieHeader.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) {
      values.push(item.slice(separator + 1).trim());
    }
  }
  if (values.length > 1) {
    throw new WorkbenchSessionError("Duplicate Workbench session cookies are not allowed.", 401);
  }
  return values[0] ?? null;
}

function requireSession(
  cookieHeader: string | null,
  binding: string,
  now = Date.now(),
): LocalSessionRecord {
  purgeExpired(now);
  const token = decodeToken(
    cookieValue(cookieHeader, WORKBENCH_SESSION_COOKIE),
    "Workbench session token",
  );
  const session = store().sessions.get(token.id);
  if (
    !session
    || session.binding !== binding
    || session.expiresAt <= now
    || !secretMatches(token.secret, session.sessionHash)
  ) {
    throw new WorkbenchSessionError("Workbench session token is invalid or expired.", 401);
  }
  return session;
}

function buildIssue(
  session: LocalSessionRecord,
  sessionSecret: string,
  mutationSecret: string,
  now: number,
): WorkbenchSessionIssue {
  return {
    sessionCookie: encodeToken(session.id, sessionSecret),
    mutationCookie: encodeToken(session.id, mutationSecret),
    expiresAt: new Date(session.expiresAt).toISOString(),
    maxAgeSeconds: Math.max(0, Math.floor((session.expiresAt - now) / 1000)),
  };
}

export function validateWorkbenchBootstrapSecret(candidate: string | null): void {
  const configured = process.env.AGENT_OS_WORKBENCH_BOOTSTRAP_SECRET;
  if (!configured || configured.length < 32) {
    throw new WorkbenchSessionError("Workbench browser bootstrap is unavailable.", 503);
  }
  if (!candidate || !secretMatches(candidate, digest(configured))) {
    throw new WorkbenchSessionError("Workbench browser bootstrap was denied.", 401);
  }
}

export function createWorkbenchSession(binding: string, now = Date.now()): WorkbenchSessionIssue {
  purgeExpired(now);
  const ttlSeconds = configuredTtlSeconds();
  enforceSessionLimit();
  const id = randomToken();
  const sessionSecret = randomToken();
  const mutationSecret = randomToken();
  const session: LocalSessionRecord = {
    id,
    binding,
    sessionHash: digest(sessionSecret),
    mutationHash: digest(mutationSecret),
    createdAt: now,
    expiresAt: now + ttlSeconds * 1000,
  };
  store().sessions.set(id, session);
  return buildIssue(session, sessionSecret, mutationSecret, now);
}

export function rotateWorkbenchSession(
  cookieHeader: string | null,
  binding: string,
  now = Date.now(),
): WorkbenchSessionIssue {
  const session = requireSession(cookieHeader, binding, now);
  const sessionSecret = randomToken();
  const mutationSecret = randomToken();
  session.sessionHash = digest(sessionSecret);
  session.mutationHash = digest(mutationSecret);
  return buildIssue(session, sessionSecret, mutationSecret, now);
}

export function authorizeWorkbenchSession(
  cookieHeader: string | null,
  binding: string,
  now = Date.now(),
): void {
  requireSession(cookieHeader, binding, now);
}

export function requireWorkbenchCallerSessionId(
  cookieHeader: string | null,
  binding: string,
  now = Date.now(),
): string {
  return requireSession(cookieHeader, binding, now).id;
}

export function consumeWorkbenchMutation(
  cookieHeader: string | null,
  binding: string,
  now = Date.now(),
): void {
  const session = requireSession(cookieHeader, binding, now);
  const mutation = decodeToken(
    cookieValue(cookieHeader, WORKBENCH_MUTATION_COOKIE),
    "Workbench mutation token",
  );
  if (
    mutation.id !== session.id
    || !session.mutationHash
    || !secretMatches(mutation.secret, session.mutationHash)
  ) {
    throw new WorkbenchSessionError("Workbench mutation token is invalid or already used.", 401);
  }

  // Node executes this comparison-and-clear synchronously. The token is spent
  // before route code can produce a side effect, so concurrent replay fails.
  session.mutationHash = null;
}

export function appendWorkbenchSessionCookies(
  response: Response,
  issue: WorkbenchSessionIssue,
  secure: boolean,
): Response {
  const attributes = [
    "Path=/api/workbench",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${issue.maxAgeSeconds}`,
    secure ? "Secure" : null,
  ].filter(Boolean).join("; ");
  response.headers.append(
    "Set-Cookie",
    `${WORKBENCH_SESSION_COOKIE}=${issue.sessionCookie}; ${attributes}`,
  );
  response.headers.append(
    "Set-Cookie",
    `${WORKBENCH_MUTATION_COOKIE}=${issue.mutationCookie}; ${attributes}`,
  );
  return response;
}
