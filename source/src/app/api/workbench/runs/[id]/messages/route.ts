import {
  authorizeWorkbenchMutation,
  readWorkbenchJson,
  validateMessage,
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
    const { id } = await context.params;
    const body = await readWorkbenchJson(request);
    const message = validateMessage(body);
    const identity = validateCommandIdentity(body, callerSessionId);
    const result = getDurableWorkbenchControlPlane().message(
      validateRunId(id),
      message.mode,
      message.content,
      identity,
    );
    return workbenchJson(result, { status: 202 });
  } catch (error) {
    return workbenchError(error);
  }
}
