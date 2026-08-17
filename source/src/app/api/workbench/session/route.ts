import {
  appendWorkbenchSessionCookies,
  createWorkbenchSession,
  rotateWorkbenchSession,
  validateWorkbenchBootstrapSecret,
  WORKBENCH_BOOTSTRAP_HEADER,
  workbenchSessionBinding,
  WorkbenchSessionError,
} from "@/lib/control-plane/session";
import {
  authorizeWorkbenchBootstrap,
  authorizeWorkbenchRead,
  readWorkbenchJson,
  WorkbenchValidationError,
  workbenchError,
  workbenchJson,
} from "@/lib/workbench/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function asValidationError(error: unknown): unknown {
  if (error instanceof WorkbenchSessionError) {
    return new WorkbenchValidationError(error.message, error.status);
  }
  return error;
}

const binding = workbenchSessionBinding;

function sessionResponse(issue: ReturnType<typeof createWorkbenchSession>, secure: boolean): Response {
  return appendWorkbenchSessionCookies(
    workbenchJson({
      session: {
        expiresAt: issue.expiresAt,
        mutationTokenReady: true,
      },
    }),
    issue,
    secure,
  );
}

/** Launcher/server-only bootstrap. The bootstrap secret is never returned. */
export async function POST(request: Request) {
  try {
    const origin = authorizeWorkbenchBootstrap(request);
    validateWorkbenchBootstrapSecret(request.headers.get(WORKBENCH_BOOTSTRAP_HEADER));
    await readWorkbenchJson(request, 1024);
    return sessionResponse(
      createWorkbenchSession(binding(origin)),
      origin.protocol === "https:",
    );
  } catch (error) {
    return workbenchError(asValidationError(error));
  }
}

/** Rotate both the HttpOnly session token and the next one-shot mutation token. */
export async function GET(request: Request) {
  try {
    const origin = authorizeWorkbenchRead(request);
    const issue = rotateWorkbenchSession(request.headers.get("cookie"), binding(origin));
    return sessionResponse(issue, origin.protocol === "https:");
  } catch (error) {
    return workbenchError(asValidationError(error));
  }
}
