import {
  appendWorkbenchSessionCookies,
  createWorkbenchSession,
  validateWorkbenchBootstrapSecret,
  workbenchSessionBinding,
  WorkbenchSessionError,
} from "@/lib/control-plane/session";
import {
  authorizeWorkbenchRead,
  WorkbenchValidationError,
  workbenchError,
} from "@/lib/workbench/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The launcher-owned browser bootstrap channel. `POST /api/workbench/session`
 * cannot be used from a page, because injecting the bootstrap secret into page
 * JavaScript would expose it. Instead the launcher generates the secret, passes
 * it to this server through the environment, and opens exactly one navigation
 * carrying the same value. This handler exchanges that one navigation for the
 * HttpOnly session and mutation cookies and then redirects, so the token leaves
 * the address bar and never reaches page JavaScript.
 */
export async function GET(request: Request) {
  try {
    const origin = authorizeWorkbenchRead(request);
    const requestUrl = new URL(request.url);
    validateWorkbenchBootstrapSecret(requestUrl.searchParams.get("token"));

    const requestedNext = requestUrl.searchParams.get("next") ?? "/";
    const next = /^\/(?![/\\])[^\s?#]*$/u.test(requestedNext) ? requestedNext : "/";

    const issue = createWorkbenchSession(workbenchSessionBinding(origin));
    return appendWorkbenchSessionCookies(
      new Response(null, {
        status: 303,
        headers: {
          Location: next,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      }),
      issue,
      origin.protocol === "https:",
    );
  } catch (error) {
    return workbenchError(
      error instanceof WorkbenchSessionError
        ? new WorkbenchValidationError(error.message, error.status)
        : error,
    );
  }
}
