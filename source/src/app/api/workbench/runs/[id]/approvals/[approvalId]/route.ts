import {
  authorizeWorkbenchMutation,
  readWorkbenchJson,
  validateApprovalDecision,
  validateCommandIdentity,
  validateRunId,
  workbenchError,
} from "@/lib/workbench/http";
import { WorkbenchUnsupportedError } from "@/lib/workbench/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; approvalId: string }> },
) {
  try {
    const callerSessionId = authorizeWorkbenchMutation(request);
    const { id, approvalId } = await context.params;
    const body = await readWorkbenchJson(request);
    const decision = validateApprovalDecision(body);
    const identity = validateCommandIdentity(body, callerSessionId);
    validateRunId(id);
    validateRunId(approvalId);
    void decision;
    void identity;
    throw new WorkbenchUnsupportedError(
      "Interactive approvals remain disabled until the enforceable Tool Gateway is available in Wave 4.",
    );
  } catch (error) {
    return workbenchError(error);
  }
}
