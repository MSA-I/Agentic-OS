import {
  authorizeWorkbenchMutation,
  readWorkbenchJson,
  validateApprovalDecision,
  validateRunId,
  workbenchError,
  workbenchJson,
} from "@/lib/workbench/http";
import { getRunSupervisor } from "@/lib/workbench/supervisor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; approvalId: string }> },
) {
  try {
    authorizeWorkbenchMutation(request);
    const { id, approvalId } = await context.params;
    const decision = validateApprovalDecision(await readWorkbenchJson(request));
    const approval = await getRunSupervisor().decideApproval(
      validateRunId(id),
      validateRunId(approvalId),
      decision,
    );
    return workbenchJson({ approval, run: getRunSupervisor().get(id) });
  } catch (error) {
    return workbenchError(error);
  }
}
