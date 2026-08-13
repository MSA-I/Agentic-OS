import {
  authorizeWorkbenchMutation,
  validateRunId,
  workbenchError,
  workbenchJson,
} from "@/lib/workbench/http";
import { getRunSupervisor } from "@/lib/workbench/supervisor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    authorizeWorkbenchMutation(request);
    const { id } = await context.params;
    const run = await getRunSupervisor().cancel(validateRunId(id));
    return workbenchJson({ run });
  } catch (error) {
    return workbenchError(error);
  }
}
