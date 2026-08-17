import {
  authorizeWorkbenchMutation,
  authorizeWorkbenchRead,
  parseLimit,
  parseRunStatus,
  readWorkbenchJson,
  validateCreateRun,
  validateCommandIdentity,
  workbenchError,
  workbenchJson,
} from "@/lib/workbench/http";
import { getDurableWorkbenchControlPlane } from "@/lib/workbench/durableControlPlane";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    authorizeWorkbenchRead(request);
    const url = new URL(request.url);
    const controlPlane = getDurableWorkbenchControlPlane();
    const presentations = controlPlane.list({
      agentId: url.searchParams.get("agentId"),
      status: parseRunStatus(url.searchParams.get("status")),
      before: url.searchParams.get("before"),
      limit: parseLimit(url.searchParams.get("limit")),
    });
    return workbenchJson({
      runs: presentations.map((presentation) => presentation.run),
      runPresentations: presentations,
      agents: controlPlane.agents(),
    });
  } catch (error) {
    return workbenchError(error);
  }
}

export async function POST(request: Request) {
  try {
    const callerSessionId = authorizeWorkbenchMutation(request);
    const raw = await readWorkbenchJson(request);
    const body = validateCreateRun(raw);
    const identity = validateCommandIdentity(raw, callerSessionId);
    const result = await getDurableWorkbenchControlPlane().create(body, identity);
    return workbenchJson(result, { status: 201 });
  } catch (error) {
    return workbenchError(error);
  }
}
