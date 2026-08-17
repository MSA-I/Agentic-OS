import { createHash } from "node:crypto";
import {
  WAVE1_FROZEN_EXECUTION_ROUTES as FROZEN_ROUTES,
  type FrozenExecutionRoute as FrozenExecutionRouteId,
} from "./frozenExecutionRoutes";
import {
  assessCapability,
  createCapabilityStatus,
  createVerificationInputs,
} from "./capability";
import { assessApprovalEnforcement } from "./approval";
import {
  assertIdentityMatch,
  type ControlPlaneIdentity,
  ControlPlaneIdentityError,
} from "./identity";
import {
  FailClosedPolicyEngine,
  type ExecutionGuardState,
  type PolicyOperation,
} from "./policy";

export {
  WAVE1_FROZEN_EXECUTION_ROUTES,
  type FrozenExecutionRoute,
} from "./frozenExecutionRoutes";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const FROZEN_ROUTE_SET = new Set<string>(FROZEN_ROUTES);
const MAXIMUM_EXECUTION_BODY_BYTES = 64 * 1024;
const EMPTY_GUARDS: ExecutionGuardState = Object.freeze({
  identityVerified: false,
  containmentVerified: false,
  secretControlsVerified: false,
  approvalEnforced: false,
  executableVerified: false,
  capabilityVerified: false,
});
const policy = new FailClosedPolicyEngine();
const verificationInputs = createVerificationInputs({
  executableHash: "unavailable",
  runtimeHash: "unavailable",
  configHash: "unavailable",
  toolHash: "unavailable",
  credentialRevision: "unavailable",
  policyHash: createHash("sha256").update("wave1-default-deny").digest("hex"),
  manifestHash: createHash("sha256").update(FROZEN_ROUTES.join("\n")).digest("hex"),
});

export class ControlPlaneCommandDeniedError extends Error {
  readonly code: "identity_mismatch" | "control_plane_execution_unavailable";
  readonly status: 403 | 503;

  constructor(
    message: string,
    code: "identity_mismatch" | "control_plane_execution_unavailable",
    status: 403 | 503,
  ) {
    super(message);
    this.name = "ControlPlaneCommandDeniedError";
    this.code = code;
    this.status = status;
  }
}

/** Shared supervisor gate. All guard inputs reflect current Wave 1 reality. */
export function assertWave1ControlPlaneCommandUnavailable(input: {
  operation: PolicyOperation;
  expectedIdentity: ControlPlaneIdentity;
  actualIdentity: ControlPlaneIdentity;
}): void {
  try {
    assertIdentityMatch(input.expectedIdentity, input.actualIdentity);
  } catch (error) {
    if (error instanceof ControlPlaneIdentityError) {
      throw new ControlPlaneCommandDeniedError(
        "Control-plane command identity does not match its run target.",
        "identity_mismatch",
        403,
      );
    }
    throw error;
  }

  const approval = assessApprovalEnforcement({
    durableGrantStore: false,
    atomicAllowOnce: false,
    preExecutionHook: false,
  });
  const capability = assessCapability(createCapabilityStatus({
    id: `agent-os:workbench:${input.operation}`,
    category: "invokable-tool",
    stage: "restricted",
    securityCritical: true,
    preExecutionApprovalEnforced: approval.enforced,
    evidence: null,
  }), verificationInputs);
  const decision = policy.decide({
    operation: input.operation,
    identity: input.actualIdentity,
    guards: EMPTY_GUARDS,
    risk: "critical",
    metadata: { approval: approval.code, capability: capability.verification },
  });
  if (decision.allowed) {
    throw new Error("Wave 1 command policy unexpectedly allowed execution.");
  }
  throw new ControlPlaneCommandDeniedError(
    "Execution is disabled until every required control-plane guard is live.",
    "control_plane_execution_unavailable",
    503,
  );
}

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function port(url: URL): string {
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

function requestOrigin(request: Request): URL | null {
  try {
    const requestUrl = new URL(request.url);
    const host = request.headers.get("host")?.trim();
    if (!host || host.includes(",") || !LOOPBACK_HOSTS.has(requestUrl.hostname.toLowerCase())) return null;
    if (!['http:', 'https:'].includes(requestUrl.protocol) || requestUrl.username || requestUrl.password) return null;
    const origin = new URL(`${requestUrl.protocol}//${host}`);
    if (!LOOPBACK_HOSTS.has(origin.hostname.toLowerCase()) || port(origin) !== port(requestUrl)) return null;
    if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) return null;
    return origin;
  } catch {
    return null;
  }
}

/**
 * The local HTTP boundary for any mutation that is not served by the Workbench:
 * loopback URL, single loopback `Host` that matches the URL port, an `Origin`
 * that equals it exactly, and no cross-site fetch metadata. Exported so a route
 * that is deliberately kept live shares this one implementation instead of
 * growing a second, weaker copy.
 */
