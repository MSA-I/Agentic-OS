import {
  authorizeWorkbenchRead,
  validateRunId,
  workbenchError,
  workbenchJson,
} from "@/lib/workbench/http";
import { getDurableWorkbenchControlPlane } from "@/lib/workbench/durableControlPlane";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    authorizeWorkbenchRead(request);
    const { id } = await context.params;
    return workbenchJson(getDurableWorkbenchControlPlane().get(validateRunId(id)));
  } catch (error) {
    return workbenchError(error);
  }
}
