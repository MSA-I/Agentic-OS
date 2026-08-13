import {
  authorizeWorkbenchRead,
  validateRunId,
  WorkbenchValidationError,
  workbenchError,
} from "@/lib/workbench/http";
import { getRunSupervisor } from "@/lib/workbench/supervisor";

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

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    authorizeWorkbenchRead(request);
    const { id } = await context.params;
    const stream = getRunSupervisor().subscribe(validateRunId(id), parseCursor(request), request.signal);
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
