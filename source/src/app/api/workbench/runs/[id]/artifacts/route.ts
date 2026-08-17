import { getWorkbenchAdapter } from "@/lib/workbench/adapters";
import {
  authorizeWorkbenchRead,
  validateRunId,
  workbenchError,
  workbenchJson,
} from "@/lib/workbench/http";
import {
  WorkbenchNotFoundError,
  WorkbenchUnsupportedError,
} from "@/lib/workbench/errors";
import { getDurableWorkbenchControlPlane } from "@/lib/workbench/durableControlPlane";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Native artifact read-through for one persisted Workbench run context. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    authorizeWorkbenchRead(request);
    const { id } = await context.params;
    const run = getDurableWorkbenchControlPlane().get(validateRunId(id)).run;
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
