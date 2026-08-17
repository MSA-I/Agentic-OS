import {
  authorizeWorkbenchStream,
  validateRunId,
  WorkbenchValidationError,
  workbenchError,
  workbenchJson,
} from "@/lib/workbench/http";
import { getDurableWorkbenchControlPlane } from "@/lib/workbench/durableControlPlane";
import { createRedactingTextStream } from "@/lib/workbench/redaction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseCursor(request: Request): number {
  const url = new URL(request.url);
  const raw = url.searchParams.get("after") ?? request.headers.get("last-event-id") ?? "0";
  const cursor = Number(raw);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new WorkbenchValidationError("after must be a non-negative event sequence.");
  }
  return cursor;
}

function parseLimit(request: Request): number {
  const raw = new URL(request.url).searchParams.get("limit") ?? "500";
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new WorkbenchValidationError("limit must be an integer from 1 through 1000.");
  }
  return limit;
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    authorizeWorkbenchStream(request);
    const { id } = await context.params;
    const runId = validateRunId(id);
    const url = new URL(request.url);
    if (url.searchParams.get("mode") === "page") {
      const page = getDurableWorkbenchControlPlane().eventPage(
        runId,
        parseCursor(request),
        parseLimit(request),
      );
      return workbenchJson(page, {
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    const stream = getDurableWorkbenchControlPlane()
      .subscribe(runId, parseCursor(request), request.signal)
      .pipeThrough(createRedactingTextStream());
    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return workbenchError(error);
  }
}
