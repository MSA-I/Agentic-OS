import {
  authorizeWorkbenchRead,
  validateRunId,
  workbenchError,
  workbenchJson,
} from "@/lib/workbench/http";
import { getRunSupervisor, WorkbenchNotFoundError } from "@/lib/workbench/supervisor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    authorizeWorkbenchRead(request);
    const { id } = await context.params;
    const run = getRunSupervisor().get(validateRunId(id));
    if (!run) throw new WorkbenchNotFoundError("Run not found.");
    return workbenchJson({ run });
  } catch (error) {
    return workbenchError(error);
  }
}
