import {
  authorizeWorkbenchMutation,
  readWorkbenchJson,
  validateMessage,
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
    const message = validateMessage(await readWorkbenchJson(request));
    const result = await getRunSupervisor().message(validateRunId(id), message.mode, message.content);
    return workbenchJson(result, { status: result.delivery === "queued" ? 202 : 200 });
  } catch (error) {
    return workbenchError(error);
  }
}