export function authorizeLocalMutation(request: Request): Response | null {
  const expected = requestOrigin(request);
  if (!expected) return json({ code: "local_boundary_denied", error: "Execution APIs are local-only." }, 403);
  const originHeader = request.headers.get("origin");
  if (!originHeader) return json({ code: "origin_required", error: "Execution APIs require a browser Origin." }, 403);
  let origin: URL;
  try { origin = new URL(originHeader); }
  catch { return json({ code: "origin_invalid", error: "Execution API Origin is invalid." }, 403); }
  if (origin.origin !== originHeader || origin.protocol !== expected.protocol || origin.hostname.toLowerCase() !== expected.hostname.toLowerCase() || port(origin) !== port(expected)) {
    return json({ code: "origin_mismatch", error: "Execution API Origin must match this local app." }, 403);
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") {
    return json({ code: "cross_site_denied", error: "Cross-site execution requests are not allowed." }, 403);
  }
  return null;
}

/**
 * Reads a JSON mutation body under the same limits the frozen routes use:
 * `application/json` only, `Content-Length` checked before reading, streamed
 * bytes capped, and the parsed value must be a plain object. Returns either the
 * refusal response or the parsed body, so a caller that needs the payload does
 * not have to re-read a consumed stream.
 */
export async function readLocalMutationJson(
  request: Request,
): Promise<{ error: Response } | { body: Record<string, unknown> }> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return { error: json({ code: "json_required", error: "Content-Type must be application/json." }, 415) };
  }
  const rawLength = request.headers.get("content-length");
  if (rawLength !== null) {
    const length = Number(rawLength);
    if (!Number.isSafeInteger(length) || length < 0) return { error: json({ code: "invalid_length", error: "Content-Length is invalid." }, 400) };
    if (length > MAXIMUM_EXECUTION_BODY_BYTES) return { error: json({ code: "body_too_large", error: "Request body is too large." }, 413) };
  }
  const reader = request.body?.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAXIMUM_EXECUTION_BODY_BYTES) {
        await reader.cancel();
        return { error: json({ code: "body_too_large", error: "Request body is too large." }, 413) };
      }
      chunks.push(value);
    }
  }
  try {
    const decoded = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes).toString("utf8");
    const parsed = JSON.parse(decoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object required");
    return { body: parsed as Record<string, unknown> };
  } catch {
    return { error: json({ code: "invalid_json", error: "Request body must be a JSON object." }, 400) };
  }
}

async function validateJsonBody(request: Request): Promise<Response | null> {
  const result = await readLocalMutationJson(request);
  return "error" in result ? result.error : null;
}

/**
 * Wave 1 route-level source of truth. No execution authority can be minted yet:
 * durable approvals, containment, capability evidence, and command identity are
 * incomplete. Every listed route therefore stops before its original handler.
 */
export async function denyFrozenExecutionMutation(
  request: Request,
  route: FrozenExecutionRouteId,
): Promise<Response | null> {
  const [routeMethod, routePath] = route.split(" ", 2);
  const requestPath = new URL(request.url).pathname;
  const routeSegments = routePath.split("/").filter(Boolean);
  const requestSegments = requestPath.split("/").filter(Boolean);
  const pathMatches = routeSegments.length === requestSegments.length
    && routeSegments.every((segment, index) => /^\[[A-Za-z0-9_]+\]$/u.test(segment) || segment === requestSegments[index]);
  if (!FROZEN_ROUTE_SET.has(route) || routeMethod !== request.method.toUpperCase() || !pathMatches) {
    return json({ code: "execution_route_mismatch", error: "Execution route identity mismatch." }, 403);
  }
  const boundaryError = authorizeLocalMutation(request);
  if (boundaryError) return boundaryError;
  const bodyError = await validateJsonBody(request);
  if (bodyError) return bodyError;

  const approval = assessApprovalEnforcement({
    durableGrantStore: false,
    atomicAllowOnce: false,
    preExecutionHook: false,
  });
  const capability = assessCapability(createCapabilityStatus({
    id: `agent-os:${route.toLowerCase().replaceAll(/[^a-z0-9]+/g, ":").replace(/^:+|:+$/g, "")}`,
    category: "invokable-tool",
    stage: "restricted",
    securityCritical: true,
    preExecutionApprovalEnforced: approval.enforced,
    evidence: null,
  }), verificationInputs);
  const decision = policy.decide({
    operation: "start",
    identity: null,
    guards: EMPTY_GUARDS,
    risk: "critical",
    metadata: { route },
  });

  return json({
    code: "control_plane_execution_unavailable",
    error: "Execution is disabled until canonical identity, policy, containment, durable approval, secret, executable, and capability gates are live.",
    policy: decision.code,
    capability: capability.verification,
    approval: approval.code,
    runCreated: false,
  }, 503);
}
