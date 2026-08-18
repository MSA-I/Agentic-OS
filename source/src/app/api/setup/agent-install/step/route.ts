import { authorizeLocalMutation } from "@/lib/control-plane/executionFreeze";
import { authorizeSetupMutation } from "@/lib/setupRequestSecurity";
import { claimPlanStep } from "@/lib/agentInstall/planStore";
import { runPlanStep } from "@/lib/agentInstall/executor";
import { SetupRuntimeError } from "@/lib/setupRuntime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 2_000;

const CLAIM_STATUS: Record<string, number> = {
  plan_unknown: 403,
  plan_expired: 403,
  step_already_run: 409,
  step_not_runnable: 409,
  step_out_of_range: 400,
};

const CLAIM_MESSAGE: Record<string, string> = {
  plan_unknown: "התוכנית אינה מוכרת. אשר אותה מחדש.",
  plan_expired: "התוקף של התוכנית פג. אשר אותה מחדש.",
  step_already_run: "הצעד הזה כבר רץ.",
  step_not_runnable: "הצעד הזה ידני ואינו רץ אוטומטית.",
  step_out_of_range: "אין צעד במספר הזה בתוכנית.",
};

/**
 * Runs one step of a plan the user already approved.
 *
 * The request carries only a plan id and a step index: the program and its
 * arguments come from the server's own copy, so what runs is what the user read.
 * Each index is single-use, so an approved plan cannot be replayed.
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
  if (Object.keys(payload).some((key) => !["planId", "stepIndex"].includes(key))) {
    return Response.json({ error: "Unknown request field." }, { status: 400 });
  }
  if (typeof payload.planId !== "string" || !/^[A-Za-z0-9_-]{16,64}$/u.test(payload.planId)) {
    return Response.json({ error: "planId is invalid." }, { status: 400 });
  }

  const claim = claimPlanStep(payload.planId, payload.stepIndex as number);
  if ("error" in claim) {
    return Response.json(
      { error: CLAIM_MESSAGE[claim.error] ?? "הצעד נדחה.", code: claim.error },
      { status: CLAIM_STATUS[claim.error] ?? 400 },
    );
  }

  try {
    const outcome = await runPlanStep(claim.plan.route, claim.step);
    return Response.json(outcome, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    if (error instanceof SetupRuntimeError) {
      return Response.json(
        { ok: false, message: error.message },
        { status: error.status, headers: { "Cache-Control": "private, no-store, max-age=0" } },
      );
    }
    return Response.json(
      { ok: false, message: "הצעד נכשל." },
      { status: 500, headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  }
}
