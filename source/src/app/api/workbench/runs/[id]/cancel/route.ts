import {
  authorizeWorkbenchMutation,
  readWorkbenchJson,
  validateCommandIdentity,
  validateRunId,
  workbenchError,
  workbenchJson,
} from "@/lib/workbench/http";
import { getDurableWorkbenchControlPlane } from "@/lib/workbench/durableControlPlane";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const callerSessionId = authorizeWorkbenchMutation(request);
    const body = await readWorkbenchJson(request, 1024);
    const identity = validateCommandIdentity(body, callerSessionId);
    const { id } = await context.params;
    const result = getDurableWorkbenchControlPlane().cancel(validateRunId(id), identity);
    return workbenchJson(result, { status: result.stop.state === "stopping" ? 202 : 200 });
  } catch (error) {
    return workbenchError(error);
  }
}
