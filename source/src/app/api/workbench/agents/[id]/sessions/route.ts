import { getWorkbenchAdapter } from "@/lib/workbench/adapters";
import {
  authorizeWorkbenchRead,
  parseLimit,
  validateRunId,
  WorkbenchValidationError,
  workbenchError,
  workbenchJson,
} from "@/lib/workbench/http";
import {
  WorkbenchNotFoundError,
  WorkbenchUnsupportedError,
} from "@/lib/workbench/supervisor";
import type { AdapterResult, NativeSessionSummary, WorkContext } from "@/lib/workbench/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAFE_CONTEXT_ID = /^[A-Za-z0-9_.:@/-]{1,240}$/;

function optionalContextId(value: string | null, label: string): string | null {
  if (!value) return null;
  if (!SAFE_CONTEXT_ID.test(value)) throw new WorkbenchValidationError(`${label} is invalid.`);
  return value;
}

function unwrap<T>(result: AdapterResult<T>): T {
  if (result.ok) return result.value;
  if (result.code === "unsupported") throw new WorkbenchUnsupportedError(result.message);
  if (result.code === "not_found") throw new WorkbenchNotFoundError(result.message);
  throw new Error(result.message);
}

/** Native session read-through. Transcript bodies remain in the provider store. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    authorizeWorkbenchRead(request);
    const { id } = await context.params;
    const adapter = getWorkbenchAdapter(validateRunId(id));
    if (!adapter) throw new WorkbenchNotFoundError("Workbench adapter not found.");

    const url = new URL(request.url);
    const sessionId = optionalContextId(url.searchParams.get("sessionId"), "sessionId");
    const workContext: WorkContext = {
      agentId: adapter.descriptor.id,
      actorId: optionalContextId(url.searchParams.get("actorId"), "actorId"),
      projectId: optionalContextId(url.searchParams.get("projectId"), "projectId"),
      sessionId,
      environment: url.searchParams.get("environment") === "worktree" ? "worktree" : "local",
      panel: "transcript",
    };

    if (sessionId) {
      const session = unwrap<NativeSessionSummary>(await adapter.load(sessionId, workContext));
      return workbenchJson({ agent: adapter.descriptor, session });
    }

    const allSessions = unwrap<NativeSessionSummary[]>(await adapter.list(workContext));
    const rawOffset = url.searchParams.get("offset") ?? "0";
    const offset = Number(rawOffset);
    if (!Number.isInteger(offset) || offset < 0) throw new WorkbenchValidationError("offset must be a non-negative integer.");
    // workbenchJson intentionally redacts/truncates arrays at 100 entries.
    const limit = Math.min(parseLimit(url.searchParams.get("limit"), 50), 100);
    const sessions = allSessions.slice(offset, offset + limit);
    const nextOffset = offset + sessions.length < allSessions.length ? offset + sessions.length : null;
    return workbenchJson({
      agent: adapter.descriptor,
      sessions,
      sessionCount: allSessions.length,
      returnedCount: sessions.length,
      offset,
      nextOffset,
    });
  } catch (error) {
    return workbenchError(error);
  }
}
