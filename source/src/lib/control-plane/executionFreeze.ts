import { createHash } from "node:crypto";
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

export const WAVE1_FROZEN_EXECUTION_ROUTES = [
  "POST /api/agent-kanban/build",
  "POST /api/agent-kanban/plan",
  "POST /api/antigravity/chat",
  "POST /api/appslab/run",
  "POST /api/appslab/stop",
  "POST /api/astros/notebook",
  "POST /api/astros/scan",
  "POST /api/claude/ant",
  "POST /api/claude/ant/agents/run",
  "POST /api/claude/chat",
  "POST /api/codex/chat",
  "POST /api/dscoder/chat",
  "POST /api/freeclaude/build",
  "POST /api/freeclaude/chat",
  "POST /api/furnace/scan",
  "POST /api/fusion/chat",
  "POST /api/games/commission",
  "POST /api/glm-code/build",
  "POST /api/glm/chat",
  "POST /api/grok/chat",
  "POST /api/hermes/apollo",
  "POST /api/hermes/chat",
  "POST /api/hermes/dashboard",
  "POST /api/hermes/goals",
  "DELETE /api/hermes/goals",
  "PATCH /api/hermes/goals",
  "POST /api/hermes/kanban/action",
  "POST /api/hermes/kanban/dispatch",
  "POST /api/hermes/mcp/install",
  "POST /api/hermes/mcp",
  "POST /api/hermes/mcp/add",
  "POST /api/hermes/mcp/tools",
  "POST /api/hermes/media",
  "POST /api/hermes/phone/install-tunnel",
  "POST /api/hermes/phone/sync",
  "POST /api/hermes/phone/tunnel",
  "POST /api/hermes/realtime/open",
  "POST /api/hermes/realtime/session",
  "POST /api/hermes/studio/generate",
  "POST /api/hermes/tts",
  "POST /api/hermes/wake",
  "POST /api/higgs/run",
  "POST /api/hy3coder/chat",
  "POST /api/jcode/build",
  "POST /api/kimi/chat",
  "POST /api/local-hermes/run",
  "POST /api/local/chat",
  "POST /api/loop/run",
  "POST /api/leads/enrich",
  "POST /api/leads/find",
  "POST /api/leads/icp",
  "POST /api/leads/score",
  "POST /api/moa",
  "POST /api/music/generate",
  "POST /api/musecoder/chat",
  "POST /api/notebooklm/artifact/download",
  "POST /api/notebooklm/ask",
  "POST /api/notebooklm/notebooks",
  "DELETE /api/notebooklm/notebooks/[id]",
  "PATCH /api/notebooklm/notebooks/[id]",
  "POST /api/notebooklm/research",
  "POST /api/notebooklm/research/import",
  "POST /api/notebooklm/shortvideo",
  "POST /api/notebooklm/studio",
  "POST /api/omniroute/chat",
  "POST /api/openclaw/chat",
  "POST /api/openclaw/studio/chat-quick",
  "POST /api/openclaw/studio/image",
  "POST /api/openclaw/studio/stt",
  "POST /api/openclaw/studio/tts",
  "POST /api/openclaw/studio/video",
  "POST /api/openclaw/studio/xsearch",
  "POST /api/opencode/build",
  "POST /api/opendesign/control",
  "DELETE /api/opendesign/projects",
  "POST /api/openmontage/generate",
  "POST /api/outreach/write",
  "POST /api/outreach/enrich",
  "POST /api/outreach/send",
  "POST /api/outreach/validate",
  "POST /api/pipeline/build",
  "POST /api/pipeline/decide",
  "POST /api/pipeline/shape",
  "POST /api/radar/draft",
  "POST /api/radar/publish",
  "POST /api/radar/scan",
  "POST /api/ruflo/swarm",
  "POST /api/run",
  "POST /api/room",
  "POST /api/sakana/chat",
  "POST /api/seo/deploy",
  "POST /api/seo/generate",
  "POST /api/seo/index",
  "POST /api/seo/parasite",
  "POST /api/seo/research",
  "POST /api/setup/action",
  "POST /api/thumbnails/generate",
  "POST /api/thumbnails/research",
  "POST /api/translate/gemini-live",
  "POST /api/video/auto/assemble",
  "POST /api/video/auto/script",
  "POST /api/video/heygen/generate",
  "POST /api/video/hyperframes/init",
  "POST /api/video/hyperframes/keyframes",
  "POST /api/video/hyperframes/render",
  "POST /api/videouse/run",
] as const;

export type FrozenExecutionRoute = (typeof WAVE1_FROZEN_EXECUTION_ROUTES)[number];

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const FROZEN_ROUTE_SET = new Set<string>(WAVE1_FROZEN_EXECUTION_ROUTES);
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
  manifestHash: createHash("sha256").update(WAVE1_FROZEN_EXECUTION_ROUTES.join("\n")).digest("hex"),
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

function authorizeLocalMutation(request: Request): Response | null {
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

async function validateJsonBody(request: Request): Promise<Response | null> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return json({ code: "json_required", error: "Content-Type must be application/json." }, 415);
  }
  const rawLength = request.headers.get("content-length");
  if (rawLength !== null) {
    const length = Number(rawLength);
    if (!Number.isSafeInteger(length) || length < 0) return json({ code: "invalid_length", error: "Content-Length is invalid." }, 400);
    if (length > MAXIMUM_EXECUTION_BODY_BYTES) return json({ code: "body_too_large", error: "Request body is too large." }, 413);
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
        return json({ code: "body_too_large", error: "Request body is too large." }, 413);
      }
      chunks.push(value);
    }
  }
  try {
    const decoded = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes).toString("utf8");
    const parsed = JSON.parse(decoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object required");
  } catch {
    return json({ code: "invalid_json", error: "Request body must be a JSON object." }, 400);
  }
  return null;
}

/**
 * Wave 1 route-level source of truth. No execution authority can be minted yet:
 * durable approvals, containment, capability evidence, and command identity are
 * incomplete. Every listed route therefore stops before its original handler.
 */
export async function denyFrozenExecutionMutation(
  request: Request,
  route: FrozenExecutionRoute,
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
