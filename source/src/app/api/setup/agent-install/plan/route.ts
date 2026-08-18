import { authorizeLocalMutation } from "@/lib/control-plane/executionFreeze";
import { authorizeSetupMutation } from "@/lib/setupRequestSecurity";
import { storeApprovedPlan } from "@/lib/agentInstall/planStore";
import { getSetupEntry } from "@/lib/setupCatalog";
import type { PlanStep } from "@/lib/agentInstall/planSchema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 20_000;
const MAX_STEPS = 12;

/**
 * Records the plan the user approved and hands back a token.
 *
 * This route never spawns anything. Its whole purpose is to move "the user
 * approved this list" from the browser, where it is only a UI state, to the
 * server, where the step route can rely on it. After this, an execution request
 * carries a plan id and a step index and nothing else — no program name, no
 * argument.
 */
export async function POST(request: Request) {
  const boundary = authorizeLocalMutation(request);
  if (boundary) return boundary;
  const authorization = authorizeSetupMutation(request);
  if (!authorization.allowed) {
    return Response.json({ error: authorization.error }, { status: 403 });
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return Response.json({ error: "Content-Type must be application/json." }, { status: 415 });
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return Response.json({ error: "Request body is too large." }, { status: 413 });
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
      return Response.json({ error: "Request body is too large." }, { status: 413 });
    }
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Request body must be a JSON object." }, { status: 400 });
  }
  const payload = body as Record<string, unknown>;
  if (Object.keys(payload).some((key) => !["route", "steps"].includes(key))) {
    return Response.json({ error: "Unknown request field." }, { status: 400 });
  }

  const route = typeof payload.route === "string" ? payload.route : "";
  if (!getSetupEntry(route)) {
    return Response.json({ error: "Unknown service route." }, { status: 404 });
  }
  if (!Array.isArray(payload.steps) || payload.steps.length === 0 || payload.steps.length > MAX_STEPS) {
    return Response.json({ error: "A plan must carry between 1 and 12 steps." }, { status: 400 });
  }

  const stored = storeApprovedPlan(route, payload.steps as readonly PlanStep[]);
  if ("error" in stored) {
    return Response.json({ error: stored.error, code: "plan_rejected" }, { status: 403 });
  }
  return Response.json(stored, {
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
}
