import { getWorkbenchAdapter } from "@/lib/workbench/adapters";
import {
  authorizeWorkbenchRead,
  validateRunId,
  workbenchError,
  workbenchJson,
} from "@/lib/workbench/http";
import {
  getRunSupervisor,
  WorkbenchNotFoundError,
  WorkbenchUnsupportedError,
} from "@/lib/workbench/supervisor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Native artifact read-through for one persisted Workbench run context. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    authorizeWorkbenchRead(request);
    const { id } = await context.params;
    const run = getRunSupervisor().get(validateRunId(id));
    if (!run) throw new WorkbenchNotFoundError("Run not found.");
    const adapter = getWorkbenchAdapter(run.adapterId);
    if (!adapter) throw new WorkbenchNotFoundError("Workbench adapter not found.");
    const result = await adapter.artifacts(run);
    if (!result.ok) {
      if (result.code === "unsupported") throw new WorkbenchUnsupportedError(result.message);
      if (result.code === "not_found") throw new WorkbenchNotFoundError(result.message);
      throw new Error(result.message);
    }
    return workbenchJson({ runId: run.id, artifacts: result.value, artifactCount: result.value.length });
  } catch (error) {
    return workbenchError(error);
  }
}
