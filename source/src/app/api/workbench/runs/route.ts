import {
  authorizeWorkbenchMutation,
  authorizeWorkbenchRead,
  parseLimit,
  parseRunStatus,
  readWorkbenchJson,
  validateCreateRun,
  workbenchError,
  workbenchJson,
} from "@/lib/workbench/http";
import { getRunSupervisor } from "@/lib/workbench/supervisor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    authorizeWorkbenchRead(request);
    const url = new URL(request.url);
    const supervisor = getRunSupervisor();
    return workbenchJson({
      runs: supervisor.list({
        agentId: url.searchParams.get("agentId"),
        status: parseRunStatus(url.searchParams.get("status")),
        before: url.searchParams.get("before"),
        limit: parseLimit(url.searchParams.get("limit")),
      }),
      agents: supervisor.agents(),
    });
  } catch (error) {
    return workbenchError(error);
  }
}

export async function POST(request: Request) {
  try {
    authorizeWorkbenchMutation(request);
    const body = validateCreateRun(await readWorkbenchJson(request));
    const result = await getRunSupervisor().create(body);
    return workbenchJson(result, { status: 201 });
  } catch (error) {
    return workbenchError(error);
  }
}
