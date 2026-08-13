import "server-only";

import { randomBytes, timingSafeEqual } from "node:crypto";

const CAPABILITY_COOKIE = "agentos_setup_capability";
const CAPABILITY_MAX_AGE_SECONDS = 8 * 60 * 60;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

declare global {
  // Keep one token across route bundles and development hot reloads.
  // eslint-disable-next-line no-var
  var __agentosSetupCapability: string | undefined;
}

function setupCapability(): string {
  if (!globalThis.__agentosSetupCapability) {
    globalThis.__agentosSetupCapability = randomBytes(32).toString("base64url");
  }
  return globalThis.__agentosSetupCapability;
}

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

function requestOrigin(request: Request): URL | null {
  const host = request.headers.get("host")?.trim();
  if (!host) return null;

  try {
    const requestUrl = new URL(request.url);
    const origin = new URL(`${requestUrl.protocol}//${host}`);
    if (!isLoopbackHostname(requestUrl.hostname) || !isLoopbackHostname(origin.hostname)) return null;
    if (origin.protocol !== "http:" && origin.protocol !== "https:") return null;
    return origin;
  } catch {
    return null;
  }
}

function effectivePort(url: URL): string {
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function isLoopbackRequest(request: Request): boolean {
  return requestOrigin(request) !== null;
}

export function setupCapabilityCookie(): string {
  return `${CAPABILITY_COOKIE}=${encodeURIComponent(setupCapability())}; HttpOnly; SameSite=Strict; Path=/api/setup; Max-Age=${CAPABILITY_MAX_AGE_SECONDS}`;
}

export function authorizeSetupMutation(request: Request): { allowed: true } | { allowed: false; error: string } {
  const expectedOrigin = requestOrigin(request);
  if (!expectedOrigin) {
    return { allowed: false, error: "Setup actions are available only through this app on localhost." };
  }

  const rawOrigin = request.headers.get("origin");
  if (!rawOrigin) {
    return { allowed: false, error: "Setup actions require a browser Origin header." };
  }

  let callerOrigin: URL;
  try {
    callerOrigin = new URL(rawOrigin);
  } catch {
    return { allowed: false, error: "Setup action Origin is invalid." };
  }

  if (!isLoopbackHostname(callerOrigin.hostname)
    || callerOrigin.protocol !== expectedOrigin.protocol
    || effectivePort(callerOrigin) !== effectivePort(expectedOrigin)) {
    return { allowed: false, error: "Setup action Origin must match this local app." };
  }

  const suppliedCapability = cookieValue(request, CAPABILITY_COOKIE);
  if (!suppliedCapability || !constantTimeEqual(suppliedCapability, setupCapability())) {
    return { allowed: false, error: "Setup authorization expired. Reopen the Setup Center and try again." };
  }

  return { allowed: true };
}
